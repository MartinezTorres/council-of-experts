import {
  COUNCIL_CONTRACT_VERSION,
  AgentDefinition,
  ChatEvent,
  CouncilError,
  CouncilMessage,
  CouncilRecord,
  CouncilRuntimeEvent,
  CouncilMode,
  EngineOutput,
  TurnError,
  TurnOptions,
} from '../types.js';
import { generateId } from '../utils.js';

export interface ExecuteWorkflowInput {
  councilId: string;
  turnId: string;
  event: ChatEvent;
  options: TurnOptions | undefined;
  activeAgents: AgentDefinition[];
  stateMessages: CouncilMessage[];
  publicMessages: CouncilMessage[];
  privateMessages: CouncilMessage[];
  records: CouncilRecord[];
  errors: TurnError[];
}

export interface StreamWorkflowInput {
  councilId: string;
  turnId: string;
  event: ChatEvent;
  options: TurnOptions | undefined;
  activeAgents: AgentDefinition[];
  stateMessages: CouncilMessage[];
  pendingMessages: CouncilMessage[];
}

export interface WorkflowDependencies {
  generateWithTools: (
    turnId: string,
    agent: AgentDefinition,
    mode: CouncilMode,
    event: ChatEvent,
    history: CouncilMessage[],
    options: TurnOptions | undefined,
    records: CouncilRecord[],
    errors: TurnError[]
  ) => Promise<EngineOutput | null>;
  generateWithToolsStream: (
    turnId: string,
    agent: AgentDefinition,
    mode: CouncilMode,
    event: ChatEvent,
    history: CouncilMessage[],
    options: TurnOptions | undefined
  ) => AsyncGenerator<CouncilRuntimeEvent, EngineOutput | null, void>;
  recordTurnError: (
    turnId: string,
    records: CouncilRecord[],
    errors: TurnError[],
    error: CouncilError,
    agentId?: string
  ) => void;
}

export function createAgentMessage(input: {
  turnId: string;
  agent: AgentDefinition;
  visibility: 'public' | 'private';
  output: EngineOutput;
}): CouncilMessage {
  return {
    id: generateId(),
    turnId: input.turnId,
    author: {
      type: 'agent',
      id: input.agent.id,
      name: input.agent.name,
    },
    visibility: input.visibility,
    content: input.output.content,
    timestamp: new Date().toISOString(),
    metadata: input.output.metadata,
  };
}

export function createOracleMessage(input: {
  turnId: string;
  output: EngineOutput;
}): CouncilMessage {
  return {
    id: generateId(),
    turnId: input.turnId,
    author: {
      type: 'oracle',
      id: 'oracle',
      name: 'Oracle',
    },
    visibility: 'public',
    content: input.output.content,
    timestamp: new Date().toISOString(),
    metadata: input.output.metadata,
  };
}

export function createMessageRecord(
  councilId: string,
  turnId: string,
  message: CouncilMessage
): CouncilRecord {
  return {
    contractVersion: COUNCIL_CONTRACT_VERSION,
    type: 'message.emitted',
    councilId,
    turnId,
    timestamp: message.timestamp,
    message,
  };
}

export function createAgentStartedEvent(
  councilId: string,
  turnId: string,
  agentId: string
): CouncilRuntimeEvent {
  return {
    type: 'agent.started',
    councilId,
    turnId,
    agentId,
    timestamp: new Date().toISOString(),
  };
}

export function createAgentFinishedEvent(
  councilId: string,
  turnId: string,
  agentId: string
): CouncilRuntimeEvent {
  return {
    type: 'agent.finished',
    councilId,
    turnId,
    agentId,
    timestamp: new Date().toISOString(),
  };
}

export function createMessageEmittedEvent(
  councilId: string,
  turnId: string,
  message: CouncilMessage
): CouncilRuntimeEvent {
  return {
    type: 'message.emitted',
    councilId,
    turnId,
    timestamp: message.timestamp,
    message,
  };
}

export function createErrorEvent(
  councilId: string,
  turnId: string,
  agentId: string,
  error: CouncilError
): CouncilRuntimeEvent {
  return {
    type: 'error',
    councilId,
    turnId,
    agentId,
    timestamp: new Date().toISOString(),
    error,
  };
}

export function createDerivedEvent(
  event: ChatEvent,
  content: string
): ChatEvent {
  return {
    ...event,
    content,
  };
}
