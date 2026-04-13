import type {
  CouncilMessage,
  CouncilMode,
  PromptMessage,
  PromptSummaryPolicy,
  ResolvedCouncilPromptConfig,
  ToolCall,
  ToolResult,
} from './types.js';
import { AgentContextExhaustedError } from './errors.js';
import { buildModeSystemPrompt } from './prompts.js';

export interface ResolvedPromptSummaryPolicy {
  maxMessagesPerGroup: number;
  minGroupSnippetChars: number;
  minMessageSnippetChars: number;
  shrinkTargetRatio: number;
}

export const DEFAULT_PROMPT_BUDGET_RATIO = 0.5;
export const DEFAULT_PROMPT_SUMMARY_POLICY: ResolvedPromptSummaryPolicy = {
  maxMessagesPerGroup: 3,
  minGroupSnippetChars: 24,
  minMessageSnippetChars: 18,
  shrinkTargetRatio: 0.95,
};

export type OpenAIChatMessage = PromptMessage;

interface PromptPackHistoryMessage {
  rawMessage: OpenAIChatMessage;
  summaryLabel: string;
  summaryKind: string;
  summaryText: string;
  groupKey: string;
}

export interface OpenAIContextPackSectionTrace {
  id: string;
  kind:
    | 'system'
    | 'history.summary'
    | 'history.raw'
    | 'event'
    | 'tool.continuation'
    | 'tool.schemas';
  estimatedChars: number;
  estimatedTokens?: number;
  sourceMessageCount?: number;
  packedMessageCount?: number;
  includedMessageCount?: number;
  omittedMessageCount?: number;
}

export interface OpenAIContextPackTrace {
  strategy:
    | 'full_history'
    | 'recent_plus_summary'
    | 'summary_only'
    | 'fixed_only';
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxChars: number): string {
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

function estimateJsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

export function estimateTokensFromText(
  text: string,
  charsPerToken: number
): number {
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

function estimateValueTokens(value: unknown, charsPerToken: number): number {
  return estimateTokensFromText(JSON.stringify(value), charsPerToken);
}

function estimateMessagesTokens(
  messages: OpenAIChatMessage[],
  charsPerToken: number
): number {
  return estimateValueTokens(messages, charsPerToken);
}

function splitContextWindow(
  contextWindow: number,
  promptBudgetRatio: number
): {
  promptBudgetTokens: number;
  reservedForResponseAndToolsTokens: number;
} {
  // Prompt construction gets an explicit ratio of the advertised window; the
  // remainder is intentionally left for completion tokens and tool round-trips.
  const promptBudgetTokens = Math.max(
    1,
    Math.min(contextWindow - 1, Math.floor(contextWindow * promptBudgetRatio))
  );
  return {
    promptBudgetTokens,
    reservedForResponseAndToolsTokens: Math.max(
      0,
      contextWindow - promptBudgetTokens
    ),
  };
}

function resolvePromptSummaryPolicy(
  input?: PromptSummaryPolicy
): ResolvedPromptSummaryPolicy {
  return {
    maxMessagesPerGroup:
      input?.maxMessagesPerGroup ??
      DEFAULT_PROMPT_SUMMARY_POLICY.maxMessagesPerGroup,
    minGroupSnippetChars:
      input?.minGroupSnippetChars ??
      DEFAULT_PROMPT_SUMMARY_POLICY.minGroupSnippetChars,
    minMessageSnippetChars:
      input?.minMessageSnippetChars ??
      DEFAULT_PROMPT_SUMMARY_POLICY.minMessageSnippetChars,
    shrinkTargetRatio:
      input?.shrinkTargetRatio ??
      DEFAULT_PROMPT_SUMMARY_POLICY.shrinkTargetRatio,
  };
}

function formatPromptMessageContent(message: OpenAIChatMessage): string {
  const fragments: string[] = [];

  if (message.role === 'tool' && message.tool_call_id) {
    fragments.push(`[tool_call_id=${message.tool_call_id}]`);
  }

  if (message.content.trim().length > 0) {
    fragments.push(message.content);
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const call of message.tool_calls) {
      fragments.push(
        `[tool call ${call.id}] ${call.function.name}(${call.function.arguments})`
      );
    }
  }

  if (fragments.length === 0) {
    return `(empty ${message.role} message)`;
  }

  return fragments.join('\n');
}

function toHistoryChatMessage(message: CouncilMessage): OpenAIChatMessage {
  return {
    role:
      message.author.type === 'agent' || message.author.type === 'oracle'
        ? 'assistant'
        : 'user',
    content: `${message.author.name}: ${message.content}`,
  };
}

function toHistorySourceMessage(message: CouncilMessage): PromptPackHistoryMessage {
  return {
    rawMessage: toHistoryChatMessage(message),
    summaryLabel: message.author.name,
    summaryKind: message.visibility,
    summaryText: message.content,
    groupKey: `${message.author.name}:${message.visibility}`,
  };
}

function toPromptHistorySourceMessage(
  message: OpenAIChatMessage
): PromptPackHistoryMessage {
  const roleLabel =
    message.name && message.name.trim().length > 0
      ? message.name
      : message.role === 'system'
        ? 'System'
        : message.role === 'user'
          ? 'User'
          : message.role === 'assistant'
            ? 'Assistant'
            : message.tool_call_id
              ? `Tool ${message.tool_call_id}`
              : 'Tool';

  const toolCallIds =
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? `:${message.tool_calls.map((call) => call.id).join(',')}`
      : '';

  return {
    rawMessage: message,
    summaryLabel: roleLabel,
    summaryKind: message.role,
    summaryText: formatPromptMessageContent(message),
    groupKey: `${message.role}:${message.name ?? ''}:${message.tool_call_id ?? ''}${toolCallIds}`,
  };
}

function buildToolContinuationMessages(input: {
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}): OpenAIChatMessage[] {
  if (!input.toolCalls || input.toolCalls.length === 0) {
    return [];
  }

  const messages: OpenAIChatMessage[] = [];
  const resultsById = new Map<string, ToolResult>();
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

    const content =
      result.content ??
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

function groupHistoryMessages(messages: PromptPackHistoryMessage[]) {
  const groups: Array<{
    label: string;
    kind: string;
    groupKey: string;
    messages: PromptPackHistoryMessage[];
  }> = [];

  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && last.groupKey === message.groupKey) {
      last.messages.push(message);
      continue;
    }

    groups.push({
      label: message.summaryLabel,
      kind: message.summaryKind,
      groupKey: message.groupKey,
      messages: [message],
    });
  }

  return groups;
}

