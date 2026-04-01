/**
 * council-of-experts - Multi-agent AI orchestration runtime
 * Contract version 1
 */
export type { CouncilMode, EngineSpec, AgentDefinition, OpenCouncilInput, ChatEvent, CouncilMessage, ToolCall, ToolResult, ToolExecutionContext, ToolHost, EngineInput, EngineOutput, EngineAdapter, CouncilModuleConfig, TurnOptions, CouncilRecord, CouncilReplayEntry, TurnResult, CouncilRuntimeEvent, Council, CouncilModule, ProbeResult, DiscoveredModel, ToolProbeResult, } from './types.js';
export { COUNCIL_CONTRACT_VERSION } from './types.js';
export { createCouncilModule } from './CouncilModule.js';
export { generateId, normalizeTimestamp } from './utils.js';
export { probeEngine, discoverModels, testToolSupport } from './probe.js';
//# sourceMappingURL=index.d.ts.map