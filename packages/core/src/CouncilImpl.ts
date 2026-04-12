import {
  Council,
  CouncilInstanceResolvedConfig,
  CouncilMode,
  CouncilMessage,
  CouncilRecord,
  CouncilReplayEntry,
  ChatEvent,
  TurnResult,
  TurnOptions,
  CouncilRuntimeEvent,
  AgentDefinition,
  EngineAdapter,
  ToolHost,
  ToolCall,
  ToolResult,
  ToolDefinition,
  EngineInput,
  EngineOutput,
  CouncilError,
  TurnError,
  COUNCIL_CONTRACT_VERSION,
  CouncilRuntimeConfig,
} from './types.js';
import { createCouncilConfigSnapshot } from './config.js';
import { generateId } from './utils.js';
import { executeOpenWorkflow, streamOpenWorkflow } from './workflows/open.js';
import {
  executeCouncilWorkflow,
  streamCouncilWorkflow,
} from './workflows/council.js';
import {
  executeOracleWorkflow,
  streamOracleWorkflow,
} from './workflows/oracle.js';
import type { WorkflowDependencies } from './workflows/shared.js';

interface CouncilState {
  councilId: string;
  initialMode: CouncilMode;
  mode: CouncilMode;
  messages: CouncilMessage[];
  metadata?: Record<string, unknown>;
  disposed: boolean;
}

export class CouncilImpl implements Council {
  private state: CouncilState;
  private runtimeConfig: CouncilRuntimeConfig;
  private agents: Map<string, AgentDefinition>;
  private engines: Map<string, EngineAdapter>;
  private toolHost?: ToolHost;

  constructor(
    councilId: string,
    initialMode: CouncilMode,
    runtimeConfig: CouncilRuntimeConfig,
    agents: AgentDefinition[],
    engines: Record<string, EngineAdapter>,
    toolHost?: ToolHost,
    metadata?: Record<string, unknown>
  ) {
    this.state = {
      councilId,
      initialMode,
      mode: initialMode,
      messages: [],
      metadata,
      disposed: false,
    };

    this.runtimeConfig = {
      initialMode: runtimeConfig.initialMode,
      maxRounds: runtimeConfig.maxRounds,
      maxAgentReplies: runtimeConfig.maxAgentReplies,
    };
    this.agents = new Map(agents.map((a) => [a.id, a]));
    this.engines = new Map(Object.entries(engines));
    this.toolHost = toolHost;
  }

  getMode(): CouncilMode {
    return this.state.mode;
  }

  getConfig(): CouncilInstanceResolvedConfig {
    return createCouncilConfigSnapshot({
      councilId: this.state.councilId,
      initialMode: this.state.initialMode,
      runtime: this.runtimeConfig,
      metadata: this.state.metadata,
    });
  }

  async replay(
    entries: Iterable<CouncilReplayEntry> | AsyncIterable<CouncilReplayEntry>
  ): Promise<void> {
    this.ensureNotDisposed();

    // Replay is pure state reconstruction - no LLM calls, no tool execution
    for await (const entry of entries) {
      if (entry.type === 'host.chat') {
        // Host chat events are informational during replay
        // We don't process them, just acknowledge their existence
        continue;
      } else if (entry.type === 'council.record') {
        const record = entry.record;

        switch (record.type) {
          case 'mode.changed':
            this.state.mode = record.to;
            break;

          case 'message.emitted':
            this.state.messages.push(this.snapshotMessage(record.message));
            break;

          case 'tool.called':
          case 'tool.result':
          case 'error':
            // Tool records are acknowledged but don't change visible state
            // during replay - they're part of the audit trail
            break;

          case 'turn.completed':
            // Mark that a turn completed - no state change needed
            break;
        }
      }
    }
  }

