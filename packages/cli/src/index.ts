#!/usr/bin/env node

/**
 * Council of Experts CLI
 * Interactive chat interface demonstrating the council-of-experts library
 */

import { createCouncilModule } from 'council-of-experts';
import type { EngineAdapter } from 'council-of-experts';
import { ChatLoop } from './chat.js';
import { ChatHistory, CLIToolHost } from './tools.js';
import { loadConfig, getDefaultConfigPath, buildAgentDefinitions } from './config.js';
import { ChatCompletionsEngine } from './ChatCompletionsEngine.js';

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const configPath = args[0] || getDefaultConfigPath();

  console.log(`Loading config from: ${configPath}`);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    console.error('Error loading config:', (error as Error).message);
    console.error('\nUsage: council [config.json]');
    console.error('Or set COUNCIL_CONFIG environment variable');
    process.exit(1);
  }

  // Build agent definitions from config
  const agentDefinitions = buildAgentDefinitions(config);

  // Create engines map
  const engines: Record<string, EngineAdapter> = {};
  for (const engineConfig of config.engines) {
    engines[engineConfig.id] = new ChatCompletionsEngine(
      config.timeout_ms || 60000,
      config.max_tokens
    );
  }

  // Create chat history
  const chatHistory = new ChatHistory();

  // Build agent metadata map for tools
  const agentMetadata = new Map(
    agentDefinitions.map((a) => [
      a.id,
      {
        name: a.name,
        icon: a.metadata?.icon as string || '🤖',
        summary: a.summary,
      },
    ])
  );

  // Create tool host
  const toolHost = new CLIToolHost(chatHistory, agentMetadata);

  // Create council module
  const councilModule = createCouncilModule({
    agents: agentDefinitions,
    engines,
    toolHost,
  });

  console.log(`\nInitialized ${agentDefinitions.length} agents`);

  // Open council
  const council = await councilModule.openCouncil({
    councilId: 'cli-session',
    initialMode: 'open',
  });

  // Start chat loop
  const chat = new ChatLoop(council, chatHistory, agentDefinitions);
  await chat.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
