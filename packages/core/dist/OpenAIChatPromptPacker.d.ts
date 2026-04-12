import type { CouncilMessage, CouncilMode, ToolCall, ToolResult } from './types.js';
export interface OpenAIChatMessage {
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
export interface OpenAIContextPackSectionTrace {
    id: string;
    kind: 'system' | 'history.summary' | 'history.raw' | 'event' | 'tool.continuation' | 'tool.schemas';
    estimatedChars: number;
    estimatedTokens?: number;
    sourceMessageCount?: number;
    packedMessageCount?: number;
    includedMessageCount?: number;
    omittedMessageCount?: number;
}
export interface OpenAIContextPackTrace {
    strategy: 'unbounded' | 'full_history' | 'recent_plus_summary' | 'summary_only' | 'fixed_only';
    charsPerToken?: number;
    contextWindow?: number;
    responseReserveTokens?: number;
    availablePromptTokens?: number;
    estimatedPackedPromptTokens?: number;
    historySourceMessages: number;
    rawHistoryMessages: number;
    summarizedHistoryMessages: number;
    omittedHistoryMessages: number;
    sections: OpenAIContextPackSectionTrace[];
}
export interface OpenAIChatPromptPackResult {
    messages: OpenAIChatMessage[];
    trace: OpenAIContextPackTrace;
}
export declare function estimateTokensFromText(text: string, charsPerToken: number): number;
export declare function packOpenAIChatMessages(input: {
    systemPrompt: string;
    mode: CouncilMode;
    history: CouncilMessage[];
    event: {
        role: 'assistant' | 'user';
        content: string;
    };
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    toolSchemas?: unknown;
    contextWindow?: number;
    charsPerToken?: number;
    responseReserveTokens?: number;
}): OpenAIChatPromptPackResult;
//# sourceMappingURL=OpenAIChatPromptPacker.d.ts.map