function buildHistorySummaryText(input: {
  messages: PromptPackHistoryMessage[];
  maxChars: number;
  summaryPolicy: ResolvedPromptSummaryPolicy;
}): {
  text: string;
  includedSourceMessages: number;
  omittedSourceMessages: number;
} {
  const { messages, maxChars, summaryPolicy } = input;
  if (messages.length === 0 || maxChars <= 0) {
    return {
      text: '',
      includedSourceMessages: 0,
      omittedSourceMessages: messages.length,
    };
  }

  const participantNames = Array.from(
    new Set(messages.map((message) => message.summaryLabel))
  );
  const kindCounts = new Map<string, number>();
  for (const message of messages) {
    kindCounts.set(
      message.summaryKind,
      (kindCounts.get(message.summaryKind) ?? 0) + 1
    );
  }
  const kindSummary =
    Array.from(kindCounts.entries())
      .map(([kind, count]) => `${count} ${kind}`)
      .join(', ') || 'none';

  const headerLines = [
    `Earlier conversation summary for ${messages.length} messages.`,
    `Participants: ${participantNames.join(', ') || 'none'}.`,
    `Kind mix: ${kindSummary}.`,
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

    const reservedForOmission =
      remainingGroups > 0
        ? `\n... ${messages.length - includedSourceMessages} older messages compressed further.`
            .length
        : 0;
    const availableLineChars = Math.max(
      0,
      remainingChars - reservedForOmission
    );
    if (availableLineChars <= 0) {
      break;
    }

    const prefix = `- ${group.label} (${group.kind}`;
    const prefixWithCount =
      group.messages.length > 1
        ? `${prefix}, ${group.messages.length} msgs): `
        : `${prefix}): `;
    const snippetBudget = Math.max(
      summaryPolicy.minGroupSnippetChars,
      availableLineChars - prefixWithCount.length
    );
    const perMessageBudget = Math.max(
      summaryPolicy.minMessageSnippetChars,
      Math.floor(
        snippetBudget /
          Math.min(group.messages.length, summaryPolicy.maxMessagesPerGroup)
      )
    );
    const snippets = group.messages
      .slice(0, summaryPolicy.maxMessagesPerGroup)
      .map((message) => truncateText(message.summaryText, perMessageBudget));
    let line = `${prefixWithCount}${snippets.join(' | ')}`;
    if (group.messages.length > summaryPolicy.maxMessagesPerGroup) {
      line += ` (+${group.messages.length - summaryPolicy.maxMessagesPerGroup} more)`;
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

function buildHistorySummaryMessage(input: {
  messages: PromptPackHistoryMessage[];
  maxTokens: number;
  charsPerToken: number;
  summaryPolicy: ResolvedPromptSummaryPolicy;
}): {
  summaryText?: string;
  includedSourceMessages: number;
  omittedSourceMessages: number;
} {
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
    summaryPolicy: input.summaryPolicy,
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
    const targetChars = Math.max(
      0,
      Math.floor(
        content.length *
          ((input.maxTokens / estimatedTokens) *
            input.summaryPolicy.shrinkTargetRatio)
      )
    );
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

function createSectionTrace(input: {
  id: OpenAIContextPackSectionTrace['id'];
  kind: OpenAIContextPackSectionTrace['kind'];
  value: unknown;
  charsPerToken: number;
  sourceMessageCount?: number;
  packedMessageCount?: number;
  includedMessageCount?: number;
  omittedMessageCount?: number;
}): OpenAIContextPackSectionTrace {
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

function buildHistoryPack(input: {
  history: PromptPackHistoryMessage[];
  availableTokens: number;
  charsPerToken: number;
  summaryPolicy: ResolvedPromptSummaryPolicy;
}): {
  rawMessages: OpenAIChatMessage[];
  summaryText?: string;
  strategy:
    | 'full_history'
    | 'recent_plus_summary'
    | 'summary_only'
    | 'fixed_only';
  rawHistoryMessages: number;
  summarizedHistoryMessages: number;
  omittedHistoryMessages: number;
  sections: OpenAIContextPackSectionTrace[];
} {
  const rawHistoryMessages = input.history.map((message) => message.rawMessage);
  const fullHistoryTokens =
    estimateMessagesTokens(rawHistoryMessages, input.charsPerToken);
  if (fullHistoryTokens <= input.availableTokens) {
    return {
      rawMessages: rawHistoryMessages,
      summaryText: undefined,
      strategy: 'full_history',
      rawHistoryMessages: rawHistoryMessages.length,
      summarizedHistoryMessages: 0,
      omittedHistoryMessages: 0,
      sections:
        rawHistoryMessages.length > 0
          ? [
              createSectionTrace({
                id: 'history-raw',
                kind: 'history.raw',
                value: rawHistoryMessages,
                charsPerToken: input.charsPerToken,
                sourceMessageCount: input.history.length,
                packedMessageCount: rawHistoryMessages.length,
                includedMessageCount: input.history.length,
                omittedMessageCount: 0,
              }),
            ]
          : [],
    };
  }

  for (let splitIndex = 0; splitIndex <= input.history.length; splitIndex += 1) {
    const recentRawMessages = rawHistoryMessages.slice(splitIndex);
    const recentRawTokens = estimateMessagesTokens(
      recentRawMessages,
      input.charsPerToken
    );
    if (recentRawTokens > input.availableTokens) {
      continue;
    }

    const olderMessages = input.history.slice(0, splitIndex);
    const summaryBudgetTokens = input.availableTokens - recentRawTokens;
    const summary = buildHistorySummaryMessage({
      messages: olderMessages,
      maxTokens: summaryBudgetTokens,
      charsPerToken: input.charsPerToken,
      summaryPolicy: input.summaryPolicy,
    });
    const packedTokens =
      (summary.summaryText
        ? estimateTokensFromText(summary.summaryText, input.charsPerToken)
        : 0) +
      estimateMessagesTokens(recentRawMessages, input.charsPerToken);

    if (packedTokens > input.availableTokens) {
      continue;
    }

    const sections: OpenAIContextPackSectionTrace[] = [];
    if (summary.summaryText) {
      sections.push(
        createSectionTrace({
          id: 'history-summary',
          kind: 'history.summary',
          value: summary.summaryText,
          charsPerToken: input.charsPerToken,
          sourceMessageCount: olderMessages.length,
          packedMessageCount: 0,
          includedMessageCount: summary.includedSourceMessages,
          omittedMessageCount: summary.omittedSourceMessages,
        })
      );
    }
    if (recentRawMessages.length > 0) {
      sections.push(
        createSectionTrace({
          id: 'history-raw',
          kind: 'history.raw',
          value: recentRawMessages,
          charsPerToken: input.charsPerToken,
          sourceMessageCount: recentRawMessages.length,
          packedMessageCount: recentRawMessages.length,
          includedMessageCount: recentRawMessages.length,
          omittedMessageCount: 0,
        })
      );
    }

    return {
      rawMessages: recentRawMessages,
      summaryText: summary.summaryText,
      strategy:
        summary.summaryText && recentRawMessages.length > 0
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
    summarizedHistoryMessages: 0,
    omittedHistoryMessages: input.history.length,
    sections: [],
  };
}

function buildAdditionalSystemContextPrompt(
  systemMessages: OpenAIChatMessage[]
): string | undefined {
  if (systemMessages.length === 0) {
    return undefined;
  }

  if (systemMessages.length === 1 && !systemMessages[0].name) {
    return systemMessages[0].content;
  }

  const lines = ['Additional request system context:'];
  for (const [index, message] of systemMessages.entries()) {
    const label =
      message.name && message.name.trim().length > 0
        ? `#${index + 1} (${message.name})`
        : `#${index + 1}`;
    lines.push(`${label} ${message.content}`.trim());
  }

  return lines.join('\n');
}

function packPreparedOpenAIChatMessages(input: {
  systemPrompt: string;
  mode: CouncilMode;
  promptConfig?: ResolvedCouncilPromptConfig;
  fixedSystemMessages?: OpenAIChatMessage[];
  history: PromptPackHistoryMessage[];
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
}): OpenAIChatPromptPackResult {
  const baseSystemMessage: OpenAIChatMessage = {
    role: 'system',
    content: buildModeSystemPrompt({
      systemPrompt: input.systemPrompt,
      mode: input.mode,
      prompts: input.promptConfig,
    }),
  };
  const eventMessage: OpenAIChatMessage = {
    role: input.event.role,
    content: input.event.content,
  };
  const toolContinuationMessages = buildToolContinuationMessages({
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
  });

  const fixedSystemMessages = input.fixedSystemMessages ?? [];
  const fixedSections: OpenAIContextPackSectionTrace[] = [
    createSectionTrace({
      id: 'system',
      kind: 'system',
      value: [baseSystemMessage],
      charsPerToken: input.charsPerToken,
      packedMessageCount: 1,
    }),
  ];
  if (fixedSystemMessages.length > 0) {
    fixedSections.push(
      createSectionTrace({
        id: 'system-context',
        kind: 'system',
        value: fixedSystemMessages,
        charsPerToken: input.charsPerToken,
        sourceMessageCount: fixedSystemMessages.length,
        packedMessageCount: fixedSystemMessages.length,
      })
    );
  }
  fixedSections.push(
    createSectionTrace({
      id: 'event',
      kind: 'event',
      value: [eventMessage],
      charsPerToken: input.charsPerToken,
      packedMessageCount: 1,
    })
  );
  if (toolContinuationMessages.length > 0) {
    fixedSections.push(
      createSectionTrace({
        id: 'tool-continuation',
        kind: 'tool.continuation',
        value: toolContinuationMessages,
        charsPerToken: input.charsPerToken,
        packedMessageCount: toolContinuationMessages.length,
      })
    );
  }
  if (input.toolSchemas !== undefined) {
    fixedSections.push(
      createSectionTrace({
        id: 'tool-schemas',
        kind: 'tool.schemas',
        value: input.toolSchemas,
        charsPerToken: input.charsPerToken,
      })
    );
  }

  const promptBudgetRatio = input.promptBudgetRatio ?? DEFAULT_PROMPT_BUDGET_RATIO;
  const promptSummaryPolicy = resolvePromptSummaryPolicy(
    input.promptSummaryPolicy
  );
  const contextBudget = splitContextWindow(
    input.contextWindow,
    promptBudgetRatio
  );
  const uncontrolledFixedSections = fixedSections.filter((section) => {
    return (
      section.kind === 'system' ||
      section.kind === 'tool.continuation' ||
      section.kind === 'tool.schemas'
    );
  });
  const uncontrolledFixedTokens = uncontrolledFixedSections.reduce(
    (sum, section) => sum + (section.estimatedTokens ?? 0),
    0
  );
  if (uncontrolledFixedTokens > contextBudget.promptBudgetTokens) {
    throw new AgentContextExhaustedError(
      'Agent fixed inputs exceed the configured prompt budget',
      {
        reason: 'uncontrolled_fixed_inputs_exceed_prompt_budget',
        promptBudgetTokens: contextBudget.promptBudgetTokens,
        uncontrolledFixedTokens,
        sections: uncontrolledFixedSections.map((section) => ({
          id: section.id,
          kind: section.kind,
          estimatedChars: section.estimatedChars,
          estimatedTokens: section.estimatedTokens,
        })),
      }
    );
  }

  const fixedTokens = fixedSections.reduce(
    (sum, section) => sum + (section.estimatedTokens ?? 0),
    0
  );
  if (fixedTokens > contextBudget.promptBudgetTokens) {
    throw new Error(
      `Fixed prompt sections exceed prompt budget (${fixedTokens} > ${contextBudget.promptBudgetTokens} estimated tokens)`
    );
  }

  const availableHistoryTokens = Math.max(
    0,
    contextBudget.promptBudgetTokens - fixedTokens
  );

  const historyPack = buildHistoryPack({
    history: input.history,
    availableTokens: availableHistoryTokens,
    charsPerToken: input.charsPerToken,
    summaryPolicy: promptSummaryPolicy,
  });

  const additionalSystemContext = buildAdditionalSystemContextPrompt(
    fixedSystemMessages
  );
  const combinedSystemParts = [baseSystemMessage.content];
  if (additionalSystemContext) {
    combinedSystemParts.push(additionalSystemContext);
  }
  if (historyPack.summaryText) {
    combinedSystemParts.push(historyPack.summaryText);
  }
  const combinedSystemMessage: OpenAIChatMessage = {
    ...baseSystemMessage,
    content: combinedSystemParts.join('\n\n'),
  };

  const messages = [
    combinedSystemMessage,
    ...historyPack.rawMessages,
    eventMessage,
    ...toolContinuationMessages,
  ];
  const toolSchemaTokens =
    fixedSections.find((section) => section.kind === 'tool.schemas')
      ?.estimatedTokens ?? 0;
  const estimatedPackedPromptTokens =
    estimateMessagesTokens(messages, input.charsPerToken) + toolSchemaTokens;

  if (estimatedPackedPromptTokens > contextBudget.promptBudgetTokens) {
    throw new Error(
      `Packed prompt exceeds prompt budget (${estimatedPackedPromptTokens} > ${contextBudget.promptBudgetTokens} estimated tokens)`
    );
  }

  return {
    messages,
    trace: {
      strategy: historyPack.strategy,
      charsPerToken: input.charsPerToken,
      contextWindow: input.contextWindow,
      promptBudgetRatio,
      promptSummaryPolicy,
      promptBudgetTokens: contextBudget.promptBudgetTokens,
      reservedForResponseAndToolsTokens:
        contextBudget.reservedForResponseAndToolsTokens,
      availableHistoryTokens,
      estimatedPackedPromptTokens,
      historySourceMessages: input.history.length,
      rawHistoryMessages: historyPack.rawHistoryMessages,
      summarizedHistoryMessages: historyPack.summarizedHistoryMessages,
      omittedHistoryMessages: historyPack.omittedHistoryMessages,
      sections: [...fixedSections, ...historyPack.sections],
    },
  };
}

export function packOpenAIChatMessages(input: {
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
}): OpenAIChatPromptPackResult {
  const relevantHistory =
    input.mode === 'open'
      ? input.history.filter((message) => message.visibility === 'public')
      : input.history;
  return packPreparedOpenAIChatMessages({
    systemPrompt: input.systemPrompt,
    mode: input.mode,
    promptConfig: input.promptConfig,
    history: relevantHistory.map(toHistorySourceMessage),
    event: input.event,
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    toolSchemas: input.toolSchemas,
    contextWindow: input.contextWindow,
    charsPerToken: input.charsPerToken,
    promptBudgetRatio: input.promptBudgetRatio,
    promptSummaryPolicy: input.promptSummaryPolicy,
  });
}

export function packOpenAIChatPromptMessages(input: {
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
}): OpenAIChatPromptPackResult {
  const fixedSystemMessages = input.promptMessages.filter(
    (message) => message.role === 'system'
  );
  const historyMessages = input.promptMessages
    .filter((message) => message.role !== 'system')
    .map(toPromptHistorySourceMessage);

  return packPreparedOpenAIChatMessages({
    systemPrompt: input.systemPrompt,
    mode: input.mode,
    promptConfig: input.promptConfig,
    fixedSystemMessages,
    history: historyMessages,
    event: input.event,
    toolCalls: input.toolCalls,
    toolResults: input.toolResults,
    toolSchemas: input.toolSchemas,
    contextWindow: input.contextWindow,
    charsPerToken: input.charsPerToken,
    promptBudgetRatio: input.promptBudgetRatio,
    promptSummaryPolicy: input.promptSummaryPolicy,
  });
}
