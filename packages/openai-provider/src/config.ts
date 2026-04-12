import { readFileSync, statSync } from 'fs';
import path from 'path';
import { resolveCouncilRuntimeConfig } from 'council-of-experts';
import type {
  ProviderAgentDocumentConfig,
  ProviderAgentConfig,
  ProviderConfig,
  ResolvedProviderAgentConfig,
  ResolvedProviderAgentDocumentConfig,
  ResolvedProviderConfig,
  ResolvedVirtualModelConfig,
} from './types.js';

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a non-empty string`);
}

function assertPort(value: unknown, field: string): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 65535
  ) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected an integer between 1 and 65535`);
}

function assertNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a non-negative integer`);
}

function assertPositiveNumber(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a positive number`);
}

function resolveDocument(
  configDir: string,
  modelId: string,
  agentId: string,
  document: ProviderAgentDocumentConfig,
  index: number
): ResolvedProviderAgentDocumentConfig {
  const prefix = `virtualModels.${modelId}.agents.${agentId}.documents[${index}]`;
  const documentPath = assertNonEmptyString(document.path, `${prefix}.path`);
  const absolutePath = path.resolve(configDir, documentPath);

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    throw new Error(
      `Invalid ${prefix}.path: document not found at ${absolutePath}`
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      `Invalid ${prefix}.path: expected a file at ${absolutePath}`
    );
  }

  return {
    path: documentPath,
    description:
      document.description === undefined
        ? undefined
        : assertNonEmptyString(document.description, `${prefix}.description`),
    absolutePath,
  };
}

function validateAgent(
  configDir: string,
  modelId: string,
  agent: ProviderAgentConfig,
  index: number
): ResolvedProviderAgentConfig {
  const prefix = `virtualModels.${modelId}.agents[${index}]`;
  const agentId = assertNonEmptyString(agent.id, `${prefix}.id`);
  if (agent.documents !== undefined && !Array.isArray(agent.documents)) {
    throw new Error(`Invalid ${prefix}.documents: expected an array`);
  }
  const documents =
    agent.documents?.map((document, documentIndex) =>
      resolveDocument(configDir, modelId, agentId, document, documentIndex)
    ) ?? [];
  const seenDocumentPaths = new Set<string>();
  for (const document of documents) {
    if (seenDocumentPaths.has(document.path)) {
      throw new Error(
        `Duplicate document path '${document.path}' in ${prefix}.documents`
      );
    }
    seenDocumentPaths.add(document.path);
  }

  return {
    id: agentId,
    name: assertNonEmptyString(agent.name, `${prefix}.name`),
    summary: assertNonEmptyString(agent.summary, `${prefix}.summary`),
    systemPrompt: assertNonEmptyString(
      agent.systemPrompt,
      `${prefix}.systemPrompt`
    ),
    tools: agent.tools,
    documents: documents.length > 0 ? documents : undefined,
    metadata: agent.metadata,
    engine: {
      provider: assertNonEmptyString(agent.engine?.provider, `${prefix}.engine.provider`),
      model: assertNonEmptyString(agent.engine?.model, `${prefix}.engine.model`),
      contextWindow:
        agent.engine?.contextWindow === undefined
          ? undefined
          : assertNonNegativeInteger(
              agent.engine.contextWindow,
              `${prefix}.engine.contextWindow`
            ),
      charsPerToken:
        agent.engine?.charsPerToken === undefined
          ? undefined
          : assertPositiveNumber(
              agent.engine.charsPerToken,
              `${prefix}.engine.charsPerToken`
            ),
      settings: agent.engine?.settings,
      timeoutMs:
        agent.engine?.timeoutMs === undefined
          ? undefined
          : assertNonNegativeInteger(
              agent.engine.timeoutMs,
              `${prefix}.engine.timeoutMs`
            ),
    },
  };
}

function validateVirtualModel(
  configDir: string,
  modelId: string,
  config: ProviderConfig['virtualModels'][string]
): ResolvedVirtualModelConfig {
  if (!config || typeof config !== 'object') {
    throw new Error(`Invalid virtualModels.${modelId}: expected an object`);
  }

  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new Error(`virtualModels.${modelId} must contain at least one agent`);
  }

  const agents = config.agents.map((agent, index) =>
    validateAgent(configDir, modelId, agent, index)
  );
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) {
      throw new Error(`Duplicate agent id '${agent.id}' in virtualModels.${modelId}`);
    }
    seen.add(agent.id);
  }

  return {
    id: modelId,
    description:
      config.description === undefined
        ? undefined
        : assertNonEmptyString(config.description, `virtualModels.${modelId}.description`),
    runtime: resolveCouncilRuntimeConfig(config.runtime),
    agents,
  };
}

export function loadConfig(configPath: string): ResolvedProviderConfig {
  const content = readFileSync(configPath, 'utf-8');
  const raw = JSON.parse(content) as ProviderConfig;
  const configDir = path.dirname(configPath);

  if (!raw.virtualModels || typeof raw.virtualModels !== 'object') {
    throw new Error('Config must contain virtualModels');
  }

  const entries = Object.entries(raw.virtualModels);
  if (entries.length === 0) {
    throw new Error('Config must contain at least one virtual model');
  }

  const virtualModels = Object.fromEntries(
    entries.map(([modelId, modelConfig]) => [
      assertNonEmptyString(modelId, 'virtual model id'),
      validateVirtualModel(configDir, modelId, modelConfig),
    ])
  );

  return {
    server: {
      host:
        raw.server?.host === undefined
          ? '127.0.0.1'
          : assertNonEmptyString(raw.server.host, 'server.host'),
      port:
        raw.server?.port === undefined
          ? 8787
          : assertPort(raw.server.port, 'server.port'),
      apiKeys:
        raw.server?.apiKeys?.map((key, index) =>
          assertNonEmptyString(key, `server.apiKeys[${index}]`)
        ) ?? [],
    },
    debug: {
      enabled: raw.debug?.enabled ?? false,
    },
    virtualModels,
  };
}
