/**
 * Configuration loading for CLI
 */

import type { AgentDefinition, EngineSpec, ToolRef } from 'council-of-experts';
import { readFileSync } from 'fs';
import { getCLIToolDefinition } from './tools.js';

/**
 * Engine configuration (maps to EngineSpec in contract)
 */
export interface EngineConfig {
  id: string;
  provider?: string;
  model: string;
  contextWindow: number;
  settings?: {
    api_key?: string;
    temperature?: number;
    [key: string]: unknown;
  };
}

/**
 * Agent configuration (maps to AgentDefinition in contract)
 */
export interface AgentConfig {
  id: string;
  name: string;
  icon: string;
  engine: string; // Reference to engine by ID
  summary: string;
  systemPrompt: string;
  tools?: ToolRef[];
  metadata?: Record<string, unknown>;
}

/**
 * CLI-specific configuration
 */
export interface CLIConfig {
  engines: EngineConfig[];
  agents: AgentConfig[];
  timeout_ms?: number;
  verbose?: boolean;
  workspaceRoot?: string;
}

/**
 * Load configuration from JSON file
 */
export function loadConfig(configPath: string): CLIConfig {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as CLIConfig;

    // Validate required fields
    if (!config.engines || config.engines.length === 0) {
      throw new Error('Config must contain at least one engine');
    }
    if (!config.agents || config.agents.length === 0) {
      throw new Error('Config must contain at least one agent');
    }

    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw error;
  }
}

/**
 * Get default config path
 */
export function getDefaultConfigPath(): string {
  return process.env.COUNCIL_CONFIG || './config.json';
}

/**
 * Convert CLI config to contract types
 */
export function buildAgentDefinitions(config: CLIConfig): AgentDefinition[] {
  const engineMap = new Map(config.engines.map((e) => [e.id, e]));

  return config.agents.map((agent) => {
    const engineConfig = engineMap.get(agent.engine);
    if (!engineConfig) {
      throw new Error(`Engine '${agent.engine}' not found for agent ${agent.name}`);
    }

    const engineSpec: EngineSpec = {
      id: engineConfig.id,
      provider: engineConfig.provider,
      model: engineConfig.model,
      contextWindow: engineConfig.contextWindow,
      settings: engineConfig.settings,
    };

    return {
      id: agent.id,
      name: agent.name,
      engine: engineSpec,
      modelName: engineConfig.model,
      summary: agent.summary,
      systemPrompt: agent.systemPrompt,
      tools: normalizeToolRefs(agent.tools),
      metadata: {
        ...agent.metadata,
        icon: agent.icon,
      },
    };
  });
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
