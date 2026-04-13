# `council-of-experts` Contract

This document defines the contract between the `council-of-experts` module and host applications.

The goal is to make the boundary explicit:

- `council-of-experts` owns the in-memory council runtime, operating modes, hidden/private channel, orchestration, tool decisioning, and diagnostics.
- The host application owns persistence, event sourcing, filesystem access, recovery policy, UI, permissions, and any application-specific logs or event stores.

This contract is intended for two audiences:

- implementers of `council-of-experts`
- applications integrating `council-of-experts`

## 1. Scope and non-goals

`council-of-experts` is a prompt-centric multi-agent runtime.

It does **not** own durable storage.

In particular, `council-of-experts` must **not** create, open, modify, rotate, or manage files. It must not assume any on-disk layout. A host may persist council state in a single append-only text log, in a database, or in another event store. The module is agnostic.

The intended integration pattern is:

1. the host opens one in-memory council per application entity, such as one council per idea
2. the host replays previously persisted events into the council
3. the host posts new user/system events to the council
4. the host persists the council records returned by the council
5. the host uses council diagnostics for monitoring, debugging, and UI

## 2. Design boundary

### 2.1 `council-of-experts` owns

`council-of-experts` owns all in-memory council behavior, including:

- agent lifecycle
- operating modes: `open`, `council`, `oracle`
- hidden/private council channel
- internal orchestration logic
- any relevance checks, internal deliberation, review, or synthesis logic
- tool call decisions
- runtime diagnostics and status snapshots
- replay of persisted council records into in-memory state

The exact internal algorithm is implementation-defined. The contract does not require a particular reasoning topology.

### 2.2 Host application owns

The host application owns:

- the canonical event log or other persistence mechanism
- application-level identifiers such as idea ids and user ids
- mapping application events into `ChatEvent`
- replay order and recovery policy
- storage of public messages, private messages, and council records
- access control over hidden/private council data
- actual execution of tools, if tools are enabled
- UI and developer diagnostics surfaces

## 3. Core model

A council is an in-memory runtime instance identified by a `councilId`.

A council can operate in one of three modes:

- `open`: agents may speak independently in public
- `council`: agents may deliberate in a private channel and may then emit public messages
- `oracle`: agents deliberate privately but the outward response is unified as one voice

The council maintains in-memory state derived from two kinds of replayable input:

- host chat events
- council records previously emitted by the module

The council may also expose non-replayable diagnostics. These diagnostics are intentionally unstable across versions.

## 4. Replay model

Replay is central to the contract.

On application boot, the host opens a council and replays the relevant persisted history into it. This reconstructs the in-memory state without rerunning models or tools.

Important rules:

- replay must be pure state reconstruction
- replay must not call LLMs
- replay must not call tools
- replay must not touch persistence
- replay order must match the original append order from the host log
- reconstructed message order must match the original `message.emitted` record order

If the host wants private council messages, mode transitions, tool activity, and other council activity to survive reboot, it must persist the corresponding `CouncilRecord` values returned by the module.

## 5. Durability model

`council-of-experts` is stateful in memory but not durable by itself.

A host must treat `TurnResult.records` as the durable output of a turn.

Recommended sequence:

1. persist the inbound user/system chat event in the host log, or otherwise make it durable
2. call `council.post(...)` or `council.stream(...)`
3. persist the returned `CouncilRecord[]`
4. only then treat the council turn as durably committed

If persistence of returned records fails, the host should discard the in-memory council instance and rebuild it from the durable log. This avoids divergence between durable state and in-memory state.

`council-of-experts` does not provide transactions.

## 6. Stable contract vs unstable diagnostics

The contract has two categories.

### 6.1 Stable contract

These are intended to be stable and replayable:

- the TypeScript API in this document
- `ChatEvent`
- `CouncilMessage`
- `CouncilRecord`
- `CouncilReplayEntry`
- `TurnResult`
- the semantics of `replay()`, `post()`, `stream()`, and `getMessages()`

### 6.2 Unstable diagnostics

`getStatus()` is intentionally unstable.

It may return any JSON-serializable object that exposes internal state useful for debugging, inspection, or developer tooling. Its schema is not guaranteed to be compatible across versions.

Host applications may display or inspect `getStatus()`, but they must not rely on its exact shape for durable persistence or long-term compatibility.

## 7. TypeScript API

```ts
export const COUNCIL_CONTRACT_VERSION = 1 as const;

export type CouncilMode = 'open' | 'council' | 'oracle';

export interface CouncilError {
  message: string;
  code?: string;
  data?: unknown;
}

export interface TurnError {
  agentId?: string;
  error: CouncilError;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ToolRef = string | ToolDefinition;

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
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

export interface PromptSummaryPolicy {
  maxMessagesPerGroup?: number;
  minGroupSnippetChars?: number;
  minMessageSnippetChars?: number;
  shrinkTargetRatio?: number;
}

export interface CouncilPromptConfig {
  councilModeSystemAddendum?: string;
  oracleModeSystemAddendum?: string;
  councilSynthesisTemplate?: string;
  oracleSynthesisTemplate?: string;
}

export interface ResolvedCouncilPromptConfig {
  councilModeSystemAddendum: string;
  oracleModeSystemAddendum: string;
  councilSynthesisTemplate: string;
  oracleSynthesisTemplate: string;
}

export interface EngineSpec {
  id: string;
  provider?: string;
  model: string;
  contextWindow?: number;
  charsPerToken?: number;
  promptBudgetRatio?: number;
  promptSummaryPolicy?: PromptSummaryPolicy;
  settings?: Record<string, unknown>;
}

export interface AgentDefinition {
  id: string;
  name: string;
  engine: EngineSpec;
  summary: string;
  systemPrompt: string;
  tools?: ToolRef[];
  metadata?: Record<string, unknown>;
}

export interface OpenCouncilInput {
  councilId: string;
  initialMode?: CouncilMode;
  metadata?: Record<string, unknown>;
}

export interface ChatEvent {
  id?: string;
  actor: {
    type: 'user' | 'agent' | 'system';
    id: string;
    name?: string;
  };
  content: string;
  promptMessages?: PromptMessage[];
  timestamp?: string | number | Date;
  metadata?: Record<string, unknown>;
}

export interface CouncilMessage {
  id: string;
  turnId: string;
  author: {
    type: 'agent' | 'oracle' | 'system';
    id: string;
    name: string;
  };
  visibility: 'public' | 'private';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  callId?: string;
  content?: string;
  data?: unknown;
  error?: string;
}

export interface ToolExecutionContext {
  councilId: string;
  turnId: string;
  agentId: string;
}

export interface ToolHost {
  execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export interface EngineInput {
  councilId: string;
  turnId: string;
  agent: AgentDefinition;
  mode: CouncilMode;
  event: ChatEvent;
  history: CouncilMessage[];
  promptConfig?: ResolvedCouncilPromptConfig;
  tools?: ToolDefinition[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface EngineOutput {
  content: string;
  metadata?: Record<string, unknown>;
  toolCalls?: ToolCall[];
}

export interface EngineAdapter {
  generate(input: EngineInput): Promise<EngineOutput>;
  stream?(input: EngineInput): AsyncIterable<EngineOutput>;
}

export interface CouncilModuleConfig {
  agents: AgentDefinition[];
  engines: Record<string, EngineAdapter>;
  toolHost?: ToolHost;
  runtime?: Partial<CouncilRuntimeConfig>;
  prompts?: Partial<CouncilPromptConfig>;
}

export interface CouncilRuntimeConfig {
  initialMode: CouncilMode;
  maxRounds: number;
  maxAgentReplies?: number;
  agentSelectionStrategy: 'all_in_order';
  oracleSpeakerStrategy: 'first_active' | 'by_id';
  oracleSpeakerAgentId?: string;
}

export interface CouncilModuleResolvedConfig {
  runtime: CouncilRuntimeConfig;
  prompts: ResolvedCouncilPromptConfig;
}

export interface CouncilInstanceResolvedConfig {
  councilId: string;
  initialMode: CouncilMode;
  runtime: CouncilRuntimeConfig;
  prompts: ResolvedCouncilPromptConfig;
  metadata?: Record<string, unknown>;
}

export interface TurnOptions {
  mode?: CouncilMode;
  maxRounds?: number;
  maxAgentReplies?: number;
  emitPublicOracle?: boolean;
  oracleSpeakerAgentId?: string;
  trace?: boolean;
}

export type CouncilRecord =
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'mode.changed';
      councilId: string;
      turnId: string;
      timestamp: string;
      from: CouncilMode;
      to: CouncilMode;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'message.emitted';
      councilId: string;
      turnId: string;
      timestamp: string;
      message: CouncilMessage;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'tool.called';
      councilId: string;
      turnId: string;
      timestamp: string;
      agentId: string;
      callId: string;
      call: ToolCall;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'tool.result';
      councilId: string;
      turnId: string;
      timestamp: string;
      agentId: string;
      callId: string;
      result: ToolResult;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'turn.completed';
      councilId: string;
      turnId: string;
      timestamp: string;
      mode: CouncilMode;
    }
  | {
      contractVersion: typeof COUNCIL_CONTRACT_VERSION;
      type: 'error';
      councilId: string;
      turnId: string;
      timestamp: string;
      agentId?: string;
      error: CouncilError;
    };

export type CouncilReplayEntry =
  | {
      type: 'host.chat';
      event: ChatEvent;
    }
  | {
      type: 'council.record';
      record: CouncilRecord;
    };

export interface TurnResult {
  turnId: string;
  mode: CouncilMode;
  nextMode?: CouncilMode;
  publicMessages: CouncilMessage[];
  privateMessages: CouncilMessage[];
  records: CouncilRecord[];
  errors: TurnError[];
}

export type CouncilRuntimeEvent =
  | {
      type: 'turn.started';
      councilId: string;
      turnId: string;
      timestamp: string;
      mode: CouncilMode;
    }
  | {
      type: 'agent.started';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
    }
  | {
      type: 'agent.finished';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
    }
  | {
      type: 'message.emitted';
      councilId: string;
      turnId: string;
      timestamp: string;
      message: CouncilMessage;
    }
  | {
      type: 'tool.called';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
      callId: string;
      call: ToolCall;
    }
  | {
      type: 'tool.result';
      councilId: string;
      turnId: string;
      agentId: string;
      timestamp: string;
      callId: string;
      result: ToolResult;
    }
  | {
      type: 'mode.changed';
      councilId: string;
      turnId: string;
      timestamp: string;
      from: CouncilMode;
      to: CouncilMode;
    }
  | {
      type: 'turn.completed';
      councilId: string;
      turnId: string;
      timestamp: string;
      mode: CouncilMode;
    }
  | {
      type: 'error';
      councilId: string;
      turnId?: string;
      agentId?: string;
      timestamp: string;
      error: CouncilError;
    };

export interface Council {
  getMode(): CouncilMode;

  getConfig(): CouncilInstanceResolvedConfig;

  replay(
    entries: Iterable<CouncilReplayEntry> | AsyncIterable<CouncilReplayEntry>
  ): Promise<void>;

  post(event: ChatEvent, options?: TurnOptions): Promise<TurnResult>;

  stream(
    event: ChatEvent,
    options?: TurnOptions
  ): AsyncIterable<CouncilRuntimeEvent>;

  getMessages(options?: {
    visibility?: 'public' | 'private' | 'all';
    limit?: number;
  }): Promise<CouncilMessage[]>;

  getStatus(): Promise<unknown>;

  dispose(): Promise<void>;
}

export interface CouncilModule {
  openCouncil(input: OpenCouncilInput): Promise<Council>;
  listAgents(): AgentDefinition[];
  getConfig(): CouncilModuleResolvedConfig;
}

export declare function createCouncilModule(
  config: CouncilModuleConfig
): CouncilModule;
```

