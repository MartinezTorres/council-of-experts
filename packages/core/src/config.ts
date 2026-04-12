import type {
  CouncilInstanceResolvedConfig,
  CouncilMode,
  CouncilModuleResolvedConfig,
  CouncilRuntimeConfig,
} from './types.js';

export const DEFAULT_COUNCIL_RUNTIME_CONFIG: CouncilRuntimeConfig = {
  initialMode: 'open',
  maxRounds: 3,
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

function snapshotRuntimeConfig(runtime: CouncilRuntimeConfig): CouncilRuntimeConfig {
  return {
    initialMode: runtime.initialMode,
    maxRounds: runtime.maxRounds,
    maxAgentReplies: runtime.maxAgentReplies,
  };
}

export function resolveCouncilRuntimeConfig(
  input?: Partial<CouncilRuntimeConfig>
): CouncilRuntimeConfig {
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
  };
}

export function createModuleConfigSnapshot(
  runtime: CouncilRuntimeConfig
): CouncilModuleResolvedConfig {
  return {
    runtime: snapshotRuntimeConfig(runtime),
  };
}

export function createCouncilConfigSnapshot(input: {
  councilId: string;
  initialMode: CouncilMode;
  runtime: CouncilRuntimeConfig;
  metadata?: Record<string, unknown>;
}): CouncilInstanceResolvedConfig {
  return {
    councilId: input.councilId,
    initialMode: input.initialMode,
    runtime: snapshotRuntimeConfig(input.runtime),
    metadata:
      input.metadata === undefined ? undefined : structuredClone(input.metadata),
  };
}
