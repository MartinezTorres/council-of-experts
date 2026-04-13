/**
 * Interactive chat loop for CLI
 */

import * as readline from 'readline';
import type { ChatEvent, AgentDefinition } from 'council-of-experts';
import { CouncilSession } from './session.js';

export class ChatLoop {
  private rl: readline.Interface;
  private running = false;

  constructor(
    private session: CouncilSession,
    private agents: AgentDefinition[]
  ) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });
  }

  async start(): Promise<void> {
    this.running = true;

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║       Council of Experts - Interactive CLI          ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    console.log(`Mode: ${this.session.getMode()}`);
    console.log('\nAgents available:');
    for (const agent of this.agents) {
      const icon = agent.metadata?.icon as string || '🤖';
      console.log(`  ${icon} ${agent.name} - ${agent.summary}`);
    }
    console.log('\nCommands:');
    console.log('  /mode <open|council|oracle>  - Change council mode');
    console.log('  /status                       - View council status');
    console.log('  /messages [public|private]    - View messages');
    console.log('  /clear                        - Clear conversation history');
    console.log('  /help                         - Show this help');
    console.log('  /quit                         - Exit\n');

    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const input = line.trim();

      if (!input) {
        this.rl.prompt();
        return;
      }

      // Handle commands
      if (input.startsWith('/')) {
        await this.handleCommand(input);
        this.rl.prompt();
        return;
      }

      // Regular message
      await this.handleMessage(input);
      this.rl.prompt();
    });

    this.rl.on('close', () => {
      this.running = false;
      console.log('\nGoodbye!');
      process.exit(0);
    });
  }

  private async handleCommand(command: string): Promise<void> {
    const parts = command.toLowerCase().split(/\s+/);
    const cmd = parts[0];

    if (cmd === '/quit' || cmd === '/exit') {
      this.rl.close();
      return;
    }

    if (cmd === '/help') {
      console.log('\nCommands:');
      console.log('  /mode <open|council|oracle>  - Change council mode');
      console.log('  /status                       - View council status');
      console.log('  /messages [public|private]    - View messages');
      console.log('  /clear                        - Clear conversation history');
      console.log('  /help                         - Show this help');
      console.log('  /quit                         - Exit');
      return;
    }

    if (cmd === '/mode') {
      const newMode = parts[1];
      if (newMode !== 'open' && newMode !== 'council' && newMode !== 'oracle') {
        console.log('Invalid mode. Use: open, council, or oracle');
        return;
      }
      this.session.setMode(newMode);
      console.log(`Mode changed to '${newMode}'.`);
      return;
    }

    if (cmd === '/status') {
      const status = await this.session.getStatus();
      console.log('\n' + '='.repeat(60));
      console.log('COUNCIL STATUS:');
      console.log('='.repeat(60));
      console.log(JSON.stringify(status, null, 2));
      console.log('='.repeat(60) + '\n');
      return;
    }

    if (cmd === '/messages') {
      const visibility = parts[1] as 'public' | 'private' | undefined;
      const messages = await this.session.getMessages({
        visibility: visibility || 'all',
      });
      console.log('\n' + '='.repeat(60));
      console.log(`MESSAGES (${visibility || 'all'}):`);
      console.log('='.repeat(60));
      for (const msg of messages) {
        console.log(
          `[${msg.visibility}] ${msg.author.name}: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`
        );
      }
      console.log('='.repeat(60) + '\n');
      return;
    }

    if (cmd === '/clear') {
      await this.session.reset();
      console.log('Session reset.');
      return;
    }

    console.log(`Unknown command: ${command}`);
  }

  private async handleMessage(message: string): Promise<void> {
    // Create chat event
    const event: ChatEvent = {
      actor: {
        type: 'user',
        id: 'cli-user',
        name: 'User',
      },
      content: message,
      timestamp: new Date().toISOString(),
    };

    console.log(`\nProcessing in ${this.session.getMode()} mode...\n`);

    try {
      const result = await this.session.post(event);

      // Display public messages
      if (result.publicMessages.length > 0) {
        console.log('=== Public Responses ===\n');
        for (const msg of result.publicMessages) {
          const agent = this.agents.find((a) => a.id === msg.author.id);
          const icon =
            msg.author.type === 'oracle'
              ? '🔮'
              : (agent?.metadata?.icon as string) || '🤖';
          console.log(`${icon} ${msg.author.name}:`);
          console.log(msg.content);
          console.log('');
        }
      }

      // Display private messages if any (for visibility)
      if (result.privateMessages.length > 0) {
        console.log('=== Private Deliberation (hidden from public) ===\n');
        for (const msg of result.privateMessages) {
          const agent = this.agents.find((a) => a.id === msg.author.id);
          const icon = agent?.metadata?.icon as string || '🔒';
          console.log(`${icon} ${msg.author.name} (private):`);
          console.log(msg.content);
          console.log('');
        }
      }

      if (result.publicMessages.length === 0 && result.privateMessages.length === 0) {
        console.log('(No responses from agents)');
      }

      if (result.errors.length > 0) {
        console.log('=== Turn Errors ===\n');
        for (const entry of result.errors) {
          const prefix = entry.agentId ? `[${entry.agentId}] ` : '';
          console.log(`${prefix}${this.renderTurnError(entry.error)}`);
        }
        console.log('');
      }
    } catch (error) {
      console.error('Error during council turn:', (error as Error).message);
    }
  }

  stop(): void {
    this.running = false;
    this.rl.close();
  }

  private renderTurnError(error: { code?: string; message: string }): string {
    if (error.code === 'agent_context_exhausted') {
      return "It's dizzy.";
    }

    return error.message;
  }
}
