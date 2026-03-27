/**
 * Council of Experts - Public API
 */

// Main class
export { CouncilOrchestrator } from './CouncilOrchestrator.js';

// Supporting classes
export { AIClient } from './AIClient.js';
export { ToolSystem } from './ToolSystem.js';

// Types - Provider interfaces
export type {
  DocumentProvider,
  SettingsProvider,
  LoggerProvider,
  EventBroadcaster
} from './types.js';

// Types - Domain
export type {
  Document,
  Attachment,
  AttachmentFile,
  SuggestionResult
} from './types.js';

// Types - AI
export type {
  AIModel,
  SummarizationConfig,
  AIResponse,
  ToolCall
} from './types.js';

// Types - Experts
export type {
  Expert,
  ExpertResponse
} from './types.js';

// Types - Tools
export type {
  Tool,
  ToolParameter,
  ToolExecutionContext,
  ToolResult,
  ToolExecutor
} from './types.js';

// Types - Configuration
export type {
  CouncilConfig
} from './types.js';

// Types - OpenAI
export type {
  OpenAIFunction,
  OpenAIMessage,
  OpenAIToolCall
} from './types.js';

// Types - Diagnostics
export type {
  Diagnostic
} from './types.js';

// Utilities
export {
  removeThinkingTags,
  toOpenAIFunction,
  estimateTokens,
  generateCacheKey,
  parseMentions,
  filterExpertsByMention,
  filterExpertsByRecentActivity
} from './utils.js';

// Constants
export {
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  AI_TIMEOUT_MS,
  SUMMARY_CACHE_MAX_SIZE,
  DIAGNOSTICS_MAX_PER_MODEL,
  CHARS_PER_TOKEN,
  LARGE_ATTACHMENT_THRESHOLD_TOKENS,
  ANALYSIS_MAX_TOKENS
} from './constants.js';
