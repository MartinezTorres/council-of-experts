/**
 * AI Client - OpenAI-compatible provider client
 */

import type {
  AIModel,
  AIResponse,
  OpenAIFunction,
  OpenAIToolCall,
  Diagnostic,
  SettingsProvider,
  LoggerProvider,
  SummarizationConfig
} from './types.js';
import { AI_TIMEOUT_MS, DEFAULT_MAX_TOKENS, SUMMARY_CACHE_MAX_SIZE, DIAGNOSTICS_MAX_PER_MODEL } from './constants.js';
import { generateCacheKey } from './utils.js';
import crypto from 'crypto';

export class AIClient {
  private summaryCache: Map<string, string> = new Map();
  private diagnostics: Map<string, Diagnostic[]> = new Map();

  constructor(
    private settings: SettingsProvider,
    private logger?: LoggerProvider
  ) {}

  /**
   * Execute chat completion with optional tools
   */
  async chat(
    prompt: string,
    modelName: string,
    temperature: number,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    systemPrompt?: string,
    tools?: OpenAIFunction[]
  ): Promise<AIResponse> {
    const model = await this.settings.getModel(modelName);
    if (!model) {
      throw new Error(`Model '${modelName}' not found`);
    }

    const diagnosticId = crypto.randomBytes(16).toString('hex');
    const startTime = Date.now();

    try {
      const url = model.url.endsWith('/') ? model.url.slice(0, -1) : model.url;
      const timeoutMs = await this.settings.getSetting<number>('ai_timeout_ms', AI_TIMEOUT_MS);

      // Build messages
      const messages: Array<{ role: string; content: string }> = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: prompt });

      // Build request body
      const requestBody: any = {
        model: model.model,
        messages,
        max_tokens: maxTokens,
        temperature
      };

      if (tools && tools.length > 0) {
        requestBody.tools = tools;
      }

