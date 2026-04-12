function normalizeWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}
function truncateText(value, maxChars) {
    if (maxChars <= 0) {
        return '';
    }
    const normalized = normalizeWhitespace(value);
    if (normalized.length <= maxChars) {
        return normalized;
    }
    if (maxChars <= 3) {
        return normalized.slice(0, maxChars);
    }
    return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}
function estimateJsonChars(value) {
    return JSON.stringify(value).length;
}
export function estimateTokensFromText(text, charsPerToken) {
    return Math.max(1, Math.ceil(text.length / charsPerToken));
}
function estimateValueTokens(value, charsPerToken) {
    if (charsPerToken === undefined) {
        return undefined;
    }
    return estimateTokensFromText(JSON.stringify(value), charsPerToken);
}
function estimateMessagesTokens(messages, charsPerToken) {
    return estimateValueTokens(messages, charsPerToken);
}
function buildModeSystemPrompt(systemPrompt, mode) {
    if (mode === 'council') {
        return `${systemPrompt}\n\nYou are in council mode. Deliberate carefully with other agents.`;
    }
    if (mode === 'oracle') {
        return `${systemPrompt}\n\nYou are in oracle mode. You are part of a unified council voice.`;
    }
    return systemPrompt;
}
function toHistoryChatMessage(message) {
    return {
        role: message.author.type === 'agent' || message.author.type === 'oracle'
            ? 'assistant'
            : 'user',
        content: `${message.author.name}: ${message.content}`,
    };
}
function buildToolContinuationMessages(input) {
    if (!input.toolCalls || input.toolCalls.length === 0) {
        return [];
    }
    const messages = [];
    const resultsById = new Map();
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
        if (!result) {
            continue;
        }
        const content = result.content ??
            (result.data !== undefined ? JSON.stringify(result.data) : undefined) ??
            result.error ??
            '';
        messages.push({
            role: 'tool',
            content,
            tool_call_id: callId,
        });
    }
    return messages;
}
function groupHistoryMessages(messages) {
    const groups = [];
    for (const message of messages) {
        const last = groups[groups.length - 1];
        if (last &&
            last.authorName === message.author.name &&
            last.visibility === message.visibility) {
            last.messages.push(message);
            continue;
        }
        groups.push({
            authorName: message.author.name,
            visibility: message.visibility,
            messages: [message],
        });
    }
    return groups;
}
function buildHistorySummaryText(input) {
    const { messages, maxChars } = input;
    if (messages.length === 0 || maxChars <= 0) {
        return {
            text: '',
            includedSourceMessages: 0,
            omittedSourceMessages: messages.length,
        };
    }
    const participantNames = Array.from(new Set(messages.map((message) => message.author.name)));
    const publicCount = messages.filter((message) => message.visibility === 'public').length;
    const privateCount = messages.length - publicCount;
    const headerLines = [
        `Earlier conversation summary for ${messages.length} messages.`,
        `Participants: ${participantNames.join(', ') || 'none'}.`,
        `Visibility mix: ${publicCount} public, ${privateCount} private.`,
    ];
    let text = headerLines.join('\n');
    if (text.length >= maxChars) {
        return {
            text: truncateText(text, maxChars),
            includedSourceMessages: 0,
            omittedSourceMessages: messages.length,
        };
    }
    const groups = groupHistoryMessages(messages);
    let includedSourceMessages = 0;
    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const remainingGroups = groups.length - index - 1;
        const remainingChars = Math.max(0, maxChars - text.length - 1);
        if (remainingChars <= 0) {
            break;
        }
        const reservedForOmission = remainingGroups > 0
            ? `\n... ${messages.length - includedSourceMessages} older messages compressed further.`
                .length
            : 0;
        const availableLineChars = Math.max(0, remainingChars - reservedForOmission);
        if (availableLineChars <= 0) {
            break;
        }
        const prefix = `- ${group.authorName} (${group.visibility}`;
        const prefixWithCount = group.messages.length > 1
            ? `${prefix}, ${group.messages.length} msgs): `
            : `${prefix}): `;
        const snippetBudget = Math.max(24, availableLineChars - prefixWithCount.length);
        const perMessageBudget = Math.max(18, Math.floor(snippetBudget / Math.min(group.messages.length, 3)));
        const snippets = group.messages
            .slice(0, 3)
            .map((message) => truncateText(message.content, perMessageBudget));
        let line = `${prefixWithCount}${snippets.join(' | ')}`;
        if (group.messages.length > 3) {
            line += ` (+${group.messages.length - 3} more)`;
        }
        line = truncateText(line, availableLineChars);
        if (line.length === 0) {
            break;
        }
        text += `\n${line}`;
        includedSourceMessages += group.messages.length;
    }
    if (includedSourceMessages < messages.length) {
        text += `\n... ${messages.length - includedSourceMessages} older messages compressed further.`;
        text = truncateText(text, maxChars);
    }
    return {
        text,
        includedSourceMessages,
        omittedSourceMessages: Math.max(0, messages.length - includedSourceMessages),
    };
}
function buildHistorySummaryMessage(input) {
    if (input.messages.length === 0 || input.maxTokens <= 0) {
        return {
            summaryText: undefined,
            includedSourceMessages: 0,
            omittedSourceMessages: input.messages.length,
        };
    }
    const maxChars = Math.max(0, Math.floor(input.maxTokens * input.charsPerToken));
    if (maxChars <= 0) {
        return {
            summaryText: undefined,
            includedSourceMessages: 0,
            omittedSourceMessages: input.messages.length,
        };
    }
    const summary = buildHistorySummaryText({
        messages: input.messages,
        maxChars,
    });
    if (!summary.text) {
        return {
            summaryText: undefined,
            includedSourceMessages: summary.includedSourceMessages,
            omittedSourceMessages: summary.omittedSourceMessages,
        };
    }
    let content = summary.text;
    let estimatedTokens = estimateTokensFromText(content, input.charsPerToken);
    while (estimatedTokens > input.maxTokens && content.length > 0) {
        const targetChars = Math.max(0, Math.floor(content.length * ((input.maxTokens / estimatedTokens) * 0.95)));
        content = truncateText(content, targetChars);
        estimatedTokens = estimateTokensFromText(content, input.charsPerToken);
    }
    if (!content) {
        return {
            summaryText: undefined,
            includedSourceMessages: 0,
            omittedSourceMessages: input.messages.length,
        };
    }
    return {
        summaryText: content,
        includedSourceMessages: summary.includedSourceMessages,
        omittedSourceMessages: summary.omittedSourceMessages,
    };
}
function createSectionTrace(input) {
    return {
        id: input.id,
        kind: input.kind,
        estimatedChars: estimateJsonChars(input.value),
        estimatedTokens: estimateValueTokens(input.value, input.charsPerToken),
        sourceMessageCount: input.sourceMessageCount,
        packedMessageCount: input.packedMessageCount,
        includedMessageCount: input.includedMessageCount,
        omittedMessageCount: input.omittedMessageCount,
    };
}
function buildHistoryPack(input) {
    if (input.availableTokens === undefined ||
        input.charsPerToken === undefined) {
        return {
            rawMessages: input.rawHistoryMessages,
            summaryText: undefined,
            strategy: 'unbounded',
            rawHistoryMessages: input.rawHistoryMessages.length,
            summarizedHistoryMessages: 0,
            omittedHistoryMessages: 0,
            sections: input.rawHistoryMessages.length > 0
                ? [
                    createSectionTrace({
                        id: 'history-raw',
                        kind: 'history.raw',
                        value: input.rawHistoryMessages,
                        charsPerToken: input.charsPerToken,
                        sourceMessageCount: input.history.length,
                        packedMessageCount: input.rawHistoryMessages.length,
                        includedMessageCount: input.history.length,
                        omittedMessageCount: 0,
                    }),
                ]
                : [],
        };
    }
    const fullHistoryTokens = estimateMessagesTokens(input.rawHistoryMessages, input.charsPerToken) ?? 0;
    if (fullHistoryTokens <= input.availableTokens) {
        return {
            rawMessages: input.rawHistoryMessages,
            summaryText: undefined,
            strategy: 'full_history',
            rawHistoryMessages: input.rawHistoryMessages.length,
            summarizedHistoryMessages: 0,
            omittedHistoryMessages: 0,
            sections: input.rawHistoryMessages.length > 0
                ? [
                    createSectionTrace({
                        id: 'history-raw',
                        kind: 'history.raw',
                        value: input.rawHistoryMessages,
                        charsPerToken: input.charsPerToken,
                        sourceMessageCount: input.history.length,
                        packedMessageCount: input.rawHistoryMessages.length,
                        includedMessageCount: input.history.length,
                        omittedMessageCount: 0,
                    }),
                ]
                : [],
        };
    }
    for (let splitIndex = 0; splitIndex <= input.history.length; splitIndex += 1) {
        const recentRawMessages = input.rawHistoryMessages.slice(splitIndex);
        const recentRawTokens = estimateMessagesTokens(recentRawMessages, input.charsPerToken) ?? 0;
        if (recentRawTokens > input.availableTokens) {
            continue;
        }
        const olderMessages = input.history.slice(0, splitIndex);
        const summaryBudgetTokens = input.availableTokens - recentRawTokens;
        const summary = buildHistorySummaryMessage({
            messages: olderMessages,
            maxTokens: summaryBudgetTokens,
            charsPerToken: input.charsPerToken,
        });
        const packedTokens = (summary.summaryText
            ? estimateTokensFromText(summary.summaryText, input.charsPerToken)
            : 0) +
            (estimateMessagesTokens(recentRawMessages, input.charsPerToken) ?? 0);
        if (packedTokens > input.availableTokens) {
            continue;
        }
        const sections = [];
        if (summary.summaryText) {
            sections.push(createSectionTrace({
                id: 'history-summary',
                kind: 'history.summary',
                value: summary.summaryText,
                charsPerToken: input.charsPerToken,
                sourceMessageCount: olderMessages.length,
                packedMessageCount: 0,
                includedMessageCount: summary.includedSourceMessages,
                omittedMessageCount: summary.omittedSourceMessages,
            }));
        }
        if (recentRawMessages.length > 0) {
            sections.push(createSectionTrace({
                id: 'history-raw',
                kind: 'history.raw',
                value: recentRawMessages,
                charsPerToken: input.charsPerToken,
                sourceMessageCount: recentRawMessages.length,
                packedMessageCount: recentRawMessages.length,
                includedMessageCount: recentRawMessages.length,
                omittedMessageCount: 0,
            }));
        }
        return {
            rawMessages: recentRawMessages,
            summaryText: summary.summaryText,
            strategy: summary.summaryText && recentRawMessages.length > 0
                ? 'recent_plus_summary'
                : summary.summaryText
                    ? 'summary_only'
                    : 'fixed_only',
            rawHistoryMessages: recentRawMessages.length,
            summarizedHistoryMessages: olderMessages.length,
            omittedHistoryMessages: summary.omittedSourceMessages,
            sections,
        };
    }
    return {
        rawMessages: [],
        summaryText: undefined,
        strategy: 'fixed_only',
        rawHistoryMessages: 0,
        summarizedHistoryMessages: input.history.length,
        omittedHistoryMessages: input.history.length,
        sections: [],
    };
}
export function packOpenAIChatMessages(input) {
    const systemMessage = {
        role: 'system',
        content: buildModeSystemPrompt(input.systemPrompt, input.mode),
    };
    const eventMessage = {
        role: input.event.role,
        content: input.event.content,
    };
    const toolContinuationMessages = buildToolContinuationMessages({
        toolCalls: input.toolCalls,
        toolResults: input.toolResults,
    });
    const relevantHistory = input.mode === 'open'
        ? input.history.filter((message) => message.visibility === 'public')
        : input.history;
    const rawHistoryMessages = relevantHistory.map(toHistoryChatMessage);
    const fixedSections = [
        createSectionTrace({
            id: 'system',
            kind: 'system',
            value: [systemMessage],
            charsPerToken: input.charsPerToken,
            packedMessageCount: 1,
        }),
        createSectionTrace({
            id: 'event',
            kind: 'event',
            value: [eventMessage],
            charsPerToken: input.charsPerToken,
            packedMessageCount: 1,
        }),
    ];
    if (toolContinuationMessages.length > 0) {
        fixedSections.push(createSectionTrace({
            id: 'tool-continuation',
            kind: 'tool.continuation',
            value: toolContinuationMessages,
            charsPerToken: input.charsPerToken,
            packedMessageCount: toolContinuationMessages.length,
        }));
    }
    if (input.toolSchemas !== undefined) {
        fixedSections.push(createSectionTrace({
            id: 'tool-schemas',
            kind: 'tool.schemas',
            value: input.toolSchemas,
            charsPerToken: input.charsPerToken,
        }));
    }
    const responseReserveTokens = input.responseReserveTokens ?? 0;
    const fixedTokens = fixedSections.reduce((sum, section) => sum + (section.estimatedTokens ?? 0), 0) ?? 0;
    const availablePromptTokens = input.contextWindow === undefined || input.charsPerToken === undefined
        ? undefined
        : Math.max(0, input.contextWindow - responseReserveTokens - fixedTokens);
    const historyPack = buildHistoryPack({
        history: relevantHistory,
        rawHistoryMessages,
        availableTokens: availablePromptTokens,
        charsPerToken: input.charsPerToken,
    });
    const combinedSystemMessage = {
        ...systemMessage,
        content: historyPack.summaryText
            ? `${systemMessage.content}\n\n${historyPack.summaryText}`
            : systemMessage.content,
    };
    const messages = [
        combinedSystemMessage,
        ...historyPack.rawMessages,
        eventMessage,
        ...toolContinuationMessages,
    ];
    return {
        messages,
        trace: {
            strategy: historyPack.strategy,
            charsPerToken: input.charsPerToken,
            contextWindow: input.contextWindow,
            responseReserveTokens: input.contextWindow === undefined ? undefined : responseReserveTokens,
            availablePromptTokens,
            estimatedPackedPromptTokens: estimateMessagesTokens(messages, input.charsPerToken),
            historySourceMessages: relevantHistory.length,
            rawHistoryMessages: historyPack.rawHistoryMessages,
            summarizedHistoryMessages: historyPack.summarizedHistoryMessages,
            omittedHistoryMessages: historyPack.omittedHistoryMessages,
            sections: [...fixedSections, ...historyPack.sections],
        },
    };
}
//# sourceMappingURL=OpenAIChatPromptPacker.js.map