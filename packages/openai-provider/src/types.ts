import type {
  AgentDefinition,
  CouncilPromptConfig,
  ResolvedCouncilPromptConfig,
  CouncilModule,
  CouncilRuntimeConfig,
  EngineAdapter,
  EngineRequestDebug,
  EngineOutput,
  PromptSummaryPolicy,
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
  traceRetention?: number;
}

export interface ProviderLimitsConfig {
  requestBodyBytes?: number;
}

export interface ProviderFallbackConfig {
  agentContextExhaustedMessage?: string;
}

export interface ProviderPromptConfig {
  requestInstruction?: string;
  oraclePreparationTemplate?: string;
  oracleExternalSynthesisTemplate?: string;
}

export interface ProviderEngineConfig {
  provider: string;
  model: string;
  contextWindow: number;
  charsPerToken: number;
  promptBudgetRatio?: number;
  promptSummaryPolicy?: PromptSummaryPolicy;
  settings?: Record<string, unknown>;
  timeoutMs: number;
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
  councilPrompts?: Partial<CouncilPromptConfig>;
  synthesizerAgentId: string;
  agents: ProviderAgentConfig[];
}

export interface ProviderConfig {
  server?: ProviderServerConfig;
  debug?: ProviderDebugConfig;
  limits?: ProviderLimitsConfig;
  fallbacks?: ProviderFallbackConfig;
  prompts?: ProviderPromptConfig;
  virtualModels: Record<string, VirtualModelConfig>;
}

export interface ResolvedProviderServerConfig {
  host: string;
  port: number;
  apiKeys: string[];
}

export interface ResolvedProviderDebugConfig {
  enabled: boolean;
  traceRetention: number;
}

export interface ResolvedProviderLimitsConfig {
  requestBodyBytes: number;
}

export interface ResolvedProviderFallbackConfig {
  agentContextExhaustedMessage: string;
}

export interface ResolvedProviderPromptConfig {
  requestInstruction: string;
  oraclePreparationTemplate: string;
  oracleExternalSynthesisTemplate: string;
}

export interface ResolvedVirtualModelConfig {
  id: string;
  description?: string;
  runtime: CouncilRuntimeConfig;
  councilPrompts: ResolvedCouncilPromptConfig;
  synthesizerAgentId: string;
  agents: ResolvedProviderAgentConfig[];
}

export interface ResolvedProviderConfig {
  server: ResolvedProviderServerConfig;
  debug: ResolvedProviderDebugConfig;
  limits: ResolvedProviderLimitsConfig;
  fallbacks: ResolvedProviderFallbackConfig;
  prompts: ResolvedProviderPromptConfig;
  virtualModels: Record<string, ResolvedVirtualModelConfig>;
}

export interface VirtualModelRuntime {
  id: string;
  description?: string;
  synthesizerAgentId: string;
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
  debugTranscript: string;
  council?: {
    config: unknown;
    status?: unknown;
    publicMessages?: unknown;
    privateMessages?: unknown;
    records?: unknown;
    errors?: unknown;
    agentExecutions?: AgentExecutionTrace[];
  };
  synthesis?: {
    agentId: string;
    execution?: AgentExecutionTrace;
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
  degradedCount: number;
  errorCount: number;
  inFlightCount: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
  lastError?: string;
}

export interface AgentExecutionTrace {
  agentId: string;
  phase: 'deliberation' | 'synthesis';
  status: 'succeeded' | 'failed';
  messageTimestamp?: string;
  errorCode?: string;
  errorMessage?: string;
  requestDebug?: EngineRequestDebug;
}
