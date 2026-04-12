import type {
  EngineAdapter,
  EngineInput,
  EngineOutput,
  ToolCall,
  ToolDefinition,
} from './types.js';
import {
  estimateTokensFromText,
  packOpenAIChatMessages,
  type OpenAIChatMessage,
} from './OpenAIChatPromptPacker.js';

interface ChatCompletionsRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  tool_choice?:
    | 'auto'
    | 'none'
    | 'required'
    | {
        type: 'function';
        function: {
          name: string;
        };
      };
}

interface ChatCompletionsResponse {
  choices: Array<{
    message: {
      content: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
}

export class OpenAIChatCompletionsEngine implements EngineAdapter {
  constructor(private readonly timeoutMs: number = 60000) {}

  async generate(input: EngineInput): Promise<EngineOutput> {
    const { agent, event, history, mode } = input;
    const engineSpec = agent.engine;
    if (!engineSpec.provider) {
      throw new Error(
        `Engine ${engineSpec.id} is missing provider; OpenAIChatCompletionsEngine requires engine.provider`
      );
    }
    if (
      engineSpec.charsPerToken !== undefined &&
      (!Number.isFinite(engineSpec.charsPerToken) || engineSpec.charsPerToken <= 0)
    ) {
      throw new Error(
        `Engine ${engineSpec.id} has invalid charsPerToken; expected a positive number`
      );
    }
    if (
      engineSpec.responseReserveTokens !== undefined &&
      (!Number.isInteger(engineSpec.responseReserveTokens) ||
        engineSpec.responseReserveTokens < 0)
    ) {
      throw new Error(
        `Engine ${engineSpec.id} has invalid responseReserveTokens; expected a non-negative integer`
      );
    }
    const openAITools =
      input.tools && input.tools.length > 0
        ? input.tools.map((tool) => this.toOpenAITool(tool))
        : undefined;
    const actorName = event.actor.name || event.actor.id;
    const packedPrompt = packOpenAIChatMessages({
      systemPrompt: agent.systemPrompt,
      mode,
      history,
      event: {
        role: event.actor.type === 'agent' ? 'assistant' : 'user',
        content: `${actorName}: ${event.content}`,
      },
      toolCalls: input.toolCalls,
      toolResults: input.toolResults,
      toolSchemas: openAITools,
      contextWindow: engineSpec.contextWindow,
      charsPerToken: engineSpec.charsPerToken,
      responseReserveTokens: engineSpec.responseReserveTokens,
    });

    const requestBody: ChatCompletionsRequest = {
      model: engineSpec.model,
      messages: packedPrompt.messages,
      temperature: engineSpec.settings?.temperature as number | undefined ?? 0.7,
    };

    if (openAITools) {
      requestBody.tools = openAITools;
      const requestedToolChoice = (
        input.event.metadata as { openai_tool_choice?: ChatCompletionsRequest['tool_choice'] }
      )?.openai_tool_choice;
      requestBody.tool_choice = requestedToolChoice ?? 'auto';
    }

    const requestBodyText = JSON.stringify(requestBody);
    const promptTokenEstimate =
      engineSpec.charsPerToken === undefined
        ? undefined
        : {
            strategy: 'chars_per_token',
            charsPerToken: engineSpec.charsPerToken,
            promptChars: requestBodyText.length,
            promptTokens: estimateTokensFromText(
              requestBodyText,
              engineSpec.charsPerToken
            ),
            contextWindow: engineSpec.contextWindow,
          };

    const apiKey = engineSpec.settings?.api_key as string | undefined;
    const url = `${engineSpec.provider}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBodyText,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Engine request failed: ${response.status} ${response.statusText}\n${errorText}`
        );
      }

      const data = (await response.json()) as ChatCompletionsResponse;
      const message = data.choices?.[0]?.message;
      const content = message?.content || '';
      const toolCalls = this.parseToolCalls(message?.tool_calls);
      const responseMessageText = JSON.stringify(message ?? { content: '' });
      const completionTokenEstimate =
        engineSpec.charsPerToken === undefined
          ? undefined
          : {
              completionChars: responseMessageText.length,
              completionTokens: estimateTokensFromText(
                responseMessageText,
                engineSpec.charsPerToken
              ),
            };

      return {
        content,
        metadata: {
          model: engineSpec.model,
          engine: engineSpec.id,
          ...(promptTokenEstimate && completionTokenEstimate
            ? {
                tokenEstimate: {
                  ...promptTokenEstimate,
                  ...completionTokenEstimate,
                  totalTokens:
                    promptTokenEstimate.promptTokens +
                    completionTokenEstimate.completionTokens,
                  remainingContextTokens:
                    engineSpec.contextWindow === undefined
                      ? undefined
                      : Math.max(
                          0,
                          engineSpec.contextWindow -
                            promptTokenEstimate.promptTokens
                        ),
                  promptContextRatio:
                    engineSpec.contextWindow === undefined
                      ? undefined
                      : promptTokenEstimate.promptTokens /
                        engineSpec.contextWindow,
                  totalContextRatio:
                    engineSpec.contextWindow === undefined
                      ? undefined
                      : (promptTokenEstimate.promptTokens +
                          completionTokenEstimate.completionTokens) /
                        engineSpec.contextWindow,
                  promptPack: packedPrompt.trace,
                },
              }
            : {}),
        },
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Engine request timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private toOpenAITool(
    tool: ToolDefinition
  ): NonNullable<ChatCompletionsRequest['tools']>[number] {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    };
  }

  private parseToolCalls(
    raw?: ChatCompletionsResponse['choices'][number]['message']['tool_calls']
  ): ToolCall[] {
    if (!raw || raw.length === 0) return [];

    const calls: ToolCall[] = [];
    for (const call of raw) {
      let args: Record<string, unknown> | undefined;
      if (call.function?.arguments) {
        try {
          const parsed = JSON.parse(call.function.arguments);
          if (parsed && typeof parsed === 'object') {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = undefined;
        }
      }

      calls.push({
        id: call.id,
        name: call.function.name,
        args,
      });
    }

    return calls;
  }
}
