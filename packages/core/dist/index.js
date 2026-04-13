/**
 * council-of-experts - Multi-agent AI orchestration runtime
 * Contract version 1
 */
// Export constant
export { COUNCIL_CONTRACT_VERSION } from './types.js';
export { DEFAULT_COUNCIL_RUNTIME_CONFIG, resolveCouncilRuntimeConfig, } from './config.js';
export { DEFAULT_COUNCIL_PROMPTS, resolveCouncilPromptConfig, } from './prompts.js';
// Export factory function
export { createCouncilModule } from './CouncilModule.js';
export { OpenAIChatCompletionsEngine } from './OpenAIChatCompletionsEngine.js';
export { DEFAULT_PROMPT_BUDGET_RATIO, DEFAULT_PROMPT_SUMMARY_POLICY, } from './OpenAIChatPromptPacker.js';
export { AgentContextExhaustedError, isAgentContextExhaustedError, } from './errors.js';
// Export utility functions
export { generateId, normalizeTimestamp } from './utils.js';
// Export engine probe and provider discovery utilities
export { probeEngine, discoverModels, testToolSupport } from './probe.js';
//# sourceMappingURL=index.js.map