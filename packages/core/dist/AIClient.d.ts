/**
 * AI Client - OpenAI-compatible provider client
 */
import type { AIResponse, OpenAIFunction, Diagnostic, SettingsProvider, LoggerProvider } from './types.js';
export declare class AIClient {
    private settings;
    private logger?;
    private summaryCache;
    private diagnostics;
    constructor(settings: SettingsProvider, logger?: LoggerProvider | undefined);
    /**
     * Execute chat completion with optional tools
     */
    chat(prompt: string, modelName: string, temperature: number, maxTokens?: number, systemPrompt?: string, tools?: OpenAIFunction[]): Promise<AIResponse>;
    /**
     * Generate summary from text
     */
    summarize(text: string): Promise<string>;
    /**
     * Get diagnostic by ID
     */
    getDiagnostic(id: string): Diagnostic | undefined;
    /**
     * Get diagnostics for a model
     */
    getModelDiagnostics(modelName: string): Diagnostic[];
    private storeDiagnostic;
    private evictCacheIfNeeded;
}
//# sourceMappingURL=AIClient.d.ts.map