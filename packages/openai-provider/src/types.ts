import type {
  AgentDefinition,
  CouncilModule,
  CouncilRuntimeConfig,
  EngineAdapter,
  EngineOutput,
  ToolCall,
  ToolRef,
  ToolResult,
} from 'council-of-experts';
import type { DocumentVault } from './documentVault.js';

export interface ProviderServerConfig {
  host?: string;
  port?: number;
  apiKeys?: string[];
}

export interface ProviderDebugConfig {
  enabled?: boolean;
}

export interface ProviderEngineConfig {
  provider: string;
  model: string;
  contextWindow?: number;
  charsPerToken?: number;
  settings?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ProviderAgentDocumentConfig {
  path: string;
  description?: string;
}

export interface ProviderAgentConfig {
  id: string;
  name: string;
  summary: string;
  systemPrompt: string;
  tools?: ToolRef[];
  documents?: ProviderAgentDocumentConfig[];
  metadata?: Record<string, unknown>;
  engine: ProviderEngineConfig;
}

export interface ResolvedProviderAgentDocumentConfig
  extends ProviderAgentDocumentConfig {
  absolutePath: string;
}

export interface ResolvedProviderAgentConfig
  extends Omit<ProviderAgentConfig, 'documents'> {
  documents?: ResolvedProviderAgentDocumentConfig[];
}

export interface VirtualModelConfig {
  description?: string;
  runtime?: Partial<CouncilRuntimeConfig>;
  agents: ProviderAgentConfig[];
}

export interface ProviderConfig {
  server?: ProviderServerConfig;
  debug?: ProviderDebugConfig;
  virtualModels: Record<string, VirtualModelConfig>;
}

export interface ResolvedProviderServerConfig {
  host: string;
  port: number;
  apiKeys: string[];
}

export interface ResolvedProviderDebugConfig {
  enabled: boolean;
}

export interface ResolvedVirtualModelConfig {
  id: string;
  description?: string;
  runtime: CouncilRuntimeConfig;
  agents: ResolvedProviderAgentConfig[];
}

export interface ResolvedProviderConfig {
  server: ResolvedProviderServerConfig;
  debug: ResolvedProviderDebugConfig;
  virtualModels: Record<string, ResolvedVirtualModelConfig>;
}

export interface VirtualModelRuntime {
  id: string;
  description?: string;
  agents: AgentDefinition[];
  documentVault: DocumentVault;
  councilModule: CouncilModule;
  engines: Record<string, EngineAdapter>;
}

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | {
      type: 'function';
      function: {
        name: string;
      };
    };

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | Array<{ type?: string; text?: string }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  user?: string;
  tools?: OpenAIFunctionTool[];
  tool_choice?: OpenAIToolChoice;
  [key: string]: unknown;
}

export interface RequestTrace {
  id: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  request: OpenAIChatCompletionRequest;
  transcript: string;
  council?: {
    config: unknown;
    status?: unknown;
    publicMessages?: unknown;
    privateMessages?: unknown;
    records?: unknown;
    errors?: unknown;
  };
  synthesis?: {
    agentId: string;
    localDocuments?: Array<{
      path: string;
      description?: string;
    }>;
    localToolCalls?: ToolCall[];
    localToolResults?: ToolResult[];
    draftOutput?: EngineOutput;
    finalOutput?: EngineOutput;
  };
  response?: unknown;
  error?: {
    message: string;
    statusCode: number;
  };
}

export interface ModelStats {
  requestCount: number;
  successCount: number;
  errorCount: number;
  inFlightCount: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
  lastError?: string;
}
