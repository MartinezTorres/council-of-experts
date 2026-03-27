/**
 * Interactive chat loop for CLI
 */

import * as readline from 'readline';
import type { CouncilOrchestrator, Expert } from 'council-of-experts';
import { parseMentions } from 'council-of-experts';
import type { ChatHistory } from './providers.js';
import type { AgentConfig } from './config.js';

export class ChatLoop {
  private rl: readline.Interface;
  private running: boolean = false;

  constructor(
    private council: CouncilOrchestrator,
    private chatHistory: ChatHistory,
    private agents: Map<string, AgentConfig>,
    private documentId: string = 'main'
  ) {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });
  }

  async start(): Promise<void> {
    this.running = true;

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║       Council of Experts - Interactive CLI          ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');
    console.log('Agents available:');
    for (const agent of this.agents.values()) {
      console.log(`  ${agent.icon} ${agent.name} - ${agent.purpose}`);
    }
    console.log('\nCommands:');
    console.log('  @AgentName message    - Mention an agent');
    console.log('  /doc                  - View current document');
    console.log('  /clear                - Clear conversation history');
    console.log('  /help                 - Show this help');
    console.log('  /quit                 - Exit\n');

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
    const cmd = command.toLowerCase();

    if (cmd === '/quit' || cmd === '/exit') {
      this.rl.close();
      return;
    }

    if (cmd === '/help') {
      console.log('\nCommands:');
      console.log('  @AgentName message    - Mention an agent to invoke them');
      console.log('  /doc                  - View current document');
      console.log('  /clear                - Clear conversation history');
      console.log('  /help                 - Show this help');
      console.log('  /quit                 - Exit');
      return;
    }

    if (cmd === '/doc') {
      const doc = await this.council['documentProvider'].getDocument(this.documentId);
      console.log('\n' + '='.repeat(60));
      console.log('CURRENT DOCUMENT:');
      console.log('='.repeat(60));
      console.log(doc.content || '(empty)');
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

    // Parse mentions
    const mentions = parseMentions(message);

    if (mentions.size === 0) {
      console.log('(No agents mentioned. Use @AgentName to invoke agents)');
      return;
    }

    // Find mentioned agents
    const mentionedAgents: Expert[] = [];
    for (const mention of mentions) {
      for (const [userId, agentConfig] of this.agents.entries()) {
        if (agentConfig.name.toLowerCase() === mention.toLowerCase()) {
          mentionedAgents.push({
            userId,
            name: agentConfig.name,
            icon: agentConfig.icon,
            systemPrompt: agentConfig.system_prompt,
            model: agentConfig.model,
            temperature: agentConfig.temperature
          });
          break;
        }
      }
    }

    if (mentionedAgents.length === 0) {
      console.log('(No matching agents found)');
      return;
    }

    console.log(`Invoking: ${mentionedAgents.map(a => `${a.icon} ${a.name}`).join(', ')}...\n`);

    // Set up response handler to display agent messages
    const responseHandler = async (response: any) => {
      const agentConfig = this.agents.get(response.expertUserId);
      if (agentConfig) {
        console.log(`\n${agentConfig.icon} ${agentConfig.name}:`);
        console.log(response.message);
        console.log('');

        // Add to history
        this.chatHistory.addMessage('agent', agentConfig.name, response.message);
      }
    };

    // Temporarily set response handler
    const originalHandler = (this.council as any).responseCallback;
    this.council.onResponse(responseHandler);

    try {
      // Get chat context
      const chatContext = this.chatHistory.getFormattedHistory(10);
      const doc = await this.council['documentProvider'].getDocument(this.documentId);

      // Orchestrate
      await this.council.orchestrate(
        this.documentId,
        message,
        'user',
        mentionedAgents,
        {
          documentContent: doc.content,
          chatHistory: chatContext
        }
      );
    } catch (error) {
      console.error('Error during orchestration:', (error as Error).message);
    } finally {
      // Restore original handler
      if (originalHandler) {
        this.council.onResponse(originalHandler);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.rl.close();
  }
}
