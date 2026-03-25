/**
 * Council Orchestrator - Main orchestration class
 */
import type { CouncilConfig, Expert, ExpertResponse } from './types.js';
import { AIClient } from './AIClient.js';
export declare class CouncilOrchestrator {
    private documentProvider;
    private settingsProvider;
    private loggerProvider?;
    private broadcaster?;
    aiClient: AIClient;
    private toolSystem;
    private responseCallback?;
    constructor(config: CouncilConfig);
    /**
     * Set callback for expert responses
     */
    onResponse(callback: (response: ExpertResponse, documentId: string) => Promise<void>): void;
    /**
     * Register a custom tool
     */
    registerTool(tool: import('./types.js').Tool, executor: import('./types.js').ToolExecutor): void;
    /**
     * Orchestrate experts responding to a message
     */
    orchestrate(documentId: string, userMessage: string, triggerUserId: string, experts: Expert[], context: {
        documentContent?: string;
        chatHistory?: string;
    }, options?: {
        isIndirectInvocation?: boolean;
    }): Promise<void>;
    private executeExpert;
    private buildSystemPrompt;
    private buildUserPrompt;
    /**
     * Get AI diagnostic by ID
     */
    getDiagnostic(id: string): import("./types.js").Diagnostic | undefined;
    /**
     * Get diagnostics for a model
     */
    getModelDiagnostics(modelName: string): import("./types.js").Diagnostic[];
    /**
     * Summarize text using configured summarization model
     */
    summarize(text: string): Promise<string>;
}
//# sourceMappingURL=CouncilOrchestrator.d.ts.map