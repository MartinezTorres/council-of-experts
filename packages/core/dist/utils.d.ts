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
/**
 * Parse @mentions from a message
 * Supports mentions like: @AgentName, @🎭AgentName, @🤖 AgentName
 *
 * @param message - The message text to parse
 * @returns Set of mentioned agent names (lowercase)
 *
 * @example
 * parseMentions("Hey @Ada and @🎭 NeStor, help me")
 * // Returns Set { 'ada', 'nestor' }
 */
export declare function parseMentions(message: string): Set<string>;
/**
 * Filter experts by mentioned names
 * Case-insensitive matching against expert.name
 *
 * @param experts - Available experts
 * @param mentions - Set of mentioned names (from parseMentions)
 * @returns Filtered list of experts
 */
export declare function filterExpertsByMention<T extends {
    name: string;
}>(experts: T[], mentions: Set<string>): T[];
/**
 * Filter experts by recent activity in conversation history
 * Returns experts who have recently participated in the conversation
 *
 * @param experts - Available experts
 * @param recentMessages - Recent message history
 * @param lookbackCount - How many recent messages to consider (default: 10)
 * @returns Filtered list of recently active experts
 *
 * @example
 * const activeExperts = filterExpertsByRecentActivity(
 *   allExperts,
 *   chatHistory,
 *   10
 * );
 */
export declare function filterExpertsByRecentActivity<T extends {
    name: string;
}>(experts: T[], recentMessages: Array<{
    type: string;
    display_name?: string;
}>, lookbackCount?: number): T[];
//# sourceMappingURL=utils.d.ts.map