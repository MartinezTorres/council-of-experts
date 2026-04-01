/**
 * /v1/chat/completions compatible EngineAdapter implementation.
 * Works with any local or remote model server that follows the OpenAI chat
 * completions API shape (e.g. llama.cpp, Ollama, LM Studio, vLLM, etc.)
 */

import type { EngineAdapter, EngineInput, EngineOutput } from 'council-of-experts';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
}

interface ChatCompletionsResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class ChatCompletionsEngine implements EngineAdapter {
  private timeoutMs: number;

  constructor(timeoutMs: number = 60000) {
    this.timeoutMs = timeoutMs;
  }

  async generate(input: EngineInput): Promise<EngineOutput> {
    const { agent, event, history, mode } = input;
    const engineSpec = agent.engine;

    // Build messages array
    const messages: ChatMessage[] = [];

    // System prompt with mode context
    let systemPrompt = agent.systemPrompt;
    if (mode === 'council') {
      systemPrompt += '\n\nYou are in council mode. Deliberate carefully with other agents.';
    } else if (mode === 'oracle') {
      systemPrompt += '\n\nYou are in oracle mode. You are part of a unified council voice.';
    }

    messages.push({ role: 'system', content: systemPrompt });

    // Add recent history: public-only in open mode, all messages in council/oracle
    const relevantHistory =
      mode === 'open'
        ? history.filter((m) => m.visibility === 'public')
        : history;

    for (const msg of relevantHistory.slice(-10)) {
      messages.push({
        role: msg.author.type === 'agent' || msg.author.type === 'oracle' ? 'assistant' : 'user',
        content: `${msg.author.name}: ${msg.content}`,
      });
    }

    // Add current event
    const actorName = event.actor.name || event.actor.id;
    messages.push({
      role: event.actor.type === 'agent' ? 'assistant' : 'user',
      content: `${actorName}: ${event.content}`,
    });

    // Build request
    const requestBody: ChatCompletionsRequest = {
      model: engineSpec.model,
      messages,
      temperature: engineSpec.settings?.temperature as number | undefined ?? 0.7,
    };

    const apiKey = engineSpec.settings?.api_key as string | undefined;
    const url = `${engineSpec.provider}/v1/chat/completions`;

    // Make request with abort-based timeout
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
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Engine request failed: ${response.status} ${response.statusText}\n${errorText}`
        );
      }

      const data = (await response.json()) as ChatCompletionsResponse;
      const content = data.choices?.[0]?.message?.content || '';

      return {
        content,
        metadata: {
          model: engineSpec.model,
          engine: engineSpec.id,
        },
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
}
