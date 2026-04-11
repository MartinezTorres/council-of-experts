/**
 * CLI ToolHost implementation and built-in tool catalog.
 */

import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolCall,
  ToolHost,
  ToolResult,
} from 'council-of-experts';

export const CLI_TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  ls: {
    name: 'ls',
    description: 'List files and directories within the configured workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to list. Defaults to the workspace root.',
        },
      },
      additionalProperties: false,
    },
  },
  cat: {
    name: 'cat',
    description: 'Read a UTF-8 text file within the configured workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file to read.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

export function getCLIToolDefinition(name: string): ToolDefinition | undefined {
  return CLI_TOOL_DEFINITIONS[name];
}

export class CLIToolHost implements ToolHost {
  private readonly rootDir: string;
  private readonly maxBytes = 100_000;

  constructor(rootDir: string = process.cwd()) {
    this.rootDir = path.resolve(rootDir);
  }

  async execute(
    call: ToolCall,
    _ctx: ToolExecutionContext
  ): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'ls':
          return await this.listFiles(call);

        case 'cat':
          return await this.readFile(call);

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

  private resolvePath(requestedPath?: string): string | null {
    const target =
      requestedPath && requestedPath.trim().length > 0 ? requestedPath : '.';
    const resolved = path.resolve(this.rootDir, target);
    if (resolved === this.rootDir) return resolved;
    if (resolved.startsWith(this.rootDir + path.sep)) return resolved;
    return null;
  }

  private async listFiles(call: ToolCall): Promise<ToolResult> {
    const target = this.resolvePath(call.args?.path as string | undefined);
    if (!target) {
      return { ok: false, error: 'Path is outside allowed root' };
    }

    const entries = await readdir(target, { withFileTypes: true });
    const lines = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));

    return {
      ok: true,
      content: lines.length > 0 ? lines.join('\n') : '(empty directory)',
    };
  }

  private async readFile(call: ToolCall): Promise<ToolResult> {
    const requestedPath = call.args?.path as string | undefined;
    if (!requestedPath || typeof requestedPath !== 'string') {
      return { ok: false, error: 'Missing required argument: path (string)' };
    }

    const target = this.resolvePath(requestedPath);
    if (!target) {
      return { ok: false, error: 'Path is outside allowed root' };
    }

    const fileStat = await stat(target);
    if (!fileStat.isFile()) {
      return { ok: false, error: 'Path is not a file' };
    }

    const content = await readFile(target, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) {
      const truncated = content.slice(0, this.maxBytes);
      return {
        ok: true,
        content: `${truncated}\n\n...[truncated after ${this.maxBytes} bytes]`,
      };
    }

    return { ok: true, content };
  }
}
