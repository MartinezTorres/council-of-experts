import type {
  EngineAdapter,
  EngineInput,
  EngineOutput,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from './types.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
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

function estimateTokensFromText(text: string, charsPerToken: number): number {
  return Math.max(1, Math.ceil(text.length / charsPerToken));
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
    const messages: ChatMessage[] = [];

    let systemPrompt = agent.systemPrompt;
    if (mode === 'council') {
      systemPrompt += '\n\nYou are in council mode. Deliberate carefully with other agents.';
    } else if (mode === 'oracle') {
      systemPrompt += '\n\nYou are in oracle mode. You are part of a unified council voice.';
    }

    messages.push({ role: 'system', content: systemPrompt });

    const relevantHistory =
      mode === 'open'
        ? history.filter((message) => message.visibility === 'public')
        : history;

    for (const message of relevantHistory) {
      messages.push({
        role:
          message.author.type === 'agent' || message.author.type === 'oracle'
            ? 'assistant'
            : 'user',
        content: `${message.author.name}: ${message.content}`,
      });
    }

    const actorName = event.actor.name || event.actor.id;
    messages.push({
      role: event.actor.type === 'agent' ? 'assistant' : 'user',
      content: `${actorName}: ${event.content}`,
    });

    if (input.toolCalls && input.toolCalls.length > 0) {
      const resultsById = new Map<string, ToolResult>();
      for (const result of input.toolResults ?? []) {
        if (result.callId) {
          resultsById.set(result.callId, result);
        }
      }

      for (const call of input.toolCalls) {
        const callId = call.id ?? 'tool_call';
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
              },
            },
          ],
        });

        const result = resultsById.get(callId);
        if (result) {
          const content =
            result.content ??
            (result.data !== undefined ? JSON.stringify(result.data) : undefined) ??
            result.error ??
            '';

          messages.push({
            role: 'tool',
            content,
            tool_call_id: callId,
          });
        }
      }
    }

    const requestBody: ChatCompletionsRequest = {
      model: engineSpec.model,
      messages,
      temperature: engineSpec.settings?.temperature as number | undefined ?? 0.7,
    };

    if (input.tools && input.tools.length > 0) {
      requestBody.tools = input.tools.map((tool) => this.toOpenAITool(tool));
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
