/**
 * Tool System - Built-in and custom tool execution
 */
import type { Tool, ToolExecutor, ToolExecutionContext, ToolResult, DocumentProvider, EventBroadcaster, SettingsProvider } from './types.js';
import { toOpenAIFunction } from './utils.js';
import { AIClient } from './AIClient.js';
export declare class ToolSystem {
    private documentProvider;
    private settingsProvider;
    private aiClient;
    private broadcaster?;
    private tools;
    private executors;
    constructor(documentProvider: DocumentProvider, settingsProvider: SettingsProvider, aiClient: AIClient, broadcaster?: EventBroadcaster | undefined);
    /**
     * Register a custom tool
     */
    registerTool(tool: Tool, executor: ToolExecutor): void;
    /**
     * Execute a tool
     */
    executeTool(name: string, args: Record<string, any>, context: ToolExecutionContext): Promise<ToolResult>;
    /**
     * Get all tools in OpenAI format
     */
    getOpenAITools(): Array<ReturnType<typeof toOpenAIFunction>>;
    /**
     * Get tool by name
     */
    getTool(name: string): Tool | undefined;
    private registerBuiltInTools;
}
//# sourceMappingURL=ToolSystem.d.ts.map