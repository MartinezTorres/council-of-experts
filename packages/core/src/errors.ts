import type { CouncilError } from './types.js';

export interface AgentContextExhaustedData {
  reason: 'uncontrolled_fixed_inputs_exceed_prompt_budget';
  promptBudgetTokens: number;
  uncontrolledFixedTokens: number;
  sections: Array<{
    id: string;
    kind: string;
    estimatedChars: number;
    estimatedTokens?: number;
  }>;
}

export class AgentContextExhaustedError extends Error {
  readonly code = 'agent_context_exhausted';
  readonly data: AgentContextExhaustedData;

  constructor(message: string, data: AgentContextExhaustedData) {
    super(message);
    this.name = 'AgentContextExhaustedError';
    this.data = data;
  }

  toCouncilError(): CouncilError {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}

export function isAgentContextExhaustedError(
  value: unknown
): value is AgentContextExhaustedError {
  return value instanceof AgentContextExhaustedError;
}
