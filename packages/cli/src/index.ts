#!/usr/bin/env node

/**
 * Council of Experts CLI
 * Interactive chat interface demonstrating the council-of-experts library
 */

import path from 'path';
import { createCouncilModule } from 'council-of-experts';
import { ChatLoop } from './chat.js';
import { CLIToolHost } from './tools.js';
import { buildCouncilSetup, loadConfig, getDefaultConfigPath } from './config.js';
import { CouncilSession } from './session.js';

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const configPath = path.resolve(args[0] || getDefaultConfigPath());

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

  const { agents: agentDefinitions, engines } = buildCouncilSetup(config);

  // Create tool host
  const toolHost = new CLIToolHost(config.workspaceRoot);

  // Create council module
  const councilModule = createCouncilModule({
    agents: agentDefinitions,
    engines,
    toolHost,
    runtime: config.runtime,
  });

  console.log(`\nInitialized ${agentDefinitions.length} agents`);

  const session = new CouncilSession(
    councilModule,
    config.runtime.initialMode
  );
  await session.initialize();

  // Start chat loop
  const chat = new ChatLoop(session, agentDefinitions);
  await chat.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
