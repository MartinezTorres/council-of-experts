/**
 * Utility functions
 */

import crypto from 'crypto';
import type { OpenAIFunction, Tool } from './types.js';

/**
 * Remove thinking tags from AI responses
 * Supports both <think> and <thinking> tags
 */
export function removeThinkingTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

/**
 * Convert tool definition to OpenAI function format
 */
export function toOpenAIFunction(tool: Tool): OpenAIFunction {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];

  for (const [name, param] of Object.entries(tool.parameters)) {
    properties[name] = {
      type: param.type,
      description: param.description
    };
    if (param.required) {
      required.push(name);
    }
  }

  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties,
        required
      }
    }
  };
}

/**
 * Estimate token count (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate cache key from content
 */
export function generateCacheKey(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ============================================================================
// Expert Selection Utilities
// ============================================================================

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
export function parseMentions(message: string): Set<string> {
  // Pattern: @ followed by optional non-word/non-space chars (emoji), optional whitespace, then word characters
  const mentionRegex = /@[^\w\s]*\s*(\w+)/g;
  const mentions = new Set<string>();
  let match;

  while ((match = mentionRegex.exec(message)) !== null) {
    if (match[1]) {
      mentions.add(match[1].toLowerCase());
    }
  }

  return mentions;
}

/**
 * Filter experts by mentioned names
 * Case-insensitive matching against expert.name
 *
 * @param experts - Available experts
 * @param mentions - Set of mentioned names (from parseMentions)
 * @returns Filtered list of experts
 */
export function filterExpertsByMention<T extends { name: string }>(
  experts: T[],
  mentions: Set<string>
): T[] {
  return experts.filter(expert =>
    mentions.has(expert.name.toLowerCase())
  );
}

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
export function filterExpertsByRecentActivity<T extends { name: string }>(
  experts: T[],
  recentMessages: Array<{ type: string; display_name?: string }>,
  lookbackCount: number = 10
): T[] {
  // Collect names of experts who have been active
  const activeExpertNames = new Set<string>();
  const lastN = recentMessages.slice(-lookbackCount);

  for (const msg of lastN) {
    if (msg.type === 'ai' && msg.display_name) {
      activeExpertNames.add(msg.display_name);
    }
  }

  if (activeExpertNames.size === 0) {
    return [];
  }

  // Filter experts whose names appear in the active set
  return experts.filter(expert => {
    // For qualified names like "AgentName@userId", extract just the agent name
    const expertName = expert.name.includes(':')
      ? expert.name.split(':').pop()
      : expert.name;
    return expertName && activeExpertNames.has(expertName);
  });
}
