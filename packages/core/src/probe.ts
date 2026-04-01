/**
 * Engine probe and provider discovery utilities.
 *
 * probeEngine     — Tests a configured engine via the EngineAdapter contract.
 * discoverModels  — Lists models available at an OpenAI-compatible provider URL.
 * testToolSupport — Tests whether an OpenAI-compatible endpoint supports tool-calling.
 */

import type {
  EngineAdapter,
  EngineSpec,
  AgentDefinition,
  ChatEvent,
  EngineInput,
  ProbeResult,
  DiscoveredModel,
  ToolProbeResult,
} from './types.js';

// ── probeEngine ───────────────────────────────────────────────────────────────

/**
 * Sends a minimal test message through the given EngineAdapter and measures
 * round-trip time.  All AI calls in neural_storm go through an EngineAdapter,
 * so this is the canonical way to verify that a configured engine is reachable.
 */
export async function probeEngine(
  adapter: EngineAdapter,
  spec: EngineSpec,
  options?: { prompt?: string; timeoutMs?: number }
): Promise<ProbeResult> {
  const prompt = options?.prompt ?? 'Reply with exactly: OK';

  const agent: AgentDefinition = {
    id: '_probe',
    name: 'Probe',
    engine: spec,
    modelName: spec.model,
    summary: 'Connection probe',
    systemPrompt: 'You are a connection test agent. Follow instructions exactly.',
  };

  const event: ChatEvent = {
    id: '_probe',
    actor: { type: 'system', id: '_probe', name: 'probe' },
    content: prompt,
    timestamp: new Date().toISOString(),
  };

  const input: EngineInput = {
    councilId: '_probe',
    turnId: '_probe',
    agent,
    mode: 'open',
    event,
    history: [],
  };

  const start = Date.now();

  const run = async (): Promise<ProbeResult> => {
    try {
      const output = await adapter.generate(input);
      return {
        success: true,
        responseTimeMs: Date.now() - start,
        response: output.content,
      };
    } catch (error) {
      return {
        success: false,
        responseTimeMs: Date.now() - start,
        error: (error as Error).message,
      };
    }
  };

  if (options?.timeoutMs != null) {
    const timeout = new Promise<ProbeResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            success: false,
            responseTimeMs: options.timeoutMs!,
            error: `Probe timed out after ${options.timeoutMs}ms`,
          }),
        options.timeoutMs
      )
    );
    return Promise.race([run(), timeout]);
  }

  return run();
}

// ── discoverModels ────────────────────────────────────────────────────────────

/**
 * Fetches the model list from an OpenAI-compatible provider endpoint.
 * Returns id + contextWindow (if advertised by the provider).
 */
export async function discoverModels(
  url: string,
  apiKey: string,
  timeoutMs = 10_000
): Promise<DiscoveredModel[]> {
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models (${response.status}): ${response.statusText}`);
  }

  const data = (await response.json()) as { data?: unknown[] };
  return (data.data ?? []).map((m: any) => ({
    id: m.id as string,
    contextWindow:
      m.max_model_len ??
      m.context_length ??
      m.max_tokens ??
      m.meta?.n_ctx_train ??
      m.params?.num_ctx ??
      m.info?.params?.num_ctx ??
      undefined,
  }));
}

// ── testToolSupport ───────────────────────────────────────────────────────────

/**
 * Probes an OpenAI-compatible endpoint with a tool-calling request to
 * determine whether the model supports function/tool use.
 */
export async function testToolSupport(
  url: string,
  apiKey: string,
  modelId: string,
  timeoutMs = 30_000
): Promise<ToolProbeResult> {
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const tool = {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Perform basic arithmetic',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression to evaluate' },
        },
        required: ['expression'],
      },
    },
  };

  // First attempt: force tool use with tool_choice: "required"
  // Falls back to tool_choice: "auto" if:
  //   - the server rejects "required" with a non-2xx response, OR
  //   - the server silently ignores "required" (HTTP 200 but no tool_calls in response)
  for (const toolChoice of ['required', 'auto'] as const) {
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Use the calculator tool to compute 2+2.' }],
          tools: [tool],
          tool_choice: toolChoice,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        // A non-2xx on "required" likely means the server doesn't support that option — retry with "auto"
        if (toolChoice === 'required') continue;
        return { supportsTools: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }

      const data = (await response.json()) as any;
      const choice = data.choices?.[0];
      const hasToolCall = Boolean(choice?.message?.tool_calls?.length) || choice?.finish_reason === 'tool_calls';

      // Some servers (e.g. llama-swap/llama.cpp) silently ignore tool_choice: "required" and return
      // a normal text completion with finish_reason: "stop". Retry with "auto" in that case.
      if (!hasToolCall && toolChoice === 'required') continue;

      return { supportsTools: hasToolCall };
    } catch (error) {
      if (toolChoice === 'required') continue;
      return { supportsTools: 'unknown', error: (error as Error).message };
    }
  }

  return { supportsTools: false, error: 'tool_choice: required not supported and auto did not invoke tool' };
}