## 8. Semantics of the API

### 8.1 `openCouncil(...)`

`openCouncil(...)` creates an in-memory council instance.

It must not load files, read databases, or perform any durable storage access. It does not imply that the council is new in the durable sense. The host decides whether a council is new or recovered.

If `OpenCouncilInput.initialMode` is omitted, the module runtime default is used.

### 8.2 `replay(...)`

`replay(...)` reconstructs in-memory state from persisted host chat events and persisted council records.

Hosts should call `replay(...)` during bootstrap, using the original append order from their durable log.

`replay(...)` must not:

- generate new model outputs
- execute tools
- emit durable records
- mutate host persistence

A council should be able to recover its visible and private message history, mode, and tool history from replayed records.

### 8.3 `post(...)`

`post(...)` processes one inbound chat event and returns the council output for that turn.

The council may:

- emit public messages
- emit private messages
- change mode
- request tools through the configured `ToolHost`
- emit replayable `CouncilRecord[]`
- surface non-stream execution failures in `TurnResult.errors`

The host persists the returned records.

### 8.4 `stream(...)`

`stream(...)` is the live observation API for a turn.

It exposes runtime events while a turn is running. It is intended for developer tooling, progress monitoring, hidden-channel inspection, and real-time UI.

`stream(...)` does not replace `TurnResult.records`. The records remain the durable replay contract.

