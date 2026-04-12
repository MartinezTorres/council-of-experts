import type { ChatEvent } from 'council-of-experts';
import type { OpenAIChatCompletionRequest, OpenAIChatMessage } from './types.js';

function flattenContent(content: OpenAIChatMessage['content']): string {
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

function formatMessage(message: OpenAIChatMessage): string {
  const name = message.name ? ` (${message.name})` : '';
  const toolCallId = message.tool_call_id ? ` [tool_call_id=${message.tool_call_id}]` : '';
  const lines = [`[${message.role}${name}${toolCallId}] ${flattenContent(message.content)}`];

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const call of message.tool_calls) {
      lines.push(
        `[assistant tool_call id=${call.id}] ${call.function.name}(${call.function.arguments})`
      );
    }
  }

  return lines.join('\n');
}

export function buildTranscript(request: OpenAIChatCompletionRequest): string {
  const conversation = request.messages.map(formatMessage).join('\n\n');

  return [
    'You are answering an OpenAI-compatible chat completion request.',
    'Produce exactly the next assistant reply for the conversation below.',
    'Do not mention hidden deliberation, councils, or internal agents.',
    '',
    'Conversation transcript:',
    conversation,
  ].join('\n');
}

export function buildChatEvent(
  request: OpenAIChatCompletionRequest,
  requestId: string,
  transcript: string
): ChatEvent {
  return {
    id: requestId,
    actor: {
      type: 'user',
      id: request.user || 'openai-client',
      name: request.user || 'OpenAI Client',
    },
    content: transcript,
    timestamp: new Date().toISOString(),
    metadata: {
      openaiRequestModel: request.model,
    },
  };
}
