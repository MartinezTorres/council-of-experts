#!/usr/bin/env node

import path from 'path';
import { CouncilOpenAIProviderApp } from './app.js';

function getDefaultConfigPath(): string {
  return process.env.COUNCIL_OPENAI_PROVIDER_CONFIG || './config.json';
}

async function main() {
  const args = process.argv.slice(2);
  const configPath = path.resolve(args[0] || getDefaultConfigPath());
  const app = CouncilOpenAIProviderApp.fromConfigPath(configPath);
  await app.listen();

  console.log(
    `Council OpenAI Provider listening on http://${app.config.server.host}:${app.config.server.port}`
  );
  console.log(`Loaded virtual models: ${Object.keys(app.config.virtualModels).join(', ')}`);
  console.log(`Debug endpoints: ${app.config.debug.enabled ? 'enabled' : 'disabled'}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