### 8.5 `getMessages(...)`

`getMessages(...)` returns the council message history currently held in memory.

The returned array and message objects are detached snapshots. Mutating them must
not mutate the internal council state.

The `visibility` filter exists so the host can inspect:

- only public messages
- only private/hidden messages
- all messages

If the host wants private messages to survive reboot, it must persist the `message.emitted` records corresponding to those messages.

### 8.5a `getConfig()`

`getConfig()` returns a stable snapshot of the resolved runtime configuration and built-in prompt templates.

For `CouncilModule`, it exposes module-level defaults such as `initialMode`, `maxRounds`, `maxAgentReplies`, `agentSelectionStrategy`, `oracleSpeakerStrategy`, `oracleSpeakerAgentId`, and the resolved built-in prompt templates.

For `Council`, it exposes the council id, the effective initial mode used when the council was opened, and the same resolved runtime defaults and prompt templates.

For the built-in OpenAI adapter, prompt-packing policy is not part of `getConfig()`. It remains agent-level engine configuration through `EngineSpec.promptBudgetRatio` and `EngineSpec.promptSummaryPolicy`, and the effective values are exposed per call under `EngineOutput.metadata.tokenEstimate.promptPack`.

### 8.6 `getStatus()`

`getStatus()` returns intentionally unstable debug state.

Typical contents may include:

- current mode
- last active turn
- agent activity state
- council-private message buffers
- recent tool calls
- pending work
- internal summaries
- implementation-specific traces

This payload is for diagnostics only.

### 8.7 `dispose()`

`dispose()` releases in-memory resources for the council.

It must not delete durable state, because durable state is owned by the host.

## 9. Messages, records, and history

There are three related but distinct concepts.

### 9.1 Chat events

A `ChatEvent` is an inbound application event. For example:

- a user message
- a system instruction
- a host-generated event

A `ChatEvent` is what the host passes into `post(...)`.

### 9.2 Council messages

A `CouncilMessage` is a message emitted by the council runtime. It has visibility:

- `public`
- `private`

Private messages are the hidden council channel and any other non-public council output the runtime chooses to expose.

### 9.3 Council records

A `CouncilRecord` is the replayable durable representation of council activity. Records are what the host persists if it wants the council to recover that activity after reboot.

The host does not need to understand all internal meaning of the records. It only needs to persist them and replay them in order.

## 10. Tools

Tool execution is split across the boundary.

`council-of-experts` decides:

- whether a tool is needed
- which tool to call
- when to call it
- how to use the result in the turn

The host application provides the execution boundary through `ToolHost`.

The host therefore controls:

- the actual tool implementations
- permissions
- network and filesystem access
- retries and timeouts
- auditing and policy enforcement

Every tool call that is intended to survive reboot should be represented in the returned `CouncilRecord[]` via `tool.called` and `tool.result`.

### 10.1 Tool call flow

- The engine adapter can request tools by returning `EngineOutput.toolCalls`.
- The council executes those calls through `ToolHost`, emitting `tool.called` / `tool.result` records (and runtime events).
- The council then calls the engine again with `EngineInput.toolCalls` + `EngineInput.toolResults` populated for the current turn.
- Tool calls are only executed if the tool name appears in `agent.tools`. Otherwise a failed `ToolResult` is returned.
- `createCouncilModule({ prompts })` resolves the built-in council/oracle workflow prompts once and passes them to the built-in adapter as `EngineInput.promptConfig`.
- For the built-in OpenAI adapter, prompt-packing policy is explicit through `EngineSpec.promptBudgetRatio` and `EngineSpec.promptSummaryPolicy`. If omitted, the exported defaults are used.
- For the built-in OpenAI adapter, `ChatEvent.promptMessages` can carry structured prior chat history. That history is packed with the same budgeting and summary policy as native council history instead of being flattened into a single transcript string.
- `TurnOptions.maxRounds` limits tool-call round trips per agent. If omitted, the module runtime default is used; the built-in default is `3`.