  async post(event: ChatEvent, options?: TurnOptions): Promise<TurnResult> {
    this.ensureNotDisposed();

    const turnId = generateId();
    const mode = options?.mode ?? this.state.mode;
    const activeAgents = this.selectAgents(options);
    const workflowDeps = this.createWorkflowDependencies();
    const records: CouncilRecord[] = [];
    const publicMessages: CouncilMessage[] = [];
    const privateMessages: CouncilMessage[] = [];
    const errors: TurnError[] = [];

    // Change mode if requested
    if (mode !== this.state.mode) {
      const modeRecord: CouncilRecord = {
        contractVersion: COUNCIL_CONTRACT_VERSION,
        type: 'mode.changed',
        councilId: this.state.councilId,
        turnId,
        timestamp: new Date().toISOString(),
        from: this.state.mode,
        to: mode,
      };
      records.push(modeRecord);
      this.state.mode = mode;
    }

    // Execute turn based on mode
    switch (mode) {
      case 'open':
        await executeOpenWorkflow(
          {
            councilId: this.state.councilId,
            turnId,
            event,
            options,
            activeAgents,
            stateMessages: this.state.messages,
            publicMessages,
            privateMessages,
            records,
            errors,
          },
          workflowDeps
        );
        break;

      case 'council':
        await executeCouncilWorkflow(
          {
            councilId: this.state.councilId,
            turnId,
            event,
            options,
            activeAgents,
            stateMessages: this.state.messages,
            publicMessages,
            privateMessages,
            records,
            errors,
          },
          workflowDeps
        );
        break;

      case 'oracle':
        await executeOracleWorkflow(
          {
            councilId: this.state.councilId,
            turnId,
            event,
            options,
            activeAgents,
            stateMessages: this.state.messages,
            publicMessages,
            privateMessages,
            records,
            errors,
          },
          workflowDeps
        );
        break;
    }

    // Emit turn.completed record
    const completedRecord: CouncilRecord = {
      contractVersion: COUNCIL_CONTRACT_VERSION,
      type: 'turn.completed',
      councilId: this.state.councilId,
      turnId,
      timestamp: new Date().toISOString(),
      mode,
    };
    records.push(completedRecord);

    // Commit messages in durable record order so post(), replay(), and stream()
    // converge on the same state.
    this.state.messages.push(...this.collectCommittedMessages(records));

    return {
      turnId,
      mode,
      nextMode: this.state.mode,
      publicMessages: publicMessages.map((message) => this.snapshotMessage(message)),
      privateMessages: privateMessages.map((message) => this.snapshotMessage(message)),
      records,
      errors: errors.map((entry) => this.snapshotTurnError(entry)),
    };
  }

  async *stream(
    event: ChatEvent,
    options?: TurnOptions
  ): AsyncIterable<CouncilRuntimeEvent> {
    this.ensureNotDisposed();

    const turnId = generateId();
    const mode = options?.mode ?? this.state.mode;
    const activeAgents = this.selectAgents(options);
    const workflowDeps = this.createWorkflowDependencies();

    // Buffer for messages emitted this turn - committed to state after turn completes
    const pendingMessages: CouncilMessage[] = [];

    // Emit turn.started
    yield {
      type: 'turn.started',
      councilId: this.state.councilId,
      turnId,
      timestamp: new Date().toISOString(),
      mode,
    };

    // Emit mode.changed if needed
    if (mode !== this.state.mode) {
      yield {
        type: 'mode.changed',
        councilId: this.state.councilId,
        turnId,
        timestamp: new Date().toISOString(),
        from: this.state.mode,
        to: mode,
      };
      this.state.mode = mode;
    }

    // Stream turn execution based on mode
    switch (mode) {
      case 'open':
        yield* streamOpenWorkflow(
          {
            councilId: this.state.councilId,
            turnId,
            event,
            options,
            activeAgents,
            stateMessages: this.state.messages,
            pendingMessages,
          },
          workflowDeps
        );
        break;

      case 'council':
        yield* streamCouncilWorkflow(
          {
            councilId: this.state.councilId,
            turnId,
            event,
            options,
            activeAgents,
            stateMessages: this.state.messages,
            pendingMessages,
          },
          workflowDeps
        );
        break;

      case 'oracle':
        yield* streamOracleWorkflow(
          {
            councilId: this.state.councilId,
            turnId,
            event,
            options,
            activeAgents,
            stateMessages: this.state.messages,
            pendingMessages,
          },
          workflowDeps
        );
        break;
    }

    // Commit all messages to state only after turn fully completes.
    this.state.messages.push(
      ...pendingMessages.map((message) => this.snapshotMessage(message))
    );

    // Emit turn.completed
    yield {
      type: 'turn.completed',
      councilId: this.state.councilId,
      turnId,
      timestamp: new Date().toISOString(),
      mode,
    };
  }

  async getMessages(options?: {
    visibility?: 'public' | 'private' | 'all';
    limit?: number;
  }): Promise<CouncilMessage[]> {
    this.ensureNotDisposed();

    const visibility = options?.visibility ?? 'all';
    const limit = options?.limit;

    let filtered = this.state.messages;

    if (visibility !== 'all') {
      filtered = filtered.filter((m) => m.visibility === visibility);
    }

    if (limit !== undefined && limit > 0) {
      filtered = filtered.slice(-limit);
    }

    return filtered.map((message) => this.snapshotMessage(message));
  }