      // Call provider
      const response = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(model.api_key ? { 'Authorization': `Bearer ${model.api_key}` } : {})
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs)
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`AI provider error: ${response.status} ${error}`);
      }

      const data: any = await response.json();
      const content = data.choices[0]?.message?.content || '';
      const toolCalls = data.choices[0]?.message?.tool_calls;

      // Store diagnostic
      await this.storeDiagnostic({
        id: diagnosticId,
        timestamp: new Date().toISOString(),
        modelName: model.name,
        modelUrl: model.url,
        request: {
          prompt,
          systemPrompt,
          temperature,
          maxTokens
        },
        response: {
          content,
          finishReason: data.choices[0]?.finish_reason
        },
        performance: {
          responseTimeMs: responseTime,
          tokensPerSecond: data.usage?.completion_tokens
            ? (data.usage.completion_tokens / (responseTime / 1000))
            : undefined
        },
        usage: data.usage
      });

      // Parse tool calls
      const parsedToolCalls: Array<{ name: string; arguments: Record<string, any> }> = [];
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          try {
            parsedToolCalls.push({
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments)
            });
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      return {
        content,
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        diagnosticId
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      // Store error diagnostic
      await this.storeDiagnostic({
        id: diagnosticId,
        timestamp: new Date().toISOString(),
        modelName: model.name,
        modelUrl: model.url,
        request: {
          prompt,
          systemPrompt,
          temperature,
          maxTokens
        },
        response: {
          content: '',
          finishReason: 'error'
        },
        performance: {
          responseTimeMs: responseTime
        },
        error: (error as Error).message
      });

      // Attach diagnostic ID to error
      (error as any).diagnosticId = diagnosticId;
      throw error;
    }
  }

  /**
   * Generate summary from text
   */
  async summarize(text: string): Promise<string> {
    const summarizationModel = await this.settings.getSetting<string>('summarization_model');
    if (!summarizationModel) {
      return text; // No summarization configured
    }

    const config: SummarizationConfig = {
      model: summarizationModel,
      promptTemplate: await this.settings.getSetting<string>('summarization_prompt_template')
    };

    const defaultTemplate = `You are a technical summarizer. Create a concise summary (around 200 words) of the following text:

{text}

Summary:`;

    const promptTemplate = config.promptTemplate || defaultTemplate;
    const prompt = promptTemplate.replace('{text}', text);

    // Check cache
    const cacheKey = generateCacheKey(text, config.model, promptTemplate);
    const cached = this.summaryCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.chat(prompt, config.model, 0.3, 300);

      // Cache result
      this.evictCacheIfNeeded();
      this.summaryCache.set(cacheKey, response.content);

      return response.content;
    } catch (error) {
      if (this.logger) {
        await this.logger.logError('summarization', error as Error);
      }
      return text; // Fallback to original
    }
  }

  /**
   * Get diagnostic by ID
   */
  getDiagnostic(id: string): Diagnostic | undefined {
    for (const modelDiagnostics of this.diagnostics.values()) {
      const diagnostic = modelDiagnostics.find(d => d.id === id);
      if (diagnostic) return diagnostic;
    }
    return undefined;
  }

  /**
   * Get diagnostics for a model
   */
  getModelDiagnostics(modelName: string): Diagnostic[] {
    return this.diagnostics.get(modelName) || [];
  }

  private async storeDiagnostic(diagnostic: Diagnostic): Promise<void> {
    if (!this.diagnostics.has(diagnostic.modelName)) {
      this.diagnostics.set(diagnostic.modelName, []);
    }

    const modelDiagnostics = this.diagnostics.get(diagnostic.modelName)!;

    // Evict oldest if at capacity
    if (modelDiagnostics.length >= DIAGNOSTICS_MAX_PER_MODEL) {
      modelDiagnostics.shift();
    }

    modelDiagnostics.push(diagnostic);
  }

  private evictCacheIfNeeded(): void {
    if (this.summaryCache.size >= SUMMARY_CACHE_MAX_SIZE) {
      const firstKey = this.summaryCache.keys().next().value;
      if (firstKey !== undefined) {
        this.summaryCache.delete(firstKey);
      }
    }
  }

  /**
   * Discover available models from a provider
   * @param url - Provider base URL (e.g. http://localhost:1234)
   * @param apiKey - Optional API key
   * @param timeoutMs - Timeout in milliseconds
   * @returns Array of models with IDs and context sizes
   */
  async discoverModels(
    url: string,
    apiKey?: string,
    timeoutMs: number = 10000
  ): Promise<Array<{ id: string; context_size: number | null }>> {
    const trimmedUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    const modelsUrl = `${trimmedUrl}/models`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models (${response.status}): ${response.statusText}`);
    }

    const data: any = await response.json();

    // OpenAI-compatible API returns models in data array
    // Extract both model ID and context size if available
    const models = data.data?.map((m: any) => ({
      id: m.id,
      context_size: m.max_model_len || m.context_length || m.max_tokens ||
                    m.meta?.n_ctx_train || m.params?.num_ctx ||
                    m.info?.params?.num_ctx || null
    })) || [];

    return models;
  }

  /**
   * Test connection to a model
   * @param modelName - Name of the model to test
   * @returns Test result with response time and sample response
   */
  async testConnection(
    modelName: string
  ): Promise<{
    success: boolean;
    response_time_ms: number;
    test_response?: string;
    error?: string;
  }> {
    try {
      const startTime = Date.now();
      const response = await this.chat(
        'Write a haiku about artificial intelligence and human collaboration. Be creative.',
        modelName,
        0.7,
        100
      );
      const responseTime = Date.now() - startTime;

      return {
        success: true,
        response_time_ms: responseTime,
        test_response: response.content.substring(0, 200)
      };
    } catch (error) {
      return {
        success: false,
        response_time_ms: 0,
        error: (error as Error).message
      };
    }
  }

  /**
   * Test if a model supports tool calling
   * @param modelName - Name of the model to test
   * @returns Test result indicating tool support
   */
  async testToolSupport(
    modelName: string
  ): Promise<{
    supports_tools: boolean | 'unknown';
    response_time_ms: number;
    error?: string;
  }> {
    const testTool: OpenAIFunction = {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A test tool for checking tool support',
        parameters: {
          type: 'object',
          properties: {
            test: { type: 'string', description: 'Test parameter' }
          },
          required: ['test']
        }
      }
    };

    const startTime = Date.now();
    try {
      await this.chat(
        'Respond with "OK" if you can see this message.',
        modelName,
        0.1,
        10,
        'You are a test assistant.',
        [testTool]
      );
      const responseTime = Date.now() - startTime;

      return {
        supports_tools: true,
        response_time_ms: responseTime
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage = (error as Error).message;

      // Check for specific error messages that indicate tool support issues
      if (errorMessage.includes('tools param requires --jinja flag') ||
          errorMessage.includes('tools') ||
          errorMessage.includes('function') ||
          errorMessage.includes('jinja')) {
        return {
          supports_tools: false,
          response_time_ms: responseTime,
          error: errorMessage
        };
      }

      // Other errors might not be related to tool support
      return {
        supports_tools: 'unknown',
        response_time_ms: responseTime,
        error: errorMessage
      };
    }
  }
}
