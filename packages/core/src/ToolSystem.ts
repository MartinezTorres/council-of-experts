/**
 * Tool System - Built-in and custom tool execution
 */

import type {
  Tool,
  ToolExecutor,
  ToolExecutionContext,
  ToolResult,
  DocumentProvider,
  EventBroadcaster,
  SettingsProvider
} from './types.js';
import { toOpenAIFunction, estimateTokens } from './utils.js';
import { AIClient } from './AIClient.js';
import { LARGE_ATTACHMENT_THRESHOLD_TOKENS, ANALYSIS_MAX_TOKENS } from './constants.js';

export class ToolSystem {
  private tools: Map<string, Tool> = new Map();
  private executors: Map<string, ToolExecutor> = new Map();

  constructor(
    private documentProvider: DocumentProvider,
    private settingsProvider: SettingsProvider,
    private aiClient: AIClient,
    private broadcaster?: EventBroadcaster
  ) {
    this.registerBuiltInTools();
  }

  /**
   * Register a custom tool
   */
  registerTool(tool: Tool, executor: ToolExecutor): void {
    this.tools.set(tool.name, tool);
    this.executors.set(tool.name, executor);
  }

  /**
   * Execute a tool
   */
  async executeTool(
    name: string,
    args: Record<string, any>,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const executor = this.executors.get(name);
    if (!executor) {
      return {
        tool: name,
        result: `Unknown tool: ${name}`,
        success: false
      };
    }

    try {
      return await executor(args, context);
    } catch (error) {
      return {
        tool: name,
        result: `Error: ${(error as Error).message}`,
        success: false
      };
    }
  }

  /**
   * Get all tools in OpenAI format
   */
  getOpenAITools(): Array<ReturnType<typeof toOpenAIFunction>> {
    return Array.from(this.tools.values()).map(toOpenAIFunction);
  }

  /**
   * Get tool by name
   */
  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  private registerBuiltInTools(): void {
    // Tool: get_attachment
    this.registerTool(
      {
        name: 'get_attachment',
        description: 'Get the content of an attachment by its ID',
        parameters: {
          attachment_id: { type: 'string', description: 'The attachment ID', required: true }
        },
        needsProcessing: true
      },
      async (args, ctx) => {
        const attachment = await this.documentProvider.getAttachment(ctx.documentId, args.attachment_id);

        if (!attachment) {
          return {
            tool: 'get_attachment',
            result: `Attachment ${args.attachment_id} not found`,
            success: false
          };
        }

        const fileContents = attachment.files.map(file => {
          if (file.data) {
            if (file.mime_type.startsWith('text/') || file.mime_type === 'application/json') {
              return `--- ${file.filename} ---\n${file.data.toString('utf-8')}`;
            } else {
              return `--- ${file.filename} (${file.mime_type}, ${file.size} bytes) ---\n[Binary file]`;
            }
          }
          return `[File ${file.filename} not available]`;
        }).join('\n\n');

        return {
          tool: 'get_attachment',
          result: `Attachment ${args.attachment_id}: ${attachment.description || 'No description'}\n\n${fileContents}`,
          success: true
        };
      }
    );

    // Tool: list_attachments
    this.registerTool(
      {
        name: 'list_attachments',
        description: 'List all available attachments',
        parameters: {},
        needsProcessing: true
      },
      async (_args, ctx) => {
        const doc = await this.documentProvider.getDocument(ctx.documentId);
        const attachments = doc.attachments || [];

        if (attachments.length === 0) {
          return {
            tool: 'list_attachments',
            result: 'No attachments available',
            success: true
          };
        }

        const list = attachments.map(a => {
          const fileNames = a.files.map(f => f.filename).join(', ');
          return `- ${a.id} (${a.type}): ${a.description || 'No description'} - Files: ${fileNames}`;
        }).join('\n');

        return {
          tool: 'list_attachments',
          result: `Available attachments:\n${list}`,
          success: true
        };
      }
    );

    // Tool: suggest_edit
    this.registerTool(
      {
        name: 'suggest_edit',
        description: 'Suggest a content edit',
        parameters: {
          new_content: { type: 'string', description: 'The new content to suggest', required: true },
          reason: { type: 'string', description: 'Why this edit should be made', required: true }
        },
        needsProcessing: false
      },
      async (args, ctx) => {
        const doc = await this.documentProvider.getDocument(ctx.documentId);
        const baseVersion = doc.version || 0;

        const result = await this.documentProvider.createSuggestion(
          ctx.documentId,
          args.new_content,
          baseVersion,
          ctx.expertUserId
        );

        // Broadcast event
        if (this.broadcaster) {
          this.broadcaster.emit(`document:${ctx.documentId}`, 'suggestion-created', {
            suggestionId: result.id,
            createdBy: result.created_by,
            createdAt: result.created_at,
            baseVersion: result.base_version
          });
        }

        return {
          tool: 'suggest_edit',
          result: `Content suggestion created. Reason: ${args.reason}`,
          success: true
        };
      }
    );

    // Tool: analyze_attachment
    this.registerTool(
      {
        name: 'analyze_attachment',
        description: 'Analyze an attachment with a specific question using AI',
        parameters: {
          attachment_id: { type: 'string', description: 'The attachment ID', required: true },
          question: { type: 'string', description: 'Question about the attachment', required: true }
        },
        needsProcessing: false
      },
      async (args, ctx) => {
        const attachment = await this.documentProvider.getAttachment(ctx.documentId, args.attachment_id);

        if (!attachment) {
          return {
            tool: 'analyze_attachment',
            result: `Attachment ${args.attachment_id} not found`,
            success: false
          };
        }

        // Get content
        const fileContents = attachment.files
          .filter(f => f.data)
          .map(f => {
            try {
              return `File: ${f.filename}\n${f.data!.toString('utf-8')}`;
            } catch {
              return `[File ${f.filename} is binary]`;
            }
          })
          .join('\n\n');

        const tokenCount = estimateTokens(fileContents);

        // For large attachments, inform about using analysis
        if (tokenCount > LARGE_ATTACHMENT_THRESHOLD_TOKENS) {
          const systemPrompt = 'You are an expert document analyst. Answer questions about documents concisely and accurately.';
          const userPrompt = `Document content:\n\n${fileContents}\n\nQuestion: ${args.question}\n\nProvide a clear answer:`;

          try {
            const chatSystemPrompt = await this.settingsProvider.getSetting<string>('chat_system_prompt');
            const summarizationModel = await this.settingsProvider.getSetting<string>('summarization_model');
            const modelName = summarizationModel || 'default';

            const response = await this.aiClient.chat(
              userPrompt,
              modelName,
              0.3,
              ANALYSIS_MAX_TOKENS,
              chatSystemPrompt || systemPrompt
            );

            return {
              tool: 'analyze_attachment',
              result: `Attachment ${args.attachment_id} (~${tokenCount} tokens, analyzed with AI):\n\nQuestion: "${args.question}"\n\nAnalysis: ${response.content}`,
              success: true
            };
          } catch (error) {
            return {
              tool: 'analyze_attachment',
              result: `Error analyzing attachment: ${(error as Error).message}`,
              success: false
            };
          }
        } else {
          // Small attachment - return content directly
          return {
            tool: 'analyze_attachment',
            result: `Attachment ${args.attachment_id} (~${tokenCount} tokens):\n\nQuestion: "${args.question}"\n\nContent:\n${fileContents}\n\nPlease analyze this content to answer the question.`,
            success: true
          };
        }
      }
    );
  }
}
