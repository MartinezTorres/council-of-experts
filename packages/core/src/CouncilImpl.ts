import {
  Council,
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
} from './types.js';
import { generateId } from './utils.js';

interface CouncilState {
  councilId: string;
  mode: CouncilMode;
  messages: CouncilMessage[];
  metadata?: Record<string, unknown>;
  disposed: boolean;
}

export class CouncilImpl implements Council {
  private state: CouncilState;
  private agents: Map<string, AgentDefinition>;
  private engines: Map<string, EngineAdapter>;
  private toolHost?: ToolHost;

  constructor(
    councilId: string,
    initialMode: CouncilMode,
    agents: AgentDefinition[],
    engines: Record<string, EngineAdapter>,
    toolHost?: ToolHost,
    metadata?: Record<string, unknown>
  ) {
    this.state = {
      councilId,
      mode: initialMode,
      messages: [],
      metadata,
      disposed: false,
    };

    this.agents = new Map(agents.map((a) => [a.id, a]));
    this.engines = new Map(Object.entries(engines));
    this.toolHost = toolHost;
  }

  getMode(): CouncilMode {
    return this.state.mode;
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
        await this.executeOpenMode(
          turnId,
          event,
          options,
          publicMessages,
          privateMessages,
          records,
          errors
        );
        break;

      case 'council':
        await this.executeCouncilMode(
          turnId,
          event,
          options,
          publicMessages,
          privateMessages,
          records,
          errors
        );
        break;

      case 'oracle':
        await this.executeOracleMode(
          turnId,
          event,
          options,
          publicMessages,
          privateMessages,
          records,
          errors
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
        yield* this.streamOpenMode(turnId, event, options, pendingMessages);
        break;

      case 'council':
        yield* this.streamCouncilMode(turnId, event, options, pendingMessages);
        break;

      case 'oracle':
        yield* this.streamOracleMode(turnId, event, options, pendingMessages);
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

    const maxToolRounds = Math.max(0, options?.maxRounds ?? 3);
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

    const maxToolRounds = Math.max(0, options?.maxRounds ?? 3);
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

  // Mode-specific execution methods

  private async executeOpenMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    publicMessages: CouncilMessage[],
    privateMessages: CouncilMessage[],
    records: CouncilRecord[],
    errors: TurnError[]
  ): Promise<void> {
    // In open mode, agents may speak independently in public
    // Simple parallel execution - each agent that wants to respond does so publicly

    const activeAgents = this.selectAgents(event, options);

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        try {
          const history = this.state.messages.filter(
            (m) => m.visibility === 'public'
          );
          const output = await this.generateWithTools(
            turnId,
            agent,
            'open',
            event,
            history,
            options,
            records,
            errors
          );

          if (output && output.content.trim()) {
            const message: CouncilMessage = {
              id: generateId(),
              turnId,
              author: {
                type: 'agent',
                id: agent.id,
                name: agent.name,
              },
              visibility: 'public',
              content: output.content,
              timestamp: new Date().toISOString(),
              metadata: output.metadata,
            };

            publicMessages.push(message);

            const record: CouncilRecord = {
              contractVersion: COUNCIL_CONTRACT_VERSION,
              type: 'message.emitted',
              councilId: this.state.councilId,
              turnId,
              timestamp: message.timestamp,
              message,
            };
            records.push(record);
          }
        } catch (error) {
          this.recordTurnError(
            turnId,
            records,
            errors,
            {
              code: 'agent_execution_failed',
              message: `Agent ${agent.id} failed in open mode: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            agent.id
          );
        }
      })
    );
  }

  private async executeCouncilMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    publicMessages: CouncilMessage[],
    privateMessages: CouncilMessage[],
    records: CouncilRecord[],
    errors: TurnError[]
  ): Promise<void> {
    // In council mode, agents deliberate privately then may emit public messages
    // Phase 1: Private deliberation
    // Phase 2: Public synthesis

    const activeAgents = this.selectAgents(event, options);

    // Phase 1: Private deliberation round
    const privateThoughts: Array<{ agent: AgentDefinition; content: string }> =
      [];

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        try {
          const output = await this.generateWithTools(
            turnId,
            agent,
            'council',
            event,
            this.state.messages,
            options,
            records,
            errors
          );

          if (output && output.content.trim()) {
            privateThoughts.push({ agent, content: output.content });

            const message: CouncilMessage = {
              id: generateId(),
              turnId,
              author: {
                type: 'agent',
                id: agent.id,
                name: agent.name,
              },
              visibility: 'private',
              content: output.content,
              timestamp: new Date().toISOString(),
              metadata: output.metadata,
            };

            privateMessages.push(message);

            const record: CouncilRecord = {
              contractVersion: COUNCIL_CONTRACT_VERSION,
              type: 'message.emitted',
              councilId: this.state.councilId,
              turnId,
              timestamp: message.timestamp,
              message,
            };
            records.push(record);
          }
        } catch (error) {
          this.recordTurnError(
            turnId,
            records,
            errors,
            {
              code: 'agent_execution_failed',
              message: `Agent ${agent.id} failed in council deliberation: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            agent.id
          );
        }
      })
    );

