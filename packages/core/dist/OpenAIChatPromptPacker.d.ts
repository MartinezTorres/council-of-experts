import type { CouncilMessage, CouncilMode, PromptMessage, PromptSummaryPolicy, ResolvedCouncilPromptConfig, ToolCall, ToolResult } from './types.js';
export interface ResolvedPromptSummaryPolicy {
    maxMessagesPerGroup: number;
    minGroupSnippetChars: number;
    minMessageSnippetChars: number;
    shrinkTargetRatio: number;
}
export declare const DEFAULT_PROMPT_BUDGET_RATIO = 0.5;
export declare const DEFAULT_PROMPT_SUMMARY_POLICY: ResolvedPromptSummaryPolicy;
export type OpenAIChatMessage = PromptMessage;
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
    strategy: 'full_history' | 'recent_plus_summary' | 'summary_only' | 'fixed_only';
    charsPerToken?: number;
    contextWindow?: number;
    promptBudgetRatio?: number;
    promptSummaryPolicy?: ResolvedPromptSummaryPolicy;
    promptBudgetTokens?: number;
    reservedForResponseAndToolsTokens?: number;
    availableHistoryTokens?: number;
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
    promptConfig?: ResolvedCouncilPromptConfig;
    history: CouncilMessage[];
    event: {
        role: 'assistant' | 'user';
        content: string;
    };
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    toolSchemas?: unknown;
    contextWindow: number;
    charsPerToken: number;
    promptBudgetRatio?: number;
    promptSummaryPolicy?: PromptSummaryPolicy;
}): OpenAIChatPromptPackResult;
export declare function packOpenAIChatPromptMessages(input: {
    systemPrompt: string;
    mode: CouncilMode;
    promptConfig?: ResolvedCouncilPromptConfig;
    promptMessages: PromptMessage[];
    event: {
        role: 'assistant' | 'user';
        content: string;
    };
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    toolSchemas?: unknown;
    contextWindow: number;
    charsPerToken: number;
    promptBudgetRatio?: number;
    promptSummaryPolicy?: PromptSummaryPolicy;
}): OpenAIChatPromptPackResult;
//# sourceMappingURL=OpenAIChatPromptPacker.d.ts.map