For oracle mode, public-speaker selection is also explicit:

- `CouncilRuntimeConfig.oracleSpeakerStrategy = 'first_active'` uses the first active agent in configured order
- `CouncilRuntimeConfig.oracleSpeakerStrategy = 'by_id'` uses `CouncilRuntimeConfig.oracleSpeakerAgentId`
- `TurnOptions.oracleSpeakerAgentId` overrides the runtime choice for one turn

Tool definitions (name/description/parameters) can be provided in `agent.tools` as `ToolDefinition` entries. The council passes the normalized definitions to the engine in `EngineInput.tools`.

## 11. Hidden/private channel access

A host application may inspect the hidden/private channel.

That is a supported use case.

The stable access paths are:

- `TurnResult.privateMessages`
- `getMessages({ visibility: 'private' })`
- replayed `message.emitted` records whose `message.visibility` is `private`

For real-time inspection during a running turn, the host can use `stream(...)`.

Access control over private messages is not the responsibility of `council-of-experts`. The host must decide who is allowed to see them.

## 12. Recommended host integration pattern

For a host using a single append-only log per council entity, the recommended pattern is:

### 12.1 Boot

1. create one in-memory council per entity by calling `openCouncil({ councilId: entityId, ... })`
2. read the relevant host log or event stream
3. transform the relevant durable events into `CouncilReplayEntry[]`
4. call `council.replay(...)`

### 12.2 On new user chat input

1. append the user chat event to the host log, or otherwise make it durable
2. call `council.post(chatEvent)`
3. append `TurnResult.records` to the host log
4. publish any public messages to the application UI
5. inspect `TurnResult.errors` if the host wants to surface non-stream failures
6. optionally expose private messages and `getStatus()` in diagnostics tooling

### 12.3 On persistence failure after `post(...)`

1. discard the in-memory council
2. reopen a new council instance
3. replay from the durable log

This keeps runtime state aligned with durable state.

## 13. Example integration sketch

```ts
const councilModule = createCouncilModule({
  agents,
  engines,
  toolHost,
});

const council = await councilModule.openCouncil({
  councilId: ideaId,
  initialMode: 'open',
});

await council.replay(loadReplayEntriesFromIdeaLog(ideaId));

const chatEvent: ChatEvent = {
  actor: { type: 'user', id: user.id, name: user.name },
  content: messageText,
  timestamp: new Date().toISOString(),
};

await appendHostChatEventToIdeaLog(ideaId, chatEvent);

const result = await council.post(chatEvent, {
  trace: true,
});

await appendCouncilRecordsToIdeaLog(ideaId, result.records);

for (const msg of result.publicMessages) {
  publishToUi(msg);
}

for (const entry of result.errors) {
  reportTurnError(entry);
}

const debugStatus = await council.getStatus();
showDiagnostics(debugStatus);
```

## 14. Compatibility expectations

### 14.1 Must remain compatible

The following should remain compatible within the same contract version:

- `CouncilRecord` shape and semantics
- `CouncilReplayEntry` shape and semantics
- public TypeScript API signatures
- semantics of replay and turn execution

### 14.2 May change without compatibility guarantees

The following may change between versions:

- `getStatus()` payload shape
- detailed runtime event payloads beyond their documented meaning
- internal orchestration logic
- internal data structures and tracing details

## 15. Implementation notes for `council-of-experts`

The implementation may encapsulate any internal logic previously discussed, including but not limited to:

- relevance checks
- agent self-selection
- private council rounds
- oracle synthesis
- selective review
- mode transitions
- internal summaries
- tool-mediated augmentation

None of that changes the boundary defined here.

What matters for the contract is:

- councils are in-memory and replayable
- the host owns durability
- the host can inspect private messages and diagnostics
- tools are executed through the host boundary
- replay never regenerates prior turns

## 16. Summary

The contract is intentionally simple:

- the host owns the log
- `council-of-experts` owns the council runtime
- the host replays durable events into the council on boot
- the host posts new chat events into the council during operation
- the council returns replayable records
- the host persists those records
- the host may inspect private council output and unstable diagnostics

That is the intended integration model for `council-of-experts`.
