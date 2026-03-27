#!/usr/bin/env node

/**
 * Council of Experts CLI
 * Interactive chat interface demonstrating the council-of-experts library
 */

import { CouncilOrchestrator } from 'council-of-experts';
import {
  MemoryDocumentProvider,
  MemorySettingsProvider,
  ConsoleLoggerProvider,
  ChatHistory
} from './providers.js';
import { createCLITools } from './tools.js';
import { ChatLoop } from './chat.js';
import { loadConfig, getDefaultConfigPath } from './config.js';

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

  // Initialize providers
  const documentProvider = new MemoryDocumentProvider(config.initial_document || '');
  const chatHistory = new ChatHistory();

  // Build model map
  const modelMap = new Map(config.models.map(m => [m.name, m]));

  const settingsProvider = new MemorySettingsProvider(
    modelMap,
    config.timeout_ms || 60000
  );

  const loggerProvider = new ConsoleLoggerProvider(config.verbose || false);

  // Initialize council orchestrator
  const council = new CouncilOrchestrator({
    documentProvider,
    settingsProvider,
    loggerProvider
    // No broadcaster for CLI (single-user)
  });

  // Build agent map
  const agentMap = new Map(
    config.agents.map((agent, index) => [
      `agent-${index}`,
      agent
    ])
  );

  // Create and register CLI tools
  const { tools, executors } = createCLITools(documentProvider, chatHistory, agentMap);

  for (const tool of tools) {
    const executor = executors.get(tool.name);
    if (executor) {
      council.registerTool(tool, executor);
    }
  }

  // Start chat loop
  const chat = new ChatLoop(council, chatHistory, agentMap);
  await chat.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
