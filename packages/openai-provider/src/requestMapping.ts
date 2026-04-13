import type { ChatEvent, PromptMessage } from 'council-of-experts';
import type { OpenAIChatMessage } from './types.js';

export function flattenOpenAIMessageContent(
  content: OpenAIChatMessage['content']
): string {
  if (content === null) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        return part.text;
      }

      return `[unsupported content part: ${part?.type ?? 'unknown'}]`;
    })
    .join('');
}

export function normalizeOpenAIRequestMessages(
  messages: OpenAIChatMessage[]
): PromptMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: flattenOpenAIMessageContent(message.content),
    name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls?.map((call) => ({
      id: call.id,
      type: call.type,
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    })),
  }));
}

export function buildProviderChatEvent(input: {
  model: string;
  requestId: string;
  user?: string;
  instruction: string;
  promptMessages: PromptMessage[];
}): ChatEvent {
  return {
    id: input.requestId,
    actor: {
      type: 'user',
      id: input.user || 'openai-client',
      name: input.user || 'OpenAI Client',
    },
    content: input.instruction,
    promptMessages: input.promptMessages,
    timestamp: new Date().toISOString(),
    metadata: {
      openaiRequestModel: input.model,
    },
  };
}
