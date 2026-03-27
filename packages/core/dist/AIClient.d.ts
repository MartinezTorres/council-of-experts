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
    /**
     * Discover available models from a provider
     * @param url - Provider base URL (e.g. http://localhost:1234)
     * @param apiKey - Optional API key
     * @param timeoutMs - Timeout in milliseconds
     * @returns Array of models with IDs and context sizes
     */
    discoverModels(url: string, apiKey?: string, timeoutMs?: number): Promise<Array<{
        id: string;
        context_size: number | null;
    }>>;
    /**
     * Test connection to a model
     * @param modelName - Name of the model to test
     * @returns Test result with response time and sample response
     */
    testConnection(modelName: string): Promise<{
        success: boolean;
        response_time_ms: number;
        test_response?: string;
        error?: string;
    }>;
    /**
     * Test if a model supports tool calling
     * @param modelName - Name of the model to test
     * @returns Test result indicating tool support
     */
    testToolSupport(modelName: string): Promise<{
        supports_tools: boolean | 'unknown';
        response_time_ms: number;
        error?: string;
    }>;
}
//# sourceMappingURL=AIClient.d.ts.map