  async getStatus(): Promise<unknown> {
    this.ensureNotDisposed();

    // Unstable diagnostic payload
    return {
      councilId: this.state.councilId,
      mode: this.state.mode,
      messageCount: this.state.messages.length,
      publicMessageCount: this.state.messages.filter(
        (m) => m.visibility === 'public'
      ).length,
      privateMessageCount: this.state.messages.filter(
        (m) => m.visibility === 'private'
      ).length,
      agentCount: this.agents.size,
      agents: Array.from(this.agents.values()).map((a) => ({
        id: a.id,
        name: a.name,
        engine: a.engine.id,
      })),
      config: this.getConfig(),
      metadata:
        this.state.metadata === undefined
          ? undefined
          : structuredClone(this.state.metadata),
    };
  }

  async dispose(): Promise<void> {
    this.state.disposed = true;
    this.state.messages = [];
    this.agents.clear();
    this.engines.clear();
  }

  private ensureNotDisposed(): void {
    if (this.state.disposed) {
      throw new Error('Council has been disposed');
    }
  }

  private createWorkflowDependencies(): WorkflowDependencies {
    return {
      generateWithTools: (
        turnId,
        agent,
        mode,
        event,
        history,
        options,
        records,
        errors
      ) =>
        this.generateWithTools(
          turnId,
          agent,
          mode,
          event,
          history,
          options,
          records,
          errors
        ),
      generateWithToolsStream: (
        turnId,
        agent,
        mode,
        event,
        history,
        options
      ) =>
        this.generateWithToolsStream(
          turnId,
          agent,
          mode,
          event,
          history,
          options
        ),
      recordTurnError: (turnId, records, errors, error, agentId) =>
        this.recordTurnError(turnId, records, errors, error, agentId),
    };
  }

  // Tooling helpers

  private snapshotMessage(message: CouncilMessage): CouncilMessage {
    return {
      ...message,
      author: { ...message.author },
      metadata:
        message.metadata === undefined ? undefined : structuredClone(message.metadata),
    };
  }

  private snapshotTurnError(entry: TurnError): TurnError {
    return {
      agentId: entry.agentId,
      error: {
        ...entry.error,
        data:
          entry.error.data === undefined
            ? undefined
            : structuredClone(entry.error.data),
      },
    };
  }

  private collectCommittedMessages(records: CouncilRecord[]): CouncilMessage[] {
    return records
      .filter((record): record is Extract<CouncilRecord, { type: 'message.emitted' }> => {
        return record.type === 'message.emitted';
      })
      .map((record) => this.snapshotMessage(record.message));
  }

  private recordTurnError(
    turnId: string,
    records: CouncilRecord[],
    errors: TurnError[],
    error: CouncilError,
    agentId?: string
  ): void {
    const snapshot: CouncilError = {
      ...error,
      data: error.data === undefined ? undefined : structuredClone(error.data),
    };

    records.push({
      contractVersion: COUNCIL_CONTRACT_VERSION,
      type: 'error',
      councilId: this.state.councilId,
      turnId,
      timestamp: new Date().toISOString(),
      agentId,
      error: snapshot,
    });

    errors.push({
      agentId,
      error: snapshot,
    });
  }

  private getToolDefinitions(agent: AgentDefinition): ToolDefinition[] {
    const tools = agent.tools ?? [];
    return tools
      .map((tool) => (typeof tool === 'string' ? { name: tool } : tool))
      .filter((tool) => typeof tool.name === 'string' && tool.name.trim().length > 0);
  }

  private extractToolCalls(output: EngineOutput): ToolCall[] {
    const direct = Array.isArray(output.toolCalls) ? output.toolCalls : [];
    if (direct.length > 0) {
      return this.normalizeToolCalls(direct);
    }

    const metadata = output.metadata as Record<string, unknown> | undefined;
    const candidate =
      (metadata as { toolCalls?: unknown })?.toolCalls ??
      (metadata as { tool_calls?: unknown })?.tool_calls;

    return this.normalizeToolCalls(candidate);
  }

  private normalizeToolCalls(raw: unknown): ToolCall[] {
    if (!Array.isArray(raw)) return [];

    const normalized: ToolCall[] = [];
    for (const entry of raw) {
      const toolCall = this.normalizeToolCall(entry);
      if (toolCall) normalized.push(toolCall);
    }
    return normalized;
  }

