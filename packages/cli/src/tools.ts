/**
 * Basic tools for CLI agents
 */

import type { Tool, ToolExecutor } from 'council-of-experts';
import type { MemoryDocumentProvider, ChatHistory } from './providers.js';

/**
 * Create tools for CLI agents
 */
export function createCLITools(
  documentProvider: MemoryDocumentProvider,
  chatHistory: ChatHistory,
  agents: Map<string, { name: string; icon: string; purpose: string }>
): { tools: Tool[]; executors: Map<string, ToolExecutor> } {
  const tools: Tool[] = [];
  const executors = new Map<string, ToolExecutor>();

  // read_document tool
  tools.push({
    name: 'read_document',
    description: 'Read the current document content',
    parameters: {},
    needsProcessing: true
  });
  executors.set('read_document', async (_args, context) => {
    const content = documentProvider.getDocumentSync(context.documentId);
    return {
      tool: 'read_document',
      result: content || '(empty document)',
      success: true
    };
  });

  // write_document tool
  tools.push({
    name: 'write_document',
    description: 'Replace the entire document content with new text',
    parameters: {
      content: {
        type: 'string',
        description: 'The new document content',
        required: true
      }
    },
    needsProcessing: true
  });
  executors.set('write_document', async (args, context) => {
    const content = args.content as string;
    documentProvider.updateDocument(context.documentId, content);
    return {
      tool: 'write_document',
      result: `Document updated (${content.length} characters)`,
      success: true
    };
  });

  // list_participants tool
  tools.push({
    name: 'list_participants',
    description: 'List all agents participating in this conversation',
    parameters: {},
    needsProcessing: true
  });
  executors.set('list_participants', async (_args, _context) => {
    const participantList = Array.from(agents.values())
      .map(a => `${a.icon} ${a.name}: ${a.purpose}`)
      .join('\n');
    return {
      tool: 'list_participants',
      result: participantList || '(no agents configured)',
      success: true
    };
  });

  // get_context tool
  tools.push({
    name: 'get_context',
    description: 'View recent conversation history',
    parameters: {
      count: {
        type: 'number',
        description: 'Number of recent messages to retrieve (default: 5)',
        required: false
      }
    },
    needsProcessing: true
  });
  executors.set('get_context', async (args, _context) => {
    const count = (args.count as number) || 5;
    const history = chatHistory.getFormattedHistory(count);
    return {
      tool: 'get_context',
      result: history || '(no conversation history)',
      success: true
    };
  });

  // my_role tool
  tools.push({
    name: 'my_role',
    description: 'Introspection: learn about yourself (your name, icon, purpose)',
    parameters: {},
    needsProcessing: true
  });
  executors.set('my_role', async (_args, context) => {
    const agent = agents.get(context.expertUserId);
    if (!agent) {
      return {
        tool: 'my_role',
        result: 'Unknown agent',
        success: false
      };
    }
    return {
      tool: 'my_role',
      result: `You are ${agent.icon} ${agent.name}. Your purpose: ${agent.purpose}`,
      success: true
    };
  });

  return { tools, executors };
}
