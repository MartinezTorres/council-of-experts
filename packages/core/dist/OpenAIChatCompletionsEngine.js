import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { estimateTokensFromText, packOpenAIChatMessages, packOpenAIChatPromptMessages, } from './OpenAIChatPromptPacker.js';
const START_JITTER_MAX_MS = 1000;
const RETRY_DELAY_BASE_MS = 1000;
const RETRY_BACKOFF_JITTER_MAX_MS = 1000;
export class OpenAIChatCompletionsEngine {
    timeoutMs;
    constructor(timeoutMs) {
        this.timeoutMs = timeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
            throw new Error('OpenAIChatCompletionsEngine requires timeoutMs as an integer greater than 0');
        }
    }
    async generate(input) {
        const { agent, event, history, mode } = input;
        const engineSpec = agent.engine;
        if (!engineSpec.provider) {
            throw new Error(`Engine ${engineSpec.id} is missing provider; OpenAIChatCompletionsEngine requires engine.provider`);
        }
        if (engineSpec.contextWindow === undefined ||
            !Number.isInteger(engineSpec.contextWindow) ||
            engineSpec.contextWindow <= 1) {
            throw new Error(`Engine ${engineSpec.id} must configure contextWindow as an integer greater than 1`);
        }
        if (engineSpec.charsPerToken === undefined ||
            !Number.isFinite(engineSpec.charsPerToken) ||
            engineSpec.charsPerToken <= 0) {
            throw new Error(`Engine ${engineSpec.id} must configure charsPerToken as a positive number`);
        }
        if (engineSpec.promptBudgetRatio !== undefined &&
            (!Number.isFinite(engineSpec.promptBudgetRatio) ||
                engineSpec.promptBudgetRatio <= 0 ||
                engineSpec.promptBudgetRatio >= 1)) {
            throw new Error(`Engine ${engineSpec.id} has invalid promptBudgetRatio; expected a number greater than 0 and less than 1`);
        }
        if (engineSpec.promptSummaryPolicy) {
            const policy = engineSpec.promptSummaryPolicy;
            if (policy.maxMessagesPerGroup !== undefined &&
                (!Number.isInteger(policy.maxMessagesPerGroup) ||
                    policy.maxMessagesPerGroup <= 0)) {
                throw new Error(`Engine ${engineSpec.id} has invalid promptSummaryPolicy.maxMessagesPerGroup; expected an integer greater than 0`);
            }
            if (policy.minGroupSnippetChars !== undefined &&
                (!Number.isInteger(policy.minGroupSnippetChars) ||
                    policy.minGroupSnippetChars <= 0)) {
                throw new Error(`Engine ${engineSpec.id} has invalid promptSummaryPolicy.minGroupSnippetChars; expected an integer greater than 0`);
            }
            if (policy.minMessageSnippetChars !== undefined &&
                (!Number.isInteger(policy.minMessageSnippetChars) ||
                    policy.minMessageSnippetChars <= 0)) {
                throw new Error(`Engine ${engineSpec.id} has invalid promptSummaryPolicy.minMessageSnippetChars; expected an integer greater than 0`);
            }
            if (policy.shrinkTargetRatio !== undefined &&
                (!Number.isFinite(policy.shrinkTargetRatio) ||
                    policy.shrinkTargetRatio <= 0 ||
                    policy.shrinkTargetRatio >= 1)) {
                throw new Error(`Engine ${engineSpec.id} has invalid promptSummaryPolicy.shrinkTargetRatio; expected a number greater than 0 and less than 1`);
            }
        }
        const openAITools = input.tools && input.tools.length > 0
            ? input.tools.map((tool) => this.toOpenAITool(tool))
            : undefined;
        const actorName = event.actor.name || event.actor.id;
        const packedPrompt = event.promptMessages
            ? packOpenAIChatPromptMessages({
                systemPrompt: agent.systemPrompt,
                mode,
                promptConfig: input.promptConfig,
                promptMessages: event.promptMessages,
                event: {
                    role: event.actor.type === 'agent' ? 'assistant' : 'user',
                    content: event.content,
                },
                toolCalls: input.toolCalls,
                toolResults: input.toolResults,
                toolSchemas: openAITools,
                contextWindow: engineSpec.contextWindow,
                charsPerToken: engineSpec.charsPerToken,
                promptBudgetRatio: engineSpec.promptBudgetRatio,
                promptSummaryPolicy: engineSpec.promptSummaryPolicy,
            })
            : packOpenAIChatMessages({
                systemPrompt: agent.systemPrompt,
                mode,
                promptConfig: input.promptConfig,
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
                promptBudgetRatio: engineSpec.promptBudgetRatio,
                promptSummaryPolicy: engineSpec.promptSummaryPolicy,
            });
        const requestBody = {
            model: engineSpec.model,
            messages: packedPrompt.messages,
            temperature: engineSpec.settings?.temperature ?? 0.7,
        };
        if (openAITools) {
            requestBody.tools = openAITools;
            const requestedToolChoice = input.event.metadata?.openai_tool_choice;
            requestBody.tool_choice = requestedToolChoice ?? 'auto';
        }
        const requestBodyText = JSON.stringify(requestBody);
        const promptTokenEstimate = {
            strategy: 'chars_per_token',
            charsPerToken: engineSpec.charsPerToken,
            promptChars: requestBodyText.length,
            promptTokens: estimateTokensFromText(requestBodyText, engineSpec.charsPerToken),
            contextWindow: engineSpec.contextWindow,
        };
        const apiKey = engineSpec.settings?.api_key;
        const url = `${engineSpec.provider}/v1/chat/completions`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const requestStartedAtMs = Date.now();
        const requestStartedAt = new Date(requestStartedAtMs).toISOString();
        const startDelayMs = this.getStartDelayMs();
        const attemptDetails = [];
        let retryCount = 0;
        let totalRetryDelayMs = 0;
        try {
            await this.waitWithAbort(startDelayMs, controller.signal);
            const headers = {
                'Content-Type': 'application/json',
            };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            let response;
            while (true) {
                const attemptNumber = attemptDetails.length + 1;
                const attemptStartedAtMs = Date.now();
                const attemptStartedAt = new Date(attemptStartedAtMs).toISOString();
                try {
                    response = await this.sendRequest({
                        url,
                        headers,
                        body: requestBodyText,
                        signal: controller.signal,
                    });
                }
                catch (error) {
                    const attemptEndedAtMs = Date.now();
                    attemptDetails.push(this.createAttemptDebug({
                        attempt: attemptNumber,
                        startedAt: attemptStartedAt,
                        startedAtMs: attemptStartedAtMs,
                        endedAtMs: attemptEndedAtMs,
                        outcome: 'transport_error',
                        error,
                    }));
                    throw error;
                }
                const attemptEndedAtMs = Date.now();
                if (response.ok) {
                    attemptDetails.push(this.createAttemptDebug({
                        attempt: attemptNumber,
                        startedAt: attemptStartedAt,
                        startedAtMs: attemptStartedAtMs,
                        endedAtMs: attemptEndedAtMs,
                        outcome: 'success',
                        status: response.status,
                        statusText: response.statusText,
                    }));
                    break;
                }
                if (response.status === 429 || response.status === 503) {
                    retryCount += 1;
                    const retryAfter = response.headers.get('Retry-After');
                    const retryAfterMs = this.parseRetryAfterMs(retryAfter);
                    const retryDelayMs = this.getRetryDelayMs(retryCount, retryAfter);
                    totalRetryDelayMs += retryDelayMs;
                    attemptDetails.push(this.createAttemptDebug({
                        attempt: attemptNumber,
                        startedAt: attemptStartedAt,
                        startedAtMs: attemptStartedAtMs,
                        endedAtMs: attemptEndedAtMs,
                        outcome: 'retry',
                        status: response.status,
                        statusText: response.statusText,
                        retryAfterMs,
                        retryDelayMs,
                    }));
                    await this.waitWithAbort(retryDelayMs, controller.signal);
                    continue;
                }
                attemptDetails.push(this.createAttemptDebug({
                    attempt: attemptNumber,
                    startedAt: attemptStartedAt,
                    startedAtMs: attemptStartedAtMs,
                    endedAtMs: attemptEndedAtMs,
                    outcome: 'http_error',
                    status: response.status,
                    statusText: response.statusText,
                    error: {
                        message: response.bodyText,
                    },
                }));
                const errorText = response.bodyText;
                throw new Error(`Engine request failed: ${response.status} ${response.statusText}\n${errorText}`);
            }
            const data = JSON.parse(response.bodyText);
            const message = data.choices?.[0]?.message;
            const content = message?.content || '';
            const toolCalls = this.parseToolCalls(message?.tool_calls);
            const responseMessageText = JSON.stringify(message ?? { content: '' });
            const completionTokenEstimate = {
                completionChars: responseMessageText.length,
                completionTokens: estimateTokensFromText(responseMessageText, engineSpec.charsPerToken),
            };
            const requestDebug = this.buildRequestDebug({
                startedAt: requestStartedAt,
                startedAtMs: requestStartedAtMs,
                startDelayMs,
                retryCount,
                totalRetryDelayMs,
                attemptDetails,
                finalOutcome: 'success',
            });
            return {
                content,
                metadata: {
                    model: engineSpec.model,
                    engine: engineSpec.id,
                    requestDebug,
                    tokenEstimate: {
                        ...promptTokenEstimate,
                        ...completionTokenEstimate,
                        totalTokens: promptTokenEstimate.promptTokens +
                            completionTokenEstimate.completionTokens,
                        promptBudgetTokens: packedPrompt.trace.promptBudgetTokens,
                        reservedForResponseAndToolsTokens: packedPrompt.trace.reservedForResponseAndToolsTokens,
                        remainingPromptTokens: packedPrompt.trace.promptBudgetTokens === undefined
                            ? undefined
                            : Math.max(0, packedPrompt.trace.promptBudgetTokens -
                                promptTokenEstimate.promptTokens),
                        remainingContextTokens: Math.max(0, engineSpec.contextWindow - promptTokenEstimate.promptTokens),
                        promptContextRatio: promptTokenEstimate.promptTokens / engineSpec.contextWindow,
                        promptBudgetUsageRatio: packedPrompt.trace.promptBudgetTokens === undefined
                            ? undefined
                            : promptTokenEstimate.promptTokens /
                                packedPrompt.trace.promptBudgetTokens,
                        totalContextRatio: (promptTokenEstimate.promptTokens +
                            completionTokenEstimate.completionTokens) /
                            engineSpec.contextWindow,
                        promptPack: packedPrompt.trace,
                    },
                },
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            };
        }
        catch (error) {
            const requestDebug = this.buildRequestDebug({
                startedAt: requestStartedAt,
                startedAtMs: requestStartedAtMs,
                startDelayMs,
                retryCount,
                totalRetryDelayMs,
                attemptDetails,
                finalOutcome: error instanceof Error && error.name === 'AbortError'
                    ? 'timeout'
                    : 'error',
            });
            if (error instanceof Error && error.name === 'AbortError') {
                throw this.attachCouncilErrorData(new Error(`Engine request timed out after ${this.timeoutMs}ms`), requestDebug);
            }
            if (error instanceof Error &&
                error.message === 'fetch failed' &&
                error.cause instanceof Error) {
                const causeCode = 'code' in error.cause && typeof error.cause.code === 'string'
                    ? error.cause.code
                    : undefined;
                const causeSummary = [causeCode, error.cause.message]
                    .filter((value) => value && value.trim().length > 0)
                    .join(': ');
                throw this.attachCouncilErrorData(new Error(causeSummary ? `fetch failed: ${causeSummary}` : 'fetch failed', { cause: error }), requestDebug);
            }
            if (error instanceof Error) {
                throw this.attachCouncilErrorData(error, requestDebug);
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    toOpenAITool(tool) {
        return {
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters ?? { type: 'object', properties: {} },
            },
        };
    }
    parseToolCalls(raw) {
        if (!raw || raw.length === 0)
            return [];
        const calls = [];
        for (const call of raw) {
            let args;
            if (call.function?.arguments) {
                try {
                    const parsed = JSON.parse(call.function.arguments);
                    if (parsed && typeof parsed === 'object') {
                        args = parsed;
                    }
                }
                catch {
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
    async waitWithAbort(ms, signal) {
        if (ms <= 0)
            return;
        await new Promise((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
    getStartDelayMs() {
        return Math.floor(Math.random() * (START_JITTER_MAX_MS + 1));
    }
    getRetryDelayMs(_retryAttempt, retryAfterHeader) {
        const retryAfterMs = this.parseRetryAfterMs(retryAfterHeader);
        if (retryAfterMs !== undefined) {
            return retryAfterMs;
        }
        const jitterMs = Math.floor(Math.random() * (RETRY_BACKOFF_JITTER_MAX_MS + 1));
        return RETRY_DELAY_BASE_MS + jitterMs;
    }
    parseRetryAfterMs(retryAfterHeader) {
        if (!retryAfterHeader) {
            return undefined;
        }
        const trimmed = retryAfterHeader.trim();
        if (trimmed.length === 0) {
            return undefined;
        }
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.round(seconds * 1000);
        }
        const retryAtMs = Date.parse(trimmed);
        if (!Number.isNaN(retryAtMs)) {
            return Math.max(0, retryAtMs - Date.now());
        }
        return undefined;
    }
    createAttemptDebug(input) {
        const errorDetails = this.toDebugError(input.error);
        return {
            attempt: input.attempt,
            startedAt: input.startedAt,
            endedAt: new Date(input.endedAtMs).toISOString(),
            durationMs: Math.max(0, input.endedAtMs - input.startedAtMs),
            outcome: input.outcome,
            status: input.status,
            statusText: input.statusText,
            retryAfterMs: input.retryAfterMs,
            retryDelayMs: input.retryDelayMs,
            error: errorDetails,
        };
    }
    buildRequestDebug(input) {
        const endedAtMs = Date.now();
        return {
            startedAt: input.startedAt,
            endedAt: new Date(endedAtMs).toISOString(),
            durationMs: Math.max(0, endedAtMs - input.startedAtMs),
            startDelayMs: input.startDelayMs,
            attempts: input.attemptDetails.length,
            retryCount: input.retryCount,
            totalRetryDelayMs: input.totalRetryDelayMs,
            finalOutcome: input.finalOutcome,
            attemptDetails: input.attemptDetails.map((entry) => ({
                ...entry,
                error: entry.error === undefined
                    ? undefined
                    : {
                        ...entry.error,
                    },
            })),
        };
    }
    toDebugError(error) {
        if (!(error instanceof Error)) {
            if (typeof error === 'string' && error.length > 0) {
                return { message: error };
            }
            return undefined;
        }
        const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        return {
            name: error.name,
            message: error.message,
            code,
        };
    }
    attachCouncilErrorData(error, requestDebug) {
        const enriched = error;
        enriched.councilErrorData = {
            requestDebug,
        };
        return enriched;
    }
    async sendRequest(input) {
        const target = new URL(input.url);
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        return await new Promise((resolve, reject) => {
            const request = send(target, {
                method: 'POST',
                headers: input.headers,
            }, (response) => {
                const chunks = [];
                response.on('data', (chunk) => {
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                response.on('end', () => {
                    cleanup();
                    const headers = new Headers();
                    for (const [name, value] of Object.entries(response.headers)) {
                        if (Array.isArray(value)) {
                            headers.set(name, value.join(', '));
                        }
                        else if (value !== undefined) {
                            headers.set(name, String(value));
                        }
                    }
                    resolve({
                        ok: (response.statusCode ?? 0) >= 200 &&
                            (response.statusCode ?? 0) < 300,
                        status: response.statusCode ?? 0,
                        statusText: response.statusMessage ?? '',
                        headers,
                        bodyText: Buffer.concat(chunks).toString('utf8'),
                    });
                });
                response.on('error', (error) => {
                    cleanup();
                    reject(new TypeError('fetch failed', { cause: error }));
                });
            });
            const abortWithSignal = () => {
                request.destroy(new DOMException('Aborted', 'AbortError'));
            };
            const cleanup = () => {
                input.signal.removeEventListener('abort', abortWithSignal);
            };
            request.on('error', (error) => {
                cleanup();
                if (error instanceof Error && error.name === 'AbortError') {
                    reject(error);
                    return;
                }
                reject(new TypeError('fetch failed', { cause: error }));
            });
            if (input.signal.aborted) {
                request.destroy(new DOMException('Aborted', 'AbortError'));
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            input.signal.addEventListener('abort', abortWithSignal, { once: true });
            request.end(input.body);
        });
    }
}
//# sourceMappingURL=OpenAIChatCompletionsEngine.js.map