  private normalizeToolCall(raw: unknown): ToolCall | null {
    if (!raw || typeof raw !== 'object') return null;

    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : undefined;

    if (typeof record.name === 'string') {
      const args = this.normalizeToolArgs(record.args ?? record.arguments);
      return {
        id,
        name: record.name,
        args,
      };
    }

    const fn = record.function as Record<string, unknown> | undefined;
    if (fn && typeof fn.name === 'string') {
      const args = this.normalizeToolArgs(fn.arguments);
      return {
        id,
        name: fn.name,
        args,
      };
    }

    return null;
  }

  private normalizeToolArgs(args: unknown): Record<string, unknown> | undefined {
    if (!args) return undefined;
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        return undefined;
      }
      return undefined;
    }

    if (typeof args === 'object') {
      return args as Record<string, unknown>;
    }

    return undefined;
  }

  private async executeToolCalls(
    turnId: string,
    agent: AgentDefinition,
    toolCalls: ToolCall[],
    records: CouncilRecord[],
    allowedToolNames: Set<string>,
    overrideError?: string
  ): Promise<{ calls: ToolCall[]; results: ToolResult[] }> {
    const calls: ToolCall[] = [];
    const results: ToolResult[] = [];

    for (const call of toolCalls) {
      const callId = call.id ?? generateId();
      const normalizedCall: ToolCall = {
        ...call,
        id: callId,
      };

      calls.push(normalizedCall);

      const calledRecord: CouncilRecord = {
        contractVersion: COUNCIL_CONTRACT_VERSION,
        type: 'tool.called',
        councilId: this.state.councilId,
        turnId,
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        callId,
        call: normalizedCall,
      };
      records.push(calledRecord);

      let result: ToolResult;
      if (overrideError) {
        result = {
          ok: false,
          error: overrideError,
        };
      } else if (!allowedToolNames.has(normalizedCall.name)) {
        result = {
          ok: false,
          error: `Tool not allowed: ${normalizedCall.name}`,
        };
      } else if (!this.toolHost) {
        result = {
          ok: false,
          error: 'ToolHost not configured',
        };
      } else {
        try {
          result = await this.toolHost.execute(normalizedCall, {
            councilId: this.state.councilId,
            turnId,
            agentId: agent.id,
          });
        } catch (error) {
          result = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const resultWithId: ToolResult = {
        ...result,
        callId,
      };

      const resultRecord: CouncilRecord = {
        contractVersion: COUNCIL_CONTRACT_VERSION,
        type: 'tool.result',
        councilId: this.state.councilId,
        turnId,
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        callId,
        result: resultWithId,
      };
      records.push(resultRecord);

      results.push(resultWithId);
    }

    return { calls, results };
  }

  private async generateWithTools(
    turnId: string,
    agent: AgentDefinition,
    mode: CouncilMode,
    event: ChatEvent,
    history: CouncilMessage[],
    options: TurnOptions | undefined,
    records: CouncilRecord[],
    errors: TurnError[]
  ): Promise<EngineOutput | null> {
    const engine = this.engines.get(agent.engine.id);
    if (!engine) {
      throw new Error(`Engine ${agent.engine.id} not found`);
    }

    const toolDefinitions = this.getToolDefinitions(agent);
    const allowedToolNames = new Set(toolDefinitions.map((tool) => tool.name));

    const maxToolRounds = Math.max(
      0,
      options?.maxRounds ?? this.runtimeConfig.maxRounds
    );
    let toolRounds = 0;

    const toolCallsHistory: ToolCall[] = [];
    const toolResultsHistory: ToolResult[] = [];

    while (true) {
      const input: EngineInput = {
        councilId: this.state.councilId,
        turnId,
        agent,
        mode,
        event,
        history,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        toolCalls: toolCallsHistory.length > 0 ? toolCallsHistory : undefined,
        toolResults: toolResultsHistory.length > 0 ? toolResultsHistory : undefined,
      };

      const output = await engine.generate(input);
      const toolCalls = this.extractToolCalls(output);

      if (toolCalls.length === 0) {
        return output;
      }

      if (toolRounds >= maxToolRounds) {
        const { calls, results } = await this.executeToolCalls(
          turnId,
          agent,
          toolCalls,
          records,
          allowedToolNames,
          `Tool round limit (${maxToolRounds}) reached`
        );

        toolCallsHistory.push(...calls);
        toolResultsHistory.push(...results);

        this.recordTurnError(
          turnId,
          records,
          errors,
          {
            code: 'tool_round_limit',
            message: `Max tool rounds (${maxToolRounds}) reached for agent ${agent.id}`,
          },
          agent.id
        );
        return null;
      }

      toolRounds += 1;

      const { calls, results } = await this.executeToolCalls(
        turnId,
        agent,
        toolCalls,
        records,
        allowedToolNames
      );

      toolCallsHistory.push(...calls);
      toolResultsHistory.push(...results);
    }
  }

  private async *generateWithToolsStream(
    turnId: string,
    agent: AgentDefinition,
    mode: CouncilMode,
    event: ChatEvent,
    history: CouncilMessage[],
    options: TurnOptions | undefined
  ): AsyncGenerator<CouncilRuntimeEvent, EngineOutput | null, void> {
    const engine = this.engines.get(agent.engine.id);
    if (!engine) {
      throw new Error(`Engine ${agent.engine.id} not found`);
    }

    const toolDefinitions = this.getToolDefinitions(agent);
    const allowedToolNames = new Set(toolDefinitions.map((tool) => tool.name));

    const maxToolRounds = Math.max(
      0,
      options?.maxRounds ?? this.runtimeConfig.maxRounds
    );
    let toolRounds = 0;

    const toolCallsHistory: ToolCall[] = [];
    const toolResultsHistory: ToolResult[] = [];

    while (true) {
      const input: EngineInput = {
        councilId: this.state.councilId,
        turnId,
        agent,
        mode,
        event,
        history,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        toolCalls: toolCallsHistory.length > 0 ? toolCallsHistory : undefined,
        toolResults: toolResultsHistory.length > 0 ? toolResultsHistory : undefined,
      };

      const output = await engine.generate(input);
      const toolCalls = this.extractToolCalls(output);

      if (toolCalls.length === 0) {
        return output;
      }

      if (toolRounds >= maxToolRounds) {
        for (const call of toolCalls) {
          const callId = call.id ?? generateId();
          const normalizedCall: ToolCall = {
            ...call,
            id: callId,
          };

          yield {
            type: 'tool.called',
            councilId: this.state.councilId,
            turnId,
            agentId: agent.id,
            timestamp: new Date().toISOString(),
            callId,
            call: normalizedCall,
          };

          const resultWithId: ToolResult = {
            ok: false,
            error: `Tool round limit (${maxToolRounds}) reached`,
            callId,
          };

          yield {
            type: 'tool.result',
            councilId: this.state.councilId,
            turnId,
            agentId: agent.id,
            timestamp: new Date().toISOString(),
            callId,
            result: resultWithId,
          };

          toolCallsHistory.push(normalizedCall);
          toolResultsHistory.push(resultWithId);
        }

        yield {
          type: 'error',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
          error: {
            code: 'tool_round_limit',
            message: `Max tool rounds (${maxToolRounds}) reached for agent ${agent.id}`,
          },
        };
        return null;
      }

      toolRounds += 1;

      for (const call of toolCalls) {
        const callId = call.id ?? generateId();
        const normalizedCall: ToolCall = {
          ...call,
          id: callId,
        };

        yield {
          type: 'tool.called',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
          callId,
          call: normalizedCall,
        };

        let result: ToolResult;
        if (!allowedToolNames.has(normalizedCall.name)) {
          result = {
            ok: false,
            error: `Tool not allowed: ${normalizedCall.name}`,
          };
        } else if (!this.toolHost) {
          result = {
            ok: false,
            error: 'ToolHost not configured',
          };
        } else {
          try {
            result = await this.toolHost.execute(normalizedCall, {
              councilId: this.state.councilId,
              turnId,
              agentId: agent.id,
            });
          } catch (error) {
            result = {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        const resultWithId: ToolResult = {
          ...result,
          callId,
        };

        yield {
          type: 'tool.result',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
          callId,
          result: resultWithId,
        };

        toolCallsHistory.push(normalizedCall);
        toolResultsHistory.push(resultWithId);
      }
    }
  }

  private selectAgents(options: TurnOptions | undefined): AgentDefinition[] {
    // Simple agent selection: all agents participate
    // Future: implement relevance checking, @mentions, etc.
    const maxAgents =
      options?.maxAgentReplies ??
      this.runtimeConfig.maxAgentReplies ??
      this.agents.size;
    return Array.from(this.agents.values()).slice(0, maxAgents);
  }
}
