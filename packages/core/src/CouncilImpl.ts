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
  ResolvedCouncilPromptConfig,
  AgentSyncResult,
  SyncAgentsInput,
} from './types.js';
import { createCouncilConfigSnapshot } from './config.js';
import { generateId } from './utils.js';
import {
  areAgentDefinitionsEqual,
  createAgentRosterMap,
  snapshotAgentDefinition,
  snapshotAgentDefinitions,
} from './agents.js';
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
  private promptConfig: ResolvedCouncilPromptConfig;
  private agents: Map<string, AgentDefinition>;
  private engines: Map<string, EngineAdapter>;
  private toolHost?: ToolHost;

  constructor(
    councilId: string,
    initialMode: CouncilMode,
    runtimeConfig: CouncilRuntimeConfig,
    promptConfig: ResolvedCouncilPromptConfig,
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
      agentSelectionStrategy: runtimeConfig.agentSelectionStrategy,
      oracleSpeakerStrategy: runtimeConfig.oracleSpeakerStrategy,
      oracleSpeakerAgentId: runtimeConfig.oracleSpeakerAgentId,
    };
    this.promptConfig = {
      councilModeSystemAddendum: promptConfig.councilModeSystemAddendum,
      oracleModeSystemAddendum: promptConfig.oracleModeSystemAddendum,
      councilSynthesisTemplate: promptConfig.councilSynthesisTemplate,
      oracleSynthesisTemplate: promptConfig.oracleSynthesisTemplate,
    };
    this.agents = createAgentRosterMap(agents, 'agents');
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
      prompts: this.promptConfig,
      metadata: this.state.metadata,
    });
  }

  listAgents(): AgentDefinition[] {
    this.ensureNotDisposed();
    return snapshotAgentDefinitions(this.agents.values());
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
          case 'agent.added':
          case 'agent.updated':
            this.agents.set(record.agentId, snapshotAgentDefinition(record.agent));
            break;

          case 'agent.removed':
            this.agents.delete(record.agentId);
            break;

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

  async syncAgents(input: SyncAgentsInput): Promise<AgentSyncResult> {
    this.ensureNotDisposed();

    const nextRoster = createAgentRosterMap(input.agents, 'input.agents');
    const currentIds = Array.from(this.agents.keys());
    const nextRosterIds = Array.from(nextRoster.keys());
    const nextAgents = new Map<string, AgentDefinition>();
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];
    const records: CouncilRecord[] = [];

    for (const agentId of currentIds) {
      const currentAgent = this.agents.get(agentId);
      const nextAgent = nextRoster.get(agentId);
      if (!currentAgent || !nextAgent) {
        continue;
      }

      nextAgents.set(agentId, nextAgent);
      if (!areAgentDefinitionsEqual(currentAgent, nextAgent)) {
        updated.push(agentId);
        records.push(
          this.createAgentRosterRecord('agent.updated', agentId, nextAgent, input.reason)
        );
      }
    }

    for (const agentId of nextRosterIds) {
      if (this.agents.has(agentId)) {
        continue;
      }

      const agent = nextRoster.get(agentId);
      if (!agent) {
        continue;
      }

      added.push(agentId);
      nextAgents.set(agentId, agent);
      records.push(
        this.createAgentRosterRecord('agent.added', agentId, agent, input.reason)
      );
    }

    for (const agentId of currentIds) {
      if (nextRoster.has(agentId)) {
        continue;
      }

      removed.push(agentId);
      records.push(this.createAgentRemovedRecord(agentId, input.reason));
    }

    this.agents = nextAgents;

    return {
      added,
      updated,
      removed,
      records,
    };
  }

  async post(event: ChatEvent, options?: TurnOptions): Promise<TurnResult> {
    this.ensureNotDisposed();

    const turnId = generateId();
    const mode = options?.mode ?? this.state.mode;
    const records: CouncilRecord[] = [];
    const publicMessages: CouncilMessage[] = [];
    const privateMessages: CouncilMessage[] = [];
    const errors: TurnError[] = [];
    const activeAgentSelection = this.selectAgents(options);

    if (activeAgentSelection.error) {
      this.recordTurnError(
        turnId,
        records,
        errors,
        activeAgentSelection.error
      );
      records.push(this.createTurnCompletedRecord(turnId, mode));
      return {
        turnId,
        mode,
        nextMode: this.state.mode,
        publicMessages,
        privateMessages,
        records,
        errors: errors.map((entry) => this.snapshotTurnError(entry)),
      };
    }

    const activeAgents = activeAgentSelection.agents;
    const oracleSpeakerSelection =
      mode === 'oracle'
        ? this.resolveOracleSpeaker(activeAgents, options)
        : { agent: undefined, error: undefined };
    const workflowDeps = this.createWorkflowDependencies();

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
            oracleSpeaker: oracleSpeakerSelection.agent,
            oracleSpeakerError: oracleSpeakerSelection.error,
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
    records.push(this.createTurnCompletedRecord(turnId, mode));

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

    const activeAgentSelection = this.selectAgents(options);
    if (activeAgentSelection.error) {
      yield {
        type: 'error',
        councilId: this.state.councilId,
        turnId,
        timestamp: new Date().toISOString(),
        error: {
          ...activeAgentSelection.error,
          data:
            activeAgentSelection.error.data === undefined
              ? undefined
              : structuredClone(activeAgentSelection.error.data),
        },
      };
      yield {
        type: 'turn.completed',
        councilId: this.state.councilId,
        turnId,
        timestamp: new Date().toISOString(),
        mode,
      };
      return;
    }

    const activeAgents = activeAgentSelection.agents;
    const oracleSpeakerSelection =
      mode === 'oracle'
        ? this.resolveOracleSpeaker(activeAgents, options)
        : { agent: undefined, error: undefined };
    const workflowDeps = this.createWorkflowDependencies();

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
            oracleSpeaker: oracleSpeakerSelection.agent,
            oracleSpeakerError: oracleSpeakerSelection.error,
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
      prompts: this.promptConfig,
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

  private createTurnCompletedRecord(
    turnId: string,
    mode: CouncilMode
  ): Extract<CouncilRecord, { type: 'turn.completed' }> {
    return {
      contractVersion: COUNCIL_CONTRACT_VERSION,
      type: 'turn.completed',
      councilId: this.state.councilId,
      turnId,
      timestamp: new Date().toISOString(),
      mode,
    };
  }

  private createAgentRosterRecord(
    type: 'agent.added' | 'agent.updated',
    agentId: string,
    agent: AgentDefinition,
    reason?: string
  ): Extract<CouncilRecord, { type: 'agent.added' | 'agent.updated' }> {
    return {
      contractVersion: COUNCIL_CONTRACT_VERSION,
      type,
      councilId: this.state.councilId,
      timestamp: new Date().toISOString(),
      agentId,
      agent: snapshotAgentDefinition(agent),
      reason,
    };
  }

  private createAgentRemovedRecord(
    agentId: string,
    reason?: string
  ): Extract<CouncilRecord, { type: 'agent.removed' }> {
    return {
      contractVersion: COUNCIL_CONTRACT_VERSION,
      type: 'agent.removed',
      councilId: this.state.councilId,
      timestamp: new Date().toISOString(),
      agentId,
      reason,
    };
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
        promptConfig: this.promptConfig,
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
        promptConfig: this.promptConfig,
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

  private selectAgents(options: TurnOptions | undefined): {
    agents: AgentDefinition[];
    error?: CouncilError;
  } {
    const maxAgents = Math.max(
      0,
      options?.maxAgentReplies ??
        this.runtimeConfig.maxAgentReplies ??
        this.agents.size
    );

    if (options?.activeAgentIds) {
      const selectedAgents: AgentDefinition[] = [];
      const seenAgentIds = new Set<string>();
      const duplicateAgentIds: string[] = [];
      const unknownAgentIds: string[] = [];

      for (const agentId of options.activeAgentIds) {
        if (seenAgentIds.has(agentId)) {
          duplicateAgentIds.push(agentId);
          continue;
        }

        seenAgentIds.add(agentId);

        const agent = this.agents.get(agentId);
        if (!agent) {
          unknownAgentIds.push(agentId);
          continue;
        }

        selectedAgents.push(agent);
      }

      if (duplicateAgentIds.length > 0 || unknownAgentIds.length > 0) {
        return {
          agents: [],
          error: {
            code: 'invalid_active_agent_ids',
            message: 'activeAgentIds must reference unique known agents',
            data: {
              requestedAgentIds: [...options.activeAgentIds],
              duplicateAgentIds,
              unknownAgentIds,
              availableAgentIds: Array.from(this.agents.keys()),
            },
          },
        };
      }

      return {
        agents: selectedAgents.slice(0, maxAgents),
      };
    }

    switch (this.runtimeConfig.agentSelectionStrategy) {
      case 'all_in_order':
      default:
        return {
          agents: Array.from(this.agents.values()).slice(0, maxAgents),
        };
    }
  }

  private resolveOracleSpeaker(
    activeAgents: AgentDefinition[],
    options: TurnOptions | undefined
  ): {
    agent?: AgentDefinition;
    error?: CouncilError;
  } {
    if (activeAgents.length === 0) {
      return {};
    }

    const requestedAgentId =
      options?.oracleSpeakerAgentId ??
      (this.runtimeConfig.oracleSpeakerStrategy === 'by_id'
        ? this.runtimeConfig.oracleSpeakerAgentId
        : undefined);

    if (!requestedAgentId) {
      return {
        agent: activeAgents[0],
      };
    }

    const agent = activeAgents.find((entry) => entry.id === requestedAgentId);
    if (agent) {
      return { agent };
    }

    return {
      error: {
        code: 'oracle_speaker_unavailable',
        message: `Oracle speaker agent ${requestedAgentId} is not active for this turn`,
        data: {
          requestedAgentId,
          activeAgentIds: activeAgents.map((entry) => entry.id),
        },
      },
    };
  }
}
