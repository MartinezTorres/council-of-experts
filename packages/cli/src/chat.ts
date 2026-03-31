/**
 * Interactive chat loop for CLI
 */

import * as readline from 'readline';
import type { Council, ChatEvent, AgentDefinition } from 'council-of-experts';
import type { ChatHistory } from './tools.js';

export class ChatLoop {
  private rl: readline.Interface;
  private running: boolean = false;
  private councilId: string = 'cli-session';

  constructor(
    private council: Council,
    private chatHistory: ChatHistory,
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
    console.log(`Mode: ${this.council.getMode()}`);
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
      console.log(`Mode will change to '${newMode}' on next message.`);
      return;
    }

    if (cmd === '/status') {
      const status = await this.council.getStatus();
      console.log('\n' + '='.repeat(60));
      console.log('COUNCIL STATUS:');
      console.log('='.repeat(60));
      console.log(JSON.stringify(status, null, 2));
      console.log('='.repeat(60) + '\n');
      return;
    }

    if (cmd === '/messages') {
      const visibility = parts[1] as 'public' | 'private' | undefined;
      const messages = await this.council.getMessages({
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
      this.chatHistory.clear();
      console.log('Conversation history cleared.');
      return;
    }

    console.log(`Unknown command: ${command}`);
  }

  private async handleMessage(message: string): Promise<void> {
    // Add user message to history
    this.chatHistory.addMessage('user', 'User', message);

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

    console.log(`\nProcessing in ${this.council.getMode()} mode...\n`);

    try {
      // Call council.post
      const result = await this.council.post(event);

      // Display public messages
      if (result.publicMessages.length > 0) {
        console.log('=== Public Responses ===\n');
        for (const msg of result.publicMessages) {
          const agent = this.agents.find((a) => a.id === msg.author.id);
          const icon = agent?.metadata?.icon as string || '🤖';
          console.log(`${icon} ${msg.author.name}:`);
          console.log(msg.content);
          console.log('');

          // Add to chat history
          this.chatHistory.addMessage('agent', msg.author.name, msg.content);
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

      // Show mode changes
      if (result.nextMode && result.nextMode !== result.mode) {
        console.log(`\n[Mode changed from ${result.mode} to ${result.nextMode}]`);
      }
    } catch (error) {
      console.error('Error during council turn:', (error as Error).message);
    }
  }

  stop(): void {
    this.running = false;
    this.rl.close();
  }
}
