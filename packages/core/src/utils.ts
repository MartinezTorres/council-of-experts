/**
 * Utility functions
 */

import type { OpenAIFunction, Tool } from './types.js';

/**
 * Remove thinking tags from AI responses
 */
export function removeThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
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
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}
