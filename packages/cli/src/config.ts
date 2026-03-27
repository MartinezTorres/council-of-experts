/**
 * Configuration loading for CLI
 */

import type { AIModel } from 'council-of-experts';
import { readFileSync } from 'fs';

export interface AgentConfig {
  name: string;
  icon: string;
  purpose: string;
  system_prompt: string;
  model: string;
  temperature: number;
}

export interface CLIConfig {
  models: AIModel[];
  agents: AgentConfig[];
  timeout_ms?: number;
  verbose?: boolean;
  initial_document?: string;
}

/**
 * Load configuration from JSON file
 */
export function loadConfig(configPath: string): CLIConfig {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as CLIConfig;

    // Validate required fields
    if (!config.models || config.models.length === 0) {
      throw new Error('Config must contain at least one model');
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
