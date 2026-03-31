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
  EngineInput,
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
            this.state.messages.push(record.message);
            break;

          case 'tool.called':
          case 'tool.result':
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
          records
        );
        break;

      case 'council':
        await this.executeCouncilMode(
          turnId,
          event,
          options,
          publicMessages,
          privateMessages,
          records
        );
        break;

      case 'oracle':
        await this.executeOracleMode(
          turnId,
          event,
          options,
          publicMessages,
          privateMessages,
          records
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

    // Add messages to state
    this.state.messages.push(...publicMessages, ...privateMessages);

    return {
      turnId,
      mode,
      publicMessages,
      privateMessages,
      records,
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

    // Commit all messages to state only after turn fully completes
    this.state.messages.push(...pendingMessages);

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

    return filtered;
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
      metadata: this.state.metadata,
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

  // Mode-specific execution methods

  private async executeOpenMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    publicMessages: CouncilMessage[],
    privateMessages: CouncilMessage[],
    records: CouncilRecord[]
  ): Promise<void> {
    // In open mode, agents may speak independently in public
    // Simple parallel execution - each agent that wants to respond does so publicly

    const activeAgents = this.selectAgents(event, options);

    await Promise.allSettled(
      activeAgents.map(async (agent) => {
        try {
          const engine = this.engines.get(agent.engine.id);
          if (!engine) {
            throw new Error(`Engine ${agent.engine.id} not found`);
          }

          const input: EngineInput = {
            councilId: this.state.councilId,
            turnId,
            agent,
            mode: 'open',
            event,
            history: this.state.messages.filter((m) => m.visibility === 'public'),
          };

          const output = await engine.generate(input);

          if (output.content.trim()) {
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
          // Log error but don't fail the whole turn
          console.error(`Agent ${agent.id} failed in open mode:`, error);
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
    records: CouncilRecord[]
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
          const engine = this.engines.get(agent.engine.id);
          if (!engine) return;

          const input: EngineInput = {
            councilId: this.state.councilId,
            turnId,
            agent,
            mode: 'council',
            event,
            history: this.state.messages,
          };

          const output = await engine.generate(input);

          if (output.content.trim()) {
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
          console.error(`Agent ${agent.id} failed in council mode:`, error);
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
            const engine = this.engines.get(agent.engine.id);
            if (!engine) return;

            // Create a synthesis prompt showing all private thoughts
            const synthesisPrompt = `Based on the council's private deliberation, formulate your public response.

Private thoughts from council:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Your public response (or say nothing if you have nothing to add):`;

            const synthesisEvent: ChatEvent = {
              ...event,
              content: synthesisPrompt,
            };

            const input: EngineInput = {
              councilId: this.state.councilId,
              turnId,
              agent,
              mode: 'council',
              event: synthesisEvent,
              history: [...this.state.messages, ...privateMessages],
            };

            const output = await engine.generate(input);

            if (output.content.trim()) {
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
            console.error(
              `Agent ${agent.id} failed in council synthesis:`,
              error
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
    records: CouncilRecord[]
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
          const engine = this.engines.get(agent.engine.id);
          if (!engine) return;

          const input: EngineInput = {
            councilId: this.state.councilId,
            turnId,
            agent,
            mode: 'oracle',
            event,
            history: this.state.messages,
          };

          const output = await engine.generate(input);

          if (output.content.trim()) {
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
          console.error(`Agent ${agent.id} failed in oracle mode:`, error);
        }
      })
    );

    // Phase 2: Unified oracle response
    // Use the first available agent to synthesize a unified response
    if (privateThoughts.length > 0 && activeAgents.length > 0) {
      const synthesisAgent = activeAgents[0];
      const engine = this.engines.get(synthesisAgent.engine.id);

      if (engine) {
        try {
          const oraclePrompt = `You are the Oracle, speaking with one unified voice for the council.

Private deliberation from council members:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Synthesize a single, unified response that represents the council's collective wisdom:`;

          const oracleEvent: ChatEvent = {
            ...event,
            content: oraclePrompt,
          };

          const input: EngineInput = {
            councilId: this.state.councilId,
            turnId,
            agent: synthesisAgent,
            mode: 'oracle',
            event: oracleEvent,
            history: [...this.state.messages, ...privateMessages],
          };

          const output = await engine.generate(input);

          if (output.content.trim()) {
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
          console.error('Oracle synthesis failed:', error);
        }
      }
    }
  }

  // Streaming variants

  private async *streamOpenMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    pendingMessages: CouncilMessage[]
  ): AsyncIterable<CouncilRuntimeEvent> {
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
        const engine = this.engines.get(agent.engine.id);
        if (!engine) {
          throw new Error(`Engine ${agent.engine.id} not found`);
        }

        const input: EngineInput = {
          councilId: this.state.councilId,
          turnId,
          agent,
          mode: 'open',
          event,
          history: this.state.messages.filter((m) => m.visibility === 'public'),
        };

        const output = await engine.generate(input);

        if (output.content.trim()) {
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
  }

  private async *streamCouncilMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    pendingMessages: CouncilMessage[]
  ): AsyncIterable<CouncilRuntimeEvent> {
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
        const engine = this.engines.get(agent.engine.id);
        if (!engine) continue;

        const input: EngineInput = {
          councilId: this.state.councilId,
          turnId,
          agent,
          mode: 'council',
          event,
          history: [...this.state.messages, ...pendingMessages],
        };

        const output = await engine.generate(input);

        if (output.content.trim()) {
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
          const engine = this.engines.get(agent.engine.id);
          if (!engine) continue;

          const synthesisPrompt = `Based on the council's private deliberation, formulate your public response.

Private thoughts from council:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Your public response (or say nothing if you have nothing to add):`;

          const input: EngineInput = {
            councilId: this.state.councilId,
            turnId,
            agent,
            mode: 'council',
            event: { ...event, content: synthesisPrompt },
            history: [...this.state.messages, ...pendingMessages],
          };

          const output = await engine.generate(input);

          if (output.content.trim()) {
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
    }
  }

  private async *streamOracleMode(
    turnId: string,
    event: ChatEvent,
    options: TurnOptions | undefined,
    pendingMessages: CouncilMessage[]
  ): AsyncIterable<CouncilRuntimeEvent> {
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
        const engine = this.engines.get(agent.engine.id);
        if (!engine) continue;

        const input: EngineInput = {
          councilId: this.state.councilId,
          turnId,
          agent,
          mode: 'oracle',
          event,
          history: [...this.state.messages, ...pendingMessages],
        };

        const output = await engine.generate(input);

        if (output.content.trim()) {
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
        const engine = this.engines.get(synthesisAgent.engine.id);
        if (!engine) throw new Error('Synthesis engine not found');

        const oraclePrompt = `You are the Oracle, speaking with one unified voice for the council.

Private deliberation from council members:
${privateThoughts.map((t) => `${t.agent.name}: ${t.content}`).join('\n\n')}

Synthesize a single, unified response that represents the council's collective wisdom:`;

        const input: EngineInput = {
          councilId: this.state.councilId,
          turnId,
          agent: synthesisAgent,
          mode: 'oracle',
          event: { ...event, content: oraclePrompt },
          history: [...this.state.messages, ...pendingMessages],
        };

        const output = await engine.generate(input);

        if (output.content.trim()) {
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
          error: { message: error instanceof Error ? error.message : String(error) },
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
