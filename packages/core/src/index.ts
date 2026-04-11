/**
 * council-of-experts - Multi-agent AI orchestration runtime
 * Contract version 1
 */

// Export all contract types
export type {
  CouncilError,
  CouncilMode,
  ToolDefinition,
  ToolRef,
  EngineSpec,
  AgentDefinition,
  OpenCouncilInput,
  ChatEvent,
  CouncilMessage,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  ToolHost,
  EngineInput,
  EngineOutput,
  EngineAdapter,
  CouncilModuleConfig,
  TurnOptions,
  CouncilRecord,
  CouncilReplayEntry,
  TurnResult,
  TurnError,
  CouncilRuntimeEvent,
  Council,
  CouncilModule,
  ProbeResult,
  DiscoveredModel,
  ToolProbeResult,
} from './types.js';

// Export constant
export { COUNCIL_CONTRACT_VERSION } from './types.js';

// Export factory function
export { createCouncilModule } from './CouncilModule.js';

// Export utility functions
export { generateId, normalizeTimestamp } from './utils.js';

// Export engine probe and provider discovery utilities
export { probeEngine, discoverModels, testToolSupport } from './probe.js';
