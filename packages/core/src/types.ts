/**
 * council-of-experts contract types
 * Based on contract version 1
 */

export const COUNCIL_CONTRACT_VERSION = 1 as const;

export type CouncilMode = 'open' | 'council' | 'oracle';

export interface EngineSpec {
  id: string;
  provider?: string;
  model: string;
  contextWindow: number;
  settings?: Record<string, unknown>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  engine: EngineSpec;
  modelName: string;
  summary: string;
  systemPrompt: string;
  tools?: string[];
  metadata?: Record<string, unknown>;
}

export interface OpenCouncilInput {
  councilId: string;
  initialMode?: CouncilMode;
  metadata?: Record<string, unknown>;
}

export interface ChatEvent {
  id?: string;
  actor: {
    type: 'user' | 'agent' | 'system';
    id: string;
    name?: string;
  };
  content: string;
  timestamp?: string | number | Date;
  metadata?: Record<string, unknown>;
}

export interface CouncilMessage {
  id: string;
  turnId: string;
  author: {
    type: 'agent' | 'oracle' | 'system';
    id: string;
    name: string;
  };
  visibility: 'public' | 'private';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  content?: string;
  data?: unknown;
  error?: string;
}

export interface ToolExecutionContext {
  councilId: string;
  turnId: string;
  agentId: string;
}

export interface ToolHost {
  execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export interface EngineInput {
  councilId: string;
  turnId: string;
  agent: AgentDefinition;
  mode: CouncilMode;
  event: ChatEvent;
  history: CouncilMessage[];
}

export interface EngineOutput {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface EngineAdapter {
  generate(input: EngineInput): Promise<EngineOutput>;
  stream?(input: EngineInput): AsyncIterable<EngineOutput>;
}

export interface CouncilModuleConfig {
  agents: AgentDefinition[];
  engines: Record<string, EngineAdapter>;
  toolHost?: ToolHost;
}

export interface TurnOptions {
  mode?: CouncilMode;
  maxRounds?: number;
  maxAgentReplies?: number;
  trace?: boolean;
}

export type CouncilRecord =
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'mode.changed';
      councilId: string;
      turnId: string;
      timestamp: string;
      from: CouncilMode;
      to: CouncilMode;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'message.emitted';
      councilId: string;
      turnId: string;
      timestamp: string;
      message: CouncilMessage;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'tool.called';
      councilId: string;
      turnId: string;
      timestamp: string;
      agentId: string;
      callId: string;
      call: ToolCall;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'tool.result';
      councilId: string;
      turnId: string;
      timestamp: string;
      agentId: string;
      callId: string;
      result: ToolResult;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'turn.completed';
      councilId: string;
      turnId: string;
      timestamp: string;
      mode: CouncilMode;
    };

export type CouncilReplayEntry =
  | {
      type: 'host.chat';
      event: ChatEvent;
    }
  | {
      type: 'council.record';
      record: CouncilRecord;
    };

export interface TurnResult {
  turnId: string;
  mode: CouncilMode;
  nextMode?: CouncilMode;
  publicMessages: CouncilMessage[];
  privateMessages: CouncilMessage[];
  records: CouncilRecord[];
}

export type CouncilRuntimeEvent =
  | {
      type: 'turn.started';
      councilId: string;
      turnId: string;
      timestamp: string;
      mode: CouncilMode;
    }
  | {
      type: 'agent.started';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
    }
  | {
      type: 'agent.finished';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
    }
  | {
      type: 'message.emitted';
      councilId: string;
      turnId: string;
      timestamp: string;
      message: CouncilMessage;
    }
  | {
      type: 'tool.called';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
      callId: string;
      call: ToolCall;
    }
  | {
      type: 'tool.result';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
      callId: string;
      result: ToolResult;
    }
  | {
      type: 'mode.changed';
      councilId: string;
      turnId: string;
      timestamp: string;
      from: CouncilMode;
      to: CouncilMode;
    }
  | {
      type: 'turn.completed';
      councilId: string;
      turnId: string;
      timestamp: string;
      mode: CouncilMode;
    }
  | {
      type: 'error';
      councilId: string;
      turnId?: string;
      agentId?: string;
      timestamp: string;
      error: {
        message: string;
        code?: string;
        data?: unknown;
      };
    };

export interface Council {
  getMode(): CouncilMode;

  replay(
    entries: Iterable<CouncilReplayEntry> | AsyncIterable<CouncilReplayEntry>
  ): Promise<void>;

  post(event: ChatEvent, options?: TurnOptions): Promise<TurnResult>;

  stream(
    event: ChatEvent,
    options?: TurnOptions
  ): AsyncIterable<CouncilRuntimeEvent>;

  getMessages(options?: {
    visibility?: 'public' | 'private' | 'all';
    limit?: number;
  }): Promise<CouncilMessage[]>;

  getStatus(): Promise<unknown>;

  dispose(): Promise<void>;
}

export interface CouncilModule {
  openCouncil(input: OpenCouncilInput): Promise<Council>;
  listAgents(): AgentDefinition[];
}
