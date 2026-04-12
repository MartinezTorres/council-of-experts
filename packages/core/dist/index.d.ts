/**
 * council-of-experts - Multi-agent AI orchestration runtime
 * Contract version 1
 */
export type { CouncilError, CouncilMode, ToolDefinition, ToolRef, EngineSpec, AgentDefinition, OpenCouncilInput, ChatEvent, CouncilMessage, ToolCall, ToolResult, ToolExecutionContext, ToolHost, EngineInput, EngineOutput, EngineAdapter, CouncilModuleConfig, CouncilRuntimeConfig, CouncilModuleResolvedConfig, CouncilInstanceResolvedConfig, TurnOptions, CouncilRecord, CouncilReplayEntry, TurnResult, TurnError, CouncilRuntimeEvent, Council, CouncilModule, ProbeResult, DiscoveredModel, ToolProbeResult, } from './types.js';
export { COUNCIL_CONTRACT_VERSION } from './types.js';
export { DEFAULT_COUNCIL_RUNTIME_CONFIG } from './config.js';
export { createCouncilModule } from './CouncilModule.js';
export { generateId, normalizeTimestamp } from './utils.js';
export { probeEngine, discoverModels, testToolSupport } from './probe.js';
//# sourceMappingURL=index.d.ts.map