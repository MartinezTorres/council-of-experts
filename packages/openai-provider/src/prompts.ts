import type {
  ProviderPromptConfig,
  ResolvedProviderPromptConfig,
} from './types.js';

export const DEFAULT_PROVIDER_PROMPTS: ResolvedProviderPromptConfig = {
  requestInstruction:
    'Produce exactly the next assistant reply for the provided chat history. Do not mention hidden deliberation, councils, or internal agents.',
  oraclePreparationTemplate: `You are the Oracle, speaking with one unified voice for the council.
The original chat history is provided separately.
Prepare the best possible assistant response for that chat history.
{{localDocumentsInstruction}}
Do not call client-visible tools in this step.
Do not mention hidden deliberation or internal agents.

Private deliberation from council members:
{{privateDeliberation}}`,
  oracleExternalSynthesisTemplate: `You are the Oracle, speaking with one unified voice for the council.
The original chat history is provided separately.
Produce the single best next assistant action for that chat history.
If client-visible tools are available and necessary, you may call them.
Do not mention hidden deliberation or internal agents.

Private deliberation from council members:
{{privateDeliberation}}

Preparation draft:
{{draftContent}}`,
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

function renderTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '';
  });
}

function buildPrivateDeliberation(
  privateMessages: Array<{ author: { name: string }; content: string }>
): string {
  return privateMessages.length === 0
    ? '(no private deliberation)'
    : privateMessages
        .map((message) => `${message.author.name}: ${message.content}`)
        .join('\n\n');
}

export function resolveProviderPromptConfig(
  input?: ProviderPromptConfig
): ResolvedProviderPromptConfig {
  return {
    requestInstruction:
      assertOptionalString(input?.requestInstruction, 'prompts.requestInstruction') ??
      DEFAULT_PROVIDER_PROMPTS.requestInstruction,
    oraclePreparationTemplate:
      assertOptionalString(
        input?.oraclePreparationTemplate,
        'prompts.oraclePreparationTemplate'
      ) ?? DEFAULT_PROVIDER_PROMPTS.oraclePreparationTemplate,
    oracleExternalSynthesisTemplate:
      assertOptionalString(
        input?.oracleExternalSynthesisTemplate,
        'prompts.oracleExternalSynthesisTemplate'
      ) ?? DEFAULT_PROVIDER_PROMPTS.oracleExternalSynthesisTemplate,
  };
}

export function buildProviderRequestInstruction(
  prompts?: ResolvedProviderPromptConfig
): string {
  return (prompts ?? DEFAULT_PROVIDER_PROMPTS).requestInstruction;
}

export function buildOraclePreparationPrompt(input: {
  privateMessages: Array<{ author: { name: string }; content: string }>;
  hasLocalDocuments: boolean;
  prompts?: ResolvedProviderPromptConfig;
}): string {
  const prompts = input.prompts ?? DEFAULT_PROVIDER_PROMPTS;
  return renderTemplate(prompts.oraclePreparationTemplate, {
    localDocumentsInstruction: input.hasLocalDocuments
      ? 'If you need one of your assigned documents, call vault.read(path) with the exact path.'
      : 'No local documents are available in this step.',
    privateDeliberation: buildPrivateDeliberation(input.privateMessages),
  });
}

export function buildOracleExternalSynthesisPrompt(input: {
  privateMessages: Array<{ author: { name: string }; content: string }>;
  draftContent?: string;
  prompts?: ResolvedProviderPromptConfig;
}): string {
  const prompts = input.prompts ?? DEFAULT_PROVIDER_PROMPTS;
  return renderTemplate(prompts.oracleExternalSynthesisTemplate, {
    privateDeliberation: buildPrivateDeliberation(input.privateMessages),
    draftContent:
      input.draftContent && input.draftContent.trim().length > 0
        ? input.draftContent
        : '(no draft)',
  });
}
