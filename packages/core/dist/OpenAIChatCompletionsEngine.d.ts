import type { EngineAdapter, EngineInput, EngineOutput } from './types.js';
export declare class OpenAIChatCompletionsEngine implements EngineAdapter {
    private readonly timeoutMs;
    constructor(timeoutMs?: number);
    generate(input: EngineInput): Promise<EngineOutput>;
    private toOpenAITool;
    private parseToolCalls;
}
//# sourceMappingURL=OpenAIChatCompletionsEngine.d.ts.map