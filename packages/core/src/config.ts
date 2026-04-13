import type {
  CouncilInstanceResolvedConfig,
  CouncilMode,
  CouncilModuleResolvedConfig,
  ResolvedCouncilPromptConfig,
  CouncilRuntimeConfig,
} from './types.js';

export const DEFAULT_COUNCIL_RUNTIME_CONFIG: CouncilRuntimeConfig = {
  initialMode: 'open',
  maxRounds: 3,
  agentSelectionStrategy: 'all_in_order',
  oracleSpeakerStrategy: 'first_active',
};

function assertCouncilMode(value: unknown, field: string): CouncilMode {
  if (value === 'open' || value === 'council' || value === 'oracle') {
    return value;
  }

  throw new Error(`Invalid ${field}: ${String(value)}`);
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a non-negative integer`);
}

function assertAgentSelectionStrategy(
  value: unknown,
  field: string
): CouncilRuntimeConfig['agentSelectionStrategy'] {
  if (value === 'all_in_order') {
    return value;
  }

  throw new Error(`Invalid ${field}: ${String(value)}`);
}

function assertOracleSpeakerStrategy(
  value: unknown,
  field: string
): CouncilRuntimeConfig['oracleSpeakerStrategy'] {
  if (value === 'first_active' || value === 'by_id') {
    return value;
  }

  throw new Error(`Invalid ${field}: ${String(value)}`);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a non-empty string`);
}

function snapshotRuntimeConfig(runtime: CouncilRuntimeConfig): CouncilRuntimeConfig {
  return {
    initialMode: runtime.initialMode,
    maxRounds: runtime.maxRounds,
    maxAgentReplies: runtime.maxAgentReplies,
    agentSelectionStrategy: runtime.agentSelectionStrategy,
    oracleSpeakerStrategy: runtime.oracleSpeakerStrategy,
    oracleSpeakerAgentId: runtime.oracleSpeakerAgentId,
  };
}

function snapshotPromptConfig(
  prompts: ResolvedCouncilPromptConfig
): ResolvedCouncilPromptConfig {
  return {
    councilModeSystemAddendum: prompts.councilModeSystemAddendum,
    oracleModeSystemAddendum: prompts.oracleModeSystemAddendum,
    councilSynthesisTemplate: prompts.councilSynthesisTemplate,
    oracleSynthesisTemplate: prompts.oracleSynthesisTemplate,
  };
}

export function resolveCouncilRuntimeConfig(
  input?: Partial<CouncilRuntimeConfig>
): CouncilRuntimeConfig {
  const oracleSpeakerStrategy =
    input?.oracleSpeakerStrategy === undefined
      ? DEFAULT_COUNCIL_RUNTIME_CONFIG.oracleSpeakerStrategy
      : assertOracleSpeakerStrategy(
          input.oracleSpeakerStrategy,
          'runtime.oracleSpeakerStrategy'
        );

  return {
    initialMode:
      input?.initialMode === undefined
        ? DEFAULT_COUNCIL_RUNTIME_CONFIG.initialMode
        : assertCouncilMode(input.initialMode, 'runtime.initialMode'),
    maxRounds:
      input?.maxRounds === undefined
        ? DEFAULT_COUNCIL_RUNTIME_CONFIG.maxRounds
        : assertNonNegativeInteger(input.maxRounds, 'runtime.maxRounds'),
    maxAgentReplies:
      input?.maxAgentReplies === undefined
        ? undefined
        : assertNonNegativeInteger(
            input.maxAgentReplies,
            'runtime.maxAgentReplies'
          ),
    agentSelectionStrategy:
      input?.agentSelectionStrategy === undefined
        ? DEFAULT_COUNCIL_RUNTIME_CONFIG.agentSelectionStrategy
        : assertAgentSelectionStrategy(
            input.agentSelectionStrategy,
            'runtime.agentSelectionStrategy'
          ),
    oracleSpeakerStrategy,
    oracleSpeakerAgentId:
      oracleSpeakerStrategy === 'by_id'
        ? assertNonEmptyString(
            input?.oracleSpeakerAgentId,
            'runtime.oracleSpeakerAgentId'
          )
        : input?.oracleSpeakerAgentId === undefined
          ? undefined
          : assertNonEmptyString(
              input.oracleSpeakerAgentId,
              'runtime.oracleSpeakerAgentId'
            ),
  };
}

export function createModuleConfigSnapshot(
  runtime: CouncilRuntimeConfig,
  prompts: ResolvedCouncilPromptConfig
): CouncilModuleResolvedConfig {
  return {
    runtime: snapshotRuntimeConfig(runtime),
    prompts: snapshotPromptConfig(prompts),
  };
}

export function createCouncilConfigSnapshot(input: {
  councilId: string;
  initialMode: CouncilMode;
  runtime: CouncilRuntimeConfig;
  prompts: ResolvedCouncilPromptConfig;
  metadata?: Record<string, unknown>;
}): CouncilInstanceResolvedConfig {
  return {
    councilId: input.councilId,
    initialMode: input.initialMode,
    runtime: snapshotRuntimeConfig(input.runtime),
    prompts: snapshotPromptConfig(input.prompts),
    metadata:
      input.metadata === undefined ? undefined : structuredClone(input.metadata),
  };
}