    // Phase 2: Public synthesis
    // Each agent can now emit a public response based on the private deliberation
    // For simplicity, we'll let each agent optionally emit one public message

    if (privateThoughts.length > 0) {
      await Promise.allSettled(
        activeAgents.map(async (agent) => {
          try {
            // Create a synthesis prompt showing all private thoughts
            const synthesisPrompt = `Based on the council's private deliberation, formulate your public response.

Private thoughts from council:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Your public response (or say nothing if you have nothing to add):`;

            const synthesisEvent: ChatEvent = {
              ...event,
              content: synthesisPrompt,
            };

            const output = await this.generateWithTools(
              turnId,
              agent,
              'council',
              synthesisEvent,
              [...this.state.messages, ...privateMessages],
              options,
              records,
              errors
            );

            if (output && output.content.trim()) {
              const message: CouncilMessage = {
                id: generateId(),
                turnId,
                author: {
                  type: 'agent',
                  id: agent.id,
                  name: agent.name,
                },
                visibility: 'public',
                content: output.content,
                timestamp: new Date().toISOString(),
                metadata: output.metadata,
              };

              publicMessages.push(message);

              const record: CouncilRecord = {
                contractVersion: COUNCIL_CONTRACT_VERSION,
                type: 'message.emitted',
                councilId: this.state.councilId,
                turnId,
                timestamp: message.timestamp,
                message,
              };
              records.push(record);
            }
          } catch (error) {
            this.recordTurnError(
              turnId,
              records,
              errors,
              {
                code: 'agent_execution_failed',
                message: `Agent ${agent.id} failed in council synthesis: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
              agent.id
            );
          }
        })
      );
    }
  }

  private async executeOracleMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    publicMessages: CouncilMessage[],
    privateMessages: CouncilMessage[],
    records: CouncilRecord[],
    errors: TurnError[]
  ): Promise<void> {
    // In oracle mode, agents deliberate privately but the public response is unified
    // Phase 1: Private deliberation
    // Phase 2: Unified oracle response

    const activeAgents = this.selectAgents(event, options);

    // Phase 1: Private deliberation
    const privateThoughts: Array<{ agent: AgentDefinition; content: string }> =
      [];

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        try {
          const output = await this.generateWithTools(
            turnId,
            agent,
            'oracle',
            event,
            this.state.messages,
            options,
            records,
            errors
          );

          if (output && output.content.trim()) {
            privateThoughts.push({ agent, content: output.content });

            const message: CouncilMessage = {
              id: generateId(),
              turnId,
              author: {
                type: 'agent',
                id: agent.id,
                name: agent.name,
              },
              visibility: 'private',
              content: output.content,
              timestamp: new Date().toISOString(),
              metadata: output.metadata,
            };

            privateMessages.push(message);

            const record: CouncilRecord = {
              contractVersion: COUNCIL_CONTRACT_VERSION,
              type: 'message.emitted',
              councilId: this.state.councilId,
              turnId,
              timestamp: message.timestamp,
              message,
            };
            records.push(record);
          }
        } catch (error) {
          this.recordTurnError(
            turnId,
            records,
            errors,
            {
              code: 'agent_execution_failed',
              message: `Agent ${agent.id} failed in oracle deliberation: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
            agent.id
          );
        }
      })
    );

    // Phase 2: Unified oracle response
    // Use the first available agent to synthesize a unified response
    if (privateThoughts.length > 0 && activeAgents.length > 0) {
      const synthesisAgent = activeAgents[0];
      try {
        const oraclePrompt = `You are the Oracle, speaking with one unified voice for the council.

Private deliberation from council members:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Synthesize a single, unified response that represents the council's collective wisdom:`;

        const oracleEvent: ChatEvent = {
          ...event,
          content: oraclePrompt,
        };

        const output = await this.generateWithTools(
          turnId,
          synthesisAgent,
          'oracle',
          oracleEvent,
          [...this.state.messages, ...privateMessages],
          options,
          records,
          errors
        );

        if (output && output.content.trim()) {
          const message: CouncilMessage = {
            id: generateId(),
            turnId,
            author: {
              type: 'oracle',
              id: 'oracle',
              name: 'Oracle',
            },
            visibility: 'public',
            content: output.content,
            timestamp: new Date().toISOString(),
            metadata: output.metadata,
          };

          publicMessages.push(message);

          const record: CouncilRecord = {
            contractVersion: COUNCIL_CONTRACT_VERSION,
            type: 'message.emitted',
            councilId: this.state.councilId,
            turnId,
            timestamp: message.timestamp,
            message,
          };
          records.push(record);
        }
      } catch (error) {
        this.recordTurnError(
          turnId,
          records,
          errors,
          {
            code: 'oracle_synthesis_failed',
            message: `Oracle synthesis failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          synthesisAgent.id
        );
      }
    }
  }

  // Streaming variants

  private async *streamOpenMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    pendingMessages: CouncilMessage[]
  ): AsyncGenerator<CouncilRuntimeEvent, void, void> {
    const activeAgents = this.selectAgents(event, options);

    for (const agent of activeAgents) {
      yield {
        type: 'agent.started',
        councilId: this.state.councilId,
        turnId,
        agentId: agent.id,
        timestamp: new Date().toISOString(),
      };

      try {
        const history = this.state.messages.filter(
          (m) => m.visibility === 'public'
        );
        const output = yield* this.generateWithToolsStream(
          turnId,
          agent,
          'open',
          event,
          history,
          options
        );

        if (output && output.content.trim()) {
          const message: CouncilMessage = {
            id: generateId(),
            turnId,
            author: { type: 'agent', id: agent.id, name: agent.name },
            visibility: 'public',
            content: output.content,
            timestamp: new Date().toISOString(),
            metadata: output.metadata,
          };

          pendingMessages.push(message);

          yield {
            type: 'message.emitted',
            councilId: this.state.councilId,
            turnId,
            timestamp: message.timestamp,
            message,
          };
        }
      } catch (error) {
        yield {
          type: 'error',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
          error: {
            code: 'agent_execution_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      yield {
        type: 'agent.finished',
        councilId: this.state.councilId,
        turnId,
        agentId: agent.id,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async *streamCouncilMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    pendingMessages: CouncilMessage[]
  ): AsyncGenerator<CouncilRuntimeEvent, void, void> {
    const activeAgents = this.selectAgents(event, options);
    const privateThoughts: Array<{ agent: AgentDefinition; content: string }> = [];

    // Phase 1: Private deliberation
    for (const agent of activeAgents) {
      yield {
        type: 'agent.started',
        councilId: this.state.councilId,
        turnId,
        agentId: agent.id,
        timestamp: new Date().toISOString(),
      };

      try {
        const output = yield* this.generateWithToolsStream(
          turnId,
          agent,
          'council',
          event,
          [...this.state.messages, ...pendingMessages],
          options
        );

        if (output && output.content.trim()) {
          privateThoughts.push({ agent, content: output.content });

          const message: CouncilMessage = {
            id: generateId(),
            turnId,
            author: { type: 'agent', id: agent.id, name: agent.name },
            visibility: 'private',
            content: output.content,
            timestamp: new Date().toISOString(),
            metadata: output.metadata,
          };

          pendingMessages.push(message);

          yield {
            type: 'message.emitted',
            councilId: this.state.councilId,
            turnId,
            timestamp: message.timestamp,
            message,
          };
        }
      } catch (error) {
        yield {
          type: 'error',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
          error: { message: error instanceof Error ? error.message : String(error) },
        };
      }

      yield {
        type: 'agent.finished',
        councilId: this.state.councilId,
        turnId,
        agentId: agent.id,
        timestamp: new Date().toISOString(),
      };
    }

    // Phase 2: Public synthesis
    if (privateThoughts.length > 0) {
      for (const agent of activeAgents) {
        yield {
          type: 'agent.started',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
        };

        try {
          const synthesisPrompt = `Based on the council's private deliberation, formulate your public response.

Private thoughts from council:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Your public response (or say nothing if you have nothing to add):`;

          const output = yield* this.generateWithToolsStream(
            turnId,
            agent,
            'council',
            { ...event, content: synthesisPrompt },
            [...this.state.messages, ...pendingMessages],
            options
          );

          if (output && output.content.trim()) {
            const message: CouncilMessage = {
              id: generateId(),
              turnId,
              author: { type: 'agent', id: agent.id, name: agent.name },
              visibility: 'public',
              content: output.content,
              timestamp: new Date().toISOString(),
              metadata: output.metadata,
            };

            pendingMessages.push(message);

            yield {
              type: 'message.emitted',
              councilId: this.state.councilId,
              turnId,
              timestamp: message.timestamp,
              message,
            };
          }
        } catch (error) {
          yield {
            type: 'error',
            councilId: this.state.councilId,
            turnId,
            agentId: agent.id,
            timestamp: new Date().toISOString(),
            error: {
              code: 'agent_execution_failed',
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }

        yield {
          type: 'agent.finished',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
        };
      }
    }
  }

  private async *streamOracleMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    pendingMessages: CouncilMessage[]
  ): AsyncGenerator<CouncilRuntimeEvent, void, void> {
    const activeAgents = this.selectAgents(event, options);
    const privateThoughts: Array<{ agent: AgentDefinition; content: string }> = [];

    // Phase 1: Private deliberation
    for (const agent of activeAgents) {
      yield {
        type: 'agent.started',
        councilId: this.state.councilId,
        turnId,
        agentId: agent.id,
        timestamp: new Date().toISOString(),
      };

      try {
        const output = yield* this.generateWithToolsStream(
          turnId,
          agent,
          'oracle',
          event,
          [...this.state.messages, ...pendingMessages],
          options
        );

        if (output && output.content.trim()) {
          privateThoughts.push({ agent, content: output.content });

          const message: CouncilMessage = {
            id: generateId(),
            turnId,
            author: { type: 'agent', id: agent.id, name: agent.name },
            visibility: 'private',
            content: output.content,
            timestamp: new Date().toISOString(),
            metadata: output.metadata,
          };

          pendingMessages.push(message);

          yield {
            type: 'message.emitted',
            councilId: this.state.councilId,
            turnId,
            timestamp: message.timestamp,
            message,
          };
        }
      } catch (error) {
        yield {
          type: 'error',
          councilId: this.state.councilId,
          turnId,
          agentId: agent.id,
          timestamp: new Date().toISOString(),
          error: {
            code: 'agent_execution_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      yield {
        type: 'agent.finished',
        councilId: this.state.councilId,
        turnId,
        agentId: agent.id,
        timestamp: new Date().toISOString(),
      };
    }

    // Phase 2: Oracle synthesis
    if (privateThoughts.length > 0 && activeAgents.length > 0) {
      const synthesisAgent = activeAgents[0];

      yield {
        type: 'agent.started',
        councilId: this.state.councilId,
        turnId,
        agentId: 'oracle',
        timestamp: new Date().toISOString(),
      };

      try {
        const oraclePrompt = `You are the Oracle, speaking with one unified voice for the council.

Private deliberation from council members:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Synthesize a single, unified response that represents the council's collective wisdom:`;

        const output = yield* this.generateWithToolsStream(
          turnId,
          synthesisAgent,
          'oracle',
          { ...event, content: oraclePrompt },
          [...this.state.messages, ...pendingMessages],
          options
        );

        if (output && output.content.trim()) {
          const message: CouncilMessage = {
            id: generateId(),
            turnId,
            author: { type: 'oracle', id: 'oracle', name: 'Oracle' },
            visibility: 'public',
            content: output.content,
            timestamp: new Date().toISOString(),
            metadata: output.metadata,
          };

          pendingMessages.push(message);

          yield {
            type: 'message.emitted',
            councilId: this.state.councilId,
            turnId,
            timestamp: message.timestamp,
            message,
          };
        }
      } catch (error) {
        yield {
          type: 'error',
          councilId: this.state.councilId,
          turnId,
          agentId: 'oracle',
          timestamp: new Date().toISOString(),
          error: {
            code: 'oracle_synthesis_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      yield {
        type: 'agent.finished',
        councilId: this.state.councilId,
        turnId,
        agentId: 'oracle',
        timestamp: new Date().toISOString(),
      };
    }
  }

  private selectAgents(
    event: ChatEvent,
    options: TurnOptions | undefined
  ): AgentDefinition[] {
    // Simple agent selection: all agents participate
    // Future: implement relevance checking, @mentions, etc.
    const maxAgents = options?.maxAgentReplies ?? this.agents.size;
    return Array.from(this.agents.values()).slice(0, maxAgents);
  }
}
