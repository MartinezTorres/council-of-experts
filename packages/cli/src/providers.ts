/**
 * In-memory provider implementations for CLI
 * Ephemeral storage - data lost when CLI exits
 */

import type {
  DocumentProvider,
  SettingsProvider,
  LoggerProvider,
  Document,
  SuggestionResult,
  Attachment,
  AIModel
} from 'council-of-experts';

/**
 * In-memory document storage
 */
export class MemoryDocumentProvider implements DocumentProvider {
  private documents: Map<string, { content: string; version: number }> = new Map();

  constructor(initialContent: string = '') {
    // Create default document
    this.documents.set('main', { content: initialContent, version: 1 });
  }

  async getDocument(id: string): Promise<Document> {
    const doc = this.documents.get(id) || { content: '', version: 1 };
    return {
      id,
      content: doc.content,
      version: doc.version,
      attachments: []
    };
  }

  async createSuggestion(
    documentId: string,
    content: string,
    baseVersion: number,
    userId: string
  ): Promise<SuggestionResult> {
    // For CLI, just directly apply the suggestion
    const doc = this.documents.get(documentId) || { content: '', version: 1 };
    this.documents.set(documentId, {
      content,
      version: doc.version + 1
    });

    return {
      id: `suggestion-${Date.now()}`,
      created_by: userId,
      created_at: new Date().toISOString(),
      base_version: baseVersion
    };
  }

  async getAttachment(_documentId: string, _attachmentId: string): Promise<Attachment | null> {
    // No attachments in CLI for now
    return null;
  }

  // CLI-specific helpers
  updateDocument(id: string, content: string): void {
    const doc = this.documents.get(id) || { content: '', version: 1 };
    this.documents.set(id, {
      content,
      version: doc.version + 1
    });
  }

  getDocumentSync(id: string): string {
    return this.documents.get(id)?.content || '';
  }
}

/**
 * In-memory settings storage
 */
export class MemorySettingsProvider implements SettingsProvider {
  private settings: Map<string, any> = new Map();

  constructor(
    private models: Map<string, AIModel>,
    timeoutMs: number = 60000,
    summarizationModel?: string,
    chatSystemPrompt?: string
  ) {
    // Initialize default settings
    this.settings.set('ai_timeout_ms', timeoutMs);
    if (summarizationModel) {
      this.settings.set('summarization_model', summarizationModel);
    }
    if (chatSystemPrompt) {
      this.settings.set('chat_system_prompt', chatSystemPrompt);
    }
  }

  async getModel(modelName: string): Promise<AIModel | null> {
    return this.models.get(modelName) || null;
  }

  async getSetting<T>(key: string, defaultValue?: T): Promise<T> {
    const value = this.settings.get(key);
    return (value !== undefined ? value : defaultValue) as T;
  }
}

/**
 * Console logger
 */
export class ConsoleLoggerProvider implements LoggerProvider {
  private verbose: boolean;

  constructor(verbose: boolean = false) {
    this.verbose = verbose;
  }

  async logOperation(operation: string, userId: string, metadata?: any): Promise<void> {
    if (this.verbose) {
      console.log(`[${operation}] by ${userId}`, metadata ? JSON.stringify(metadata) : '');
    }
  }

  async logError(operation: string, error: Error): Promise<void> {
    console.error(`[ERROR] ${operation}:`, error.message);
  }
}

/**
 * Chat message storage
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
      timestamp: new Date().toISOString()
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
      .map(m => `${m.name}: ${m.content}`)
      .join('\n');
  }

  clear(): void {
    this.messages = [];
  }
}
