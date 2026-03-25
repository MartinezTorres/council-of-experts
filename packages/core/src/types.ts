/**
 * Type definitions for council-of-experts
 * A role-agnostic AI agent orchestration library
 */

// ============================================================================
// Provider Interfaces (Dependency Injection)
// ============================================================================

/**
 * Document provider - implements document/resource access
 * Consumer must implement this to connect council to their data
 */
export interface DocumentProvider {
  getDocument(id: string): Promise<Document>;
  createSuggestion(
    documentId: string,
    content: string,
    baseVersion: number,
    userId: string
  ): Promise<SuggestionResult>;
  getAttachment(documentId: string, attachmentId: string): Promise<Attachment | null>;
}

/**
 * Settings provider - implements configuration access
 */
export interface SettingsProvider {
  getModel(modelName: string): Promise<AIModel | null>;
  getTimeoutMs(): Promise<number>;
  getSummarizationConfig(): Promise<SummarizationConfig | null>;
  getChatSystemPrompt(): Promise<string | null>;
}

/**
 * Logger provider - implements logging
 */
export interface LoggerProvider {
  logOperation(operation: string, userId: string, metadata?: any): Promise<void>;
  logError(operation: string, error: Error): Promise<void>;
}

/**
 * Event broadcaster - optional, for real-time updates
 */
export interface EventBroadcaster {
  emit(room: string, event: string, data: any): void;
}

// ============================================================================
// Domain Types
// ============================================================================

export interface Document {
  id: string;
  content: string;
  version?: number;
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  type: string;
  description?: string;
  files: AttachmentFile[];
}

export interface AttachmentFile {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  data?: Buffer;
}

export interface SuggestionResult {
  id: string;
  created_by: string;
  created_at: string;
  base_version: number;
}

// ============================================================================
// AI Types
// ============================================================================

export interface AIModel {
  name: string;
  url: string;
  model: string;
  api_key: string;
}

export interface SummarizationConfig {
  model: string;
  promptTemplate?: string;
}

export interface AIResponse {
  content: string;
  toolCalls?: ToolCall[];
  diagnosticId?: string;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

// ============================================================================
// Expert/Agent Types (Role-Agnostic)
// ============================================================================

export interface Expert {
  name: string;
  icon: string;
  systemPrompt: string;
  model: string;
  temperature: number;
  userId: string; // e.g., "system-agent:SecurityExpert"
}

export interface ExpertResponse {
  expertUserId: string;
  message: string;
  timestamp: string;
  diagnosticId?: string;
}

// ============================================================================
// Tool System Types
// ============================================================================

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  needsProcessing: boolean; // Does expert need to see result?
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}

export interface ToolExecutionContext {
  documentId: string;
  expertUserId: string;
  triggerUserId: string;
}

export interface ToolResult {
  tool: string;
  result: string;
  success: boolean;
}

export type ToolExecutor = (
  args: Record<string, any>,
  context: ToolExecutionContext
) => Promise<ToolResult>;

// ============================================================================
// OpenAI-Compatible Types
// ============================================================================

export interface OpenAIFunction {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// ============================================================================
// Diagnostic Types
// ============================================================================

export interface Diagnostic {
  id: string;
  timestamp: string;
  modelName: string;
  modelUrl: string;
  request: {
    prompt: string;
    systemPrompt?: string;
    temperature: number;
    maxTokens: number;
  };
  response: {
    content: string;
    finishReason?: string;
  };
  performance: {
    responseTimeMs: number;
    tokensPerSecond?: number;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface CouncilConfig {
  documentProvider: DocumentProvider;
  settingsProvider: SettingsProvider;
  loggerProvider?: LoggerProvider;
  broadcaster?: EventBroadcaster;
}
