import type {
  AgentDefinition,
  CouncilMode,
  CouncilPromptConfig,
  ResolvedCouncilPromptConfig,
} from './types.js';

export const DEFAULT_COUNCIL_PROMPTS: ResolvedCouncilPromptConfig = {
  councilModeSystemAddendum:
    'You are in council mode. Deliberate carefully with other agents.',
  oracleModeSystemAddendum:
    'You are in oracle mode. You are part of a unified council voice.',
  councilSynthesisTemplate: `Based on the council's private deliberation, formulate your public response.

Private thoughts from council:
{{privateThoughts}}

Your public response (or say nothing if you have nothing to add):`,
  oracleSynthesisTemplate: `You are the Oracle, speaking with one unified voice for the council.

Private deliberation from council members:
{{privateThoughts}}

Synthesize a single, unified response that represents the council's collective wisdom:`,
};

function assertOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a non-empty string`);
}

function formatPrivateThoughts(
  privateThoughts: Array<{ agent: AgentDefinition; content: string }>
): string {
  return privateThoughts.map((thought) => `${thought.agent.name}: ${thought.content}`).join('\n\n');
}

function renderTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '';
  });
}

export function resolveCouncilPromptConfig(
  input?: Partial<CouncilPromptConfig>
): ResolvedCouncilPromptConfig {
  return {
    councilModeSystemAddendum:
      assertOptionalString(
        input?.councilModeSystemAddendum,
        'prompts.councilModeSystemAddendum'
      ) ?? DEFAULT_COUNCIL_PROMPTS.councilModeSystemAddendum,
    oracleModeSystemAddendum:
      assertOptionalString(
        input?.oracleModeSystemAddendum,
        'prompts.oracleModeSystemAddendum'
      ) ?? DEFAULT_COUNCIL_PROMPTS.oracleModeSystemAddendum,
    councilSynthesisTemplate:
      assertOptionalString(
        input?.councilSynthesisTemplate,
        'prompts.councilSynthesisTemplate'
      ) ?? DEFAULT_COUNCIL_PROMPTS.councilSynthesisTemplate,
    oracleSynthesisTemplate:
      assertOptionalString(
        input?.oracleSynthesisTemplate,
        'prompts.oracleSynthesisTemplate'
      ) ?? DEFAULT_COUNCIL_PROMPTS.oracleSynthesisTemplate,
  };
}

export function buildModeSystemPrompt(input: {
  systemPrompt: string;
  mode: CouncilMode;
  prompts?: ResolvedCouncilPromptConfig;
}): string {
  const prompts = input.prompts ?? DEFAULT_COUNCIL_PROMPTS;

  if (input.mode === 'council') {
    return `${input.systemPrompt}\n\n${prompts.councilModeSystemAddendum}`;
  }

  if (input.mode === 'oracle') {
    return `${input.systemPrompt}\n\n${prompts.oracleModeSystemAddendum}`;
  }

  return input.systemPrompt;
}

export function buildCouncilSynthesisPrompt(
  privateThoughts: Array<{ agent: AgentDefinition; content: string }>,
  prompts?: ResolvedCouncilPromptConfig
): string {
  const effectivePrompts = prompts ?? DEFAULT_COUNCIL_PROMPTS;
  return renderTemplate(effectivePrompts.councilSynthesisTemplate, {
    privateThoughts: formatPrivateThoughts(privateThoughts),
  });
}

export function buildOracleSynthesisPrompt(
  privateThoughts: Array<{ agent: AgentDefinition; content: string }>,
  prompts?: ResolvedCouncilPromptConfig
): string {
  const effectivePrompts = prompts ?? DEFAULT_COUNCIL_PROMPTS;
  return renderTemplate(effectivePrompts.oracleSynthesisTemplate, {
    privateThoughts: formatPrivateThoughts(privateThoughts),
  });
}
