/**
 * Configuration loading for CLI.
 */

import path from 'path';
import {
  OpenAIChatCompletionsEngine,
  type AgentDefinition,
  resolveCouncilRuntimeConfig,
  type CouncilRuntimeConfig,
  type EngineAdapter,
  type EngineSpec,
  type ToolRef,
} from 'council-of-experts';
import { readFileSync } from 'fs';
import { getCLIToolDefinition } from './tools.js';

export interface CLIAgentEngineConfig {
  provider: string;
  model: string;
  contextWindow?: number;
  charsPerToken?: number;
  settings?: {
    api_key?: string;
    temperature?: number;
    [key: string]: unknown;
  };
  timeoutMs?: number;
}

export interface CLIAgentConfig {
  id: string;
  name: string;
  icon: string;
  summary: string;
  systemPrompt: string;
  tools?: ToolRef[];
  metadata?: Record<string, unknown>;
  engine: CLIAgentEngineConfig;
}

export interface CLIConfig {
  agents: CLIAgentConfig[];
  workspaceRoot?: string;
  runtime?: Partial<CouncilRuntimeConfig>;
}

export interface ResolvedCLIConfig {
  agents: CLIAgentConfig[];
  workspaceRoot: string;
  runtime: CouncilRuntimeConfig;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }

  throw new Error(`Invalid ${field}: expected a non-empty string`);
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

function validateAgent(
  agent: CLIAgentConfig,
  index: number
): CLIAgentConfig {
  const prefix = `agents[${index}]`;

  return {
    id: assertNonEmptyString(agent.id, `${prefix}.id`),
    name: assertNonEmptyString(agent.name, `${prefix}.name`),
    icon: assertNonEmptyString(agent.icon, `${prefix}.icon`),
    summary: assertNonEmptyString(agent.summary, `${prefix}.summary`),
    systemPrompt: assertNonEmptyString(
      agent.systemPrompt,
      `${prefix}.systemPrompt`
    ),
    tools: agent.tools,
    metadata: agent.metadata,
    engine: {
      provider: assertNonEmptyString(
        agent.engine?.provider,
        `${prefix}.engine.provider`
      ),
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

export function loadConfig(configPath: string): ResolvedCLIConfig {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as CLIConfig;

    if (!Array.isArray(config.agents) || config.agents.length === 0) {
      throw new Error('Config must contain at least one agent');
    }

    const agents = config.agents.map((agent, index) =>
      validateAgent(agent, index)
    );
    const seen = new Set<string>();
    for (const agent of agents) {
      if (seen.has(agent.id)) {
        throw new Error(`Duplicate agent id '${agent.id}' in config`);
      }
      seen.add(agent.id);
    }

    return {
      agents,
      workspaceRoot: path.resolve(
        path.dirname(configPath),
        config.workspaceRoot || '.'
      ),
      runtime: resolveCouncilRuntimeConfig(config.runtime),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw error;
  }
}

export function getDefaultConfigPath(): string {
  return process.env.COUNCIL_CONFIG || './config.json';
}

export function buildCouncilSetup(config: ResolvedCLIConfig): {
  agents: AgentDefinition[];
  engines: Record<string, EngineAdapter>;
} {
  const agents: AgentDefinition[] = [];
  const engines: Record<string, EngineAdapter> = {};

  for (const agent of config.agents) {
    const engineId = `cli:${agent.id}`;
    const engineSpec: EngineSpec = {
      id: engineId,
      provider: agent.engine.provider,
      model: agent.engine.model,
      contextWindow: agent.engine.contextWindow,
      charsPerToken: agent.engine.charsPerToken,
      settings: agent.engine.settings,
    };

    agents.push({
      id: agent.id,
      name: agent.name,
      engine: engineSpec,
      summary: agent.summary,
      systemPrompt: agent.systemPrompt,
      tools: normalizeToolRefs(agent.tools),
      metadata: {
        ...agent.metadata,
        icon: agent.icon,
      },
    });

    engines[engineId] = new OpenAIChatCompletionsEngine(
      agent.engine.timeoutMs ?? 60000
    );
  }

  return { agents, engines };
}

function normalizeToolRefs(tools?: ToolRef[]): ToolRef[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools
    .map((tool) => {
      if (typeof tool !== 'string') {
        return tool;
      }

      return getCLIToolDefinition(tool) ?? tool;
    })
    .filter((tool) => {
      return typeof tool === 'string' || tool.name.trim().length > 0;
    });
}
