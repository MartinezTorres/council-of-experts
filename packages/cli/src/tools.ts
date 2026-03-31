/**
 * CLI ToolHost implementation
 */

import type { ToolHost, ToolCall, ToolResult, ToolExecutionContext } from 'council-of-experts';

/**
 * Simple in-memory document store for CLI
 */
class DocumentStore {
  private documents = new Map<string, string>();

  get(councilId: string): string {
    return this.documents.get(councilId) || '';
  }

  set(councilId: string, content: string): void {
    this.documents.set(councilId, content);
  }
}

/**
 * Simple chat history store for CLI
 */
export interface ChatMessage {
  role: 'user' | 'agent';
  name: string;
  content: string;
  timestamp: string;
}

export class ChatHistory {
  private messages: ChatMessage[] = [];

  addMessage(role: 'user' | 'agent', name: string, content: string): void {
    this.messages.push({
      role,
      name,
      content,
      timestamp: new Date().toISOString(),
    });
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  getRecentMessages(count: number): ChatMessage[] {
    return this.messages.slice(-count);
  }

  getFormattedHistory(count: number = 10): string {
    return this.getRecentMessages(count)
      .map((m) => `${m.name}: ${m.content}`)
      .join('\n');
  }

  clear(): void {
    this.messages = [];
  }
}

/**
 * ToolHost implementation for CLI
 */
export class CLIToolHost implements ToolHost {
  private documentStore = new DocumentStore();

  constructor(
    private chatHistory: ChatHistory,
    private agentMetadata: Map<string, { name: string; icon: string; summary: string }>
  ) {}

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'read_document':
          return this.readDocument(ctx);

        case 'write_document':
          return this.writeDocument(call, ctx);

        case 'list_participants':
          return this.listParticipants();

        case 'get_context':
          return this.getContext(call);

        case 'my_role':
          return this.myRole(ctx);

        default:
          return {
            ok: false,
            error: `Unknown tool: ${call.name}`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private readDocument(ctx: ToolExecutionContext): ToolResult {
    const content = this.documentStore.get(ctx.councilId);
    return {
      ok: true,
      content: content || '(empty document)',
    };
  }

  private writeDocument(call: ToolCall, ctx: ToolExecutionContext): ToolResult {
    const content = call.args?.content as string;
    if (!content || typeof content !== 'string') {
      return {
        ok: false,
        error: 'Missing required argument: content (string)',
      };
    }

    this.documentStore.set(ctx.councilId, content);
    return {
      ok: true,
      content: `Document updated (${content.length} characters)`,
    };
  }

  private listParticipants(): ToolResult {
    const participants = Array.from(this.agentMetadata.values())
      .map((a) => `${a.icon} ${a.name}: ${a.summary}`)
      .join('\n');

    return {
      ok: true,
      content: participants || '(no agents configured)',
    };
  }

  private getContext(call: ToolCall): ToolResult {
    const count = (call.args?.count as number) || 5;
    const history = this.chatHistory.getFormattedHistory(count);

    return {
      ok: true,
      content: history || '(no conversation history)',
    };
  }

  private myRole(ctx: ToolExecutionContext): ToolResult {
    const agent = this.agentMetadata.get(ctx.agentId);
    if (!agent) {
      return {
        ok: false,
        error: 'Unknown agent',
      };
    }

    return {
      ok: true,
      content: `You are ${agent.icon} ${agent.name}. Your role: ${agent.summary}`,
    };
  }
}
