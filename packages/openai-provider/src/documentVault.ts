import { readFile } from 'fs/promises';
import type {
  ToolCall,
  ToolDefinition,
  ToolHost,
  ToolRef,
  ToolResult,
} from 'council-of-experts';
import type { ResolvedProviderAgentDocumentConfig } from './types.js';

export const VAULT_READ_TOOL_NAME = 'vault.read';

function buildVaultReadDescription(
  documents: ResolvedProviderAgentDocumentConfig[]
): string {
  const lines = ['Read the contents of one assigned document by exact path.'];

  if (documents.length > 0) {
    lines.push('Available documents:');
    for (const document of documents) {
      lines.push(
        document.description
          ? `- ${document.path}: ${document.description}`
          : `- ${document.path}`
      );
    }
  }

  return lines.join('\n');
}

export function mergeAgentTools(
  tools: ToolRef[] | undefined,
  documentTool: ToolDefinition | undefined
): ToolRef[] | undefined {
  if (!documentTool) {
    return tools;
  }

  const merged: ToolRef[] = [];
  let insertedDocumentTool = false;

  for (const tool of tools ?? []) {
    const name = typeof tool === 'string' ? tool : tool.name;
    if (name === VAULT_READ_TOOL_NAME) {
      if (!insertedDocumentTool) {
        merged.push(documentTool);
        insertedDocumentTool = true;
      }
      continue;
    }
    merged.push(tool);
  }

  if (!insertedDocumentTool) {
    merged.push(documentTool);
  }

  return merged;
}

export class DocumentVault {
  constructor(
    private readonly documentsByAgent: Record<
      string,
      ResolvedProviderAgentDocumentConfig[]
    >
  ) {}

  listDocumentsForAgent(
    agentId: string
  ): Array<{ path: string; description?: string }> {
    return (this.documentsByAgent[agentId] ?? []).map((document) => ({
      path: document.path,
      description: document.description,
    }));
  }

  getToolForAgent(agentId: string): ToolDefinition | undefined {
    const documents = this.documentsByAgent[agentId] ?? [];
    if (documents.length === 0) {
      return undefined;
    }

    return {
      name: VAULT_READ_TOOL_NAME,
      description: buildVaultReadDescription(documents),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
            enum: documents.map((document) => document.path),
            description: 'Exact document path.',
          },
        },
        required: ['path'],
      },
    };
  }

  async executeForAgent(agentId: string, call: ToolCall): Promise<ToolResult> {
    if (call.name !== VAULT_READ_TOOL_NAME) {
      return {
        ok: false,
        error: `Unsupported local tool: ${call.name}`,
      };
    }

    const requestedPath =
      typeof call.args?.path === 'string' ? call.args.path.trim() : '';
    if (!requestedPath) {
      return {
        ok: false,
        error: 'vault.read requires a non-empty string path',
      };
    }

    const document = (this.documentsByAgent[agentId] ?? []).find(
      (entry) => entry.path === requestedPath
    );
    if (!document) {
      return {
        ok: false,
        error: `Document not available to agent ${agentId}: ${requestedPath}`,
      };
    }

    try {
      const content = await readFile(document.absolutePath, 'utf8');
      return {
        ok: true,
        content: [
          `Path: ${document.path}`,
          document.description
            ? `Description: ${document.description}`
            : undefined,
          '',
          content,
        ]
          .filter((line) => line !== undefined)
          .join('\n'),
        data: {
          path: document.path,
          description: document.description,
        },
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : `Failed to read ${document.path}`,
      };
    }
  }

  createToolHost(): ToolHost {
    return {
      execute: (call, ctx) => this.executeForAgent(ctx.agentId, call),
    };
  }
}
