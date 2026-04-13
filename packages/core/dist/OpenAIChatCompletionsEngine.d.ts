import type { EngineAdapter, EngineInput, EngineOutput } from './types.js';
export declare class OpenAIChatCompletionsEngine implements EngineAdapter {
    private readonly timeoutMs;
    constructor(timeoutMs: number);
    generate(input: EngineInput): Promise<EngineOutput>;
    private toOpenAITool;
    private parseToolCalls;
    private waitWithAbort;
    private getStartDelayMs;
    private getRetryDelayMs;
    private parseRetryAfterMs;
    private createAttemptDebug;
    private buildRequestDebug;
    private toDebugError;
    private attachCouncilErrorData;
    private sendRequest;
}
//# sourceMappingURL=OpenAIChatCompletionsEngine.d.ts.map