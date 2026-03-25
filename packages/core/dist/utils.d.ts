/**
 * Utility functions
 */
import type { OpenAIFunction, Tool } from './types.js';
/**
 * Remove thinking tags from AI responses
 */
export declare function removeThinkingTags(text: string): string;
/**
 * Convert tool definition to OpenAI function format
 */
export declare function toOpenAIFunction(tool: Tool): OpenAIFunction;
/**
 * Estimate token count (rough approximation)
 */
export declare function estimateTokens(text: string): number;
/**
 * Generate cache key from content
 */
export declare function generateCacheKey(...parts: string[]): string;
//# sourceMappingURL=utils.d.ts.map