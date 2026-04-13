# API Reference

**For the complete API specification, see [CONTRACT.md](./CONTRACT.md).**

This document provides a quick reference for the most commonly used APIs.

## Quick Reference

### createCouncilModule(config)

Factory function to create a council module.

```typescript
import { createCouncilModule } from 'council-of-experts';

const councilModule = createCouncilModule({
  agents: agentDefinitions,
  engines: engineImplementations,
  toolHost: optionalToolHost,
  runtime: {
    initialMode: 'open',
    maxRounds: 3,
    agentSelectionStrategy: 'all_in_order',
    oracleSpeakerStrategy: 'first_active'
  },
  prompts: {
    oracleSynthesisTemplate:
      'You are the Oracle.\\n\\nPrivate deliberation:\\n{{privateThoughts}}\\n\\nRespond with one unified answer.'
  }
});
```

### Council Interface

```typescript
// Open a council
const council = await councilModule.openCouncil({
  councilId: 'unique-id',
  initialMode: 'open' // or 'council' or 'oracle'
});

// Get current mode
const mode = council.getMode(); // 'open' | 'council' | 'oracle'

// Get resolved config
const config = council.getConfig();

// Replay persisted records (pure state reconstruction)
await council.replay(replayEntries);

// Post a new event (turn execution)
const result = await council.post(chatEvent, options);

// Stream turn execution (real-time)
for await (const event of council.stream(chatEvent, options)) {
  // Handle events
}

// Get messages
const messages = await council.getMessages({
  visibility: 'all' // or 'public' or 'private'
});
// Returned arrays/messages are detached snapshots.

// Get diagnostic snapshot (unstable)
const status = await council.getStatus();

// Dispose council
await council.dispose();
```

### TurnResult

```typescript
interface TurnResult {
  turnId: string;
  mode: CouncilMode;
  nextMode?: CouncilMode;
  publicMessages: CouncilMessage[];
  privateMessages: CouncilMessage[];
  records: CouncilRecord[];  // MUST be persisted by host
  errors: TurnError[];
}
```

### Core Types

```typescript
// Agent definition
interface AgentDefinition {
  id: string;
  name: string;
  engine: EngineSpec;
  summary: string;
  systemPrompt: string;
  tools?: ToolRef[];
  metadata?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

type ToolRef = string | ToolDefinition;

interface CouncilPromptConfig {
  councilModeSystemAddendum?: string;
  oracleModeSystemAddendum?: string;
  councilSynthesisTemplate?: string;
  oracleSynthesisTemplate?: string;
}

interface ResolvedCouncilPromptConfig {
  councilModeSystemAddendum: string;
  oracleModeSystemAddendum: string;
  councilSynthesisTemplate: string;
  oracleSynthesisTemplate: string;
}

// Engine specification
interface EngineSpec {
  id: string;
  provider?: string;
  model: string;
  contextWindow?: number;
  charsPerToken?: number;
  promptBudgetRatio?: number;
  promptSummaryPolicy?: {
    maxMessagesPerGroup?: number;
    minGroupSnippetChars?: number;
    minMessageSnippetChars?: number;
    shrinkTargetRatio?: number;
  };
  settings?: Record<string, unknown>;
}

// Chat event (input)
interface ChatEvent {
  id?: string;
  actor: {
    type: 'user' | 'agent' | 'system';
    id: string;
    name?: string;
  };
  content: string;
  promptMessages?: Array<{
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
  }>;
  timestamp?: string | number | Date;
  metadata?: Record<string, unknown>;
}

// Council message (output)
interface CouncilMessage {
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
```

### EngineAdapter (Host Implementation)

```typescript
interface EngineAdapter {
  generate(input: EngineInput): Promise<EngineOutput>;
  stream?(input: EngineInput): AsyncIterable<EngineOutput>;
}

interface EngineInput {
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

interface EngineOutput {
  content: string;
  metadata?: Record<string, unknown>;
  toolCalls?: ToolCall[];
}
```

For OpenAI-compatible `/v1/chat/completions` servers, you can use the built-in `OpenAIChatCompletionsEngine(timeoutMs)` exported by `council-of-experts`.

### ToolHost (Host Implementation)

```typescript
interface ToolHost {
  execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult>;
}

interface ToolCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

interface ToolExecutionContext {
  councilId: string;
  turnId: string;
  agentId: string;
}

interface ToolResult {
  ok: boolean;
  callId?: string;
  content?: string;
  data?: unknown;
  error?: string;
}

interface CouncilError {
  message: string;
  code?: string;
  data?: unknown;
}

interface TurnError {
  agentId?: string;
  error: CouncilError;
}
```

### Tool Calling Flow

- The engine adapter can request tools by returning `EngineOutput.toolCalls`.
- The council executes them via `ToolHost` and emits `tool.called` / `tool.result` records and runtime events.
- The engine is called again with `EngineInput.toolCalls` + `EngineInput.toolResults` for the current turn.
- Tool calls are executed only if the tool name is present in `agent.tools`.
- For the built-in OpenAI adapter, `engine.promptBudgetRatio` and `engine.promptSummaryPolicy` make prompt-packing policy explicit; the exported `DEFAULT_PROMPT_BUDGET_RATIO` and `DEFAULT_PROMPT_SUMMARY_POLICY` hold the defaults.
- `createCouncilModule({ prompts })` makes the built-in council/oracle workflow prompts explicit; the module resolves those templates once and passes them to the runtime and built-in adapter as `EngineInput.promptConfig`.
- `ChatEvent.promptMessages` is optional structured prior chat history for the built-in OpenAI adapter; it uses the same packer and summary policy instead of flattening that history into a single transcript string.
- `TurnOptions.maxRounds` limits tool-call round trips per agent. The module-level default comes from `createCouncilModule({ runtime: { maxRounds } })`, and defaults to `3`.
- Non-stream execution failures are surfaced in `TurnResult.errors` and durable `error` records.

## Operating Modes

### open
Agents speak independently in public. No private channel.

```typescript
const result = await council.post(event, { mode: 'open' });
// result.publicMessages - all agent responses
// result.privateMessages - empty
```

### council
Two phases: private deliberation, then public synthesis.

```typescript
const result = await council.post(event, { mode: 'council' });
// result.privateMessages - hidden agent deliberation
// result.publicMessages - synthesized public responses
```

### oracle
Two phases: private deliberation, then unified oracle response.

```typescript
const result = await council.post(event, { mode: 'oracle' });
// result.privateMessages - hidden agent deliberation
// result.publicMessages - single oracle message

const privateOnly = await council.post(event, {
  mode: 'oracle',
  emitPublicOracle: false,
});
// privateOnly.privateMessages - hidden agent deliberation
// privateOnly.publicMessages - empty
```

`runtime.oracleSpeakerStrategy` makes the public oracle speaker selection explicit. Use `'first_active'` to synthesize with the first active agent, or `'by_id'` plus `runtime.oracleSpeakerAgentId` to pin synthesis to a specific agent. `TurnOptions.oracleSpeakerAgentId` can override that choice per turn.

## Replay Model

Replay is **pure state reconstruction** - no LLM calls, no tool execution.

```typescript
// Bootstrap: replay persisted history
await council.replay([
  { type: 'host.chat', event: chatEvent },
  { type: 'council.record', record: messageRecord },
  { type: 'council.record', record: toolRecord },
  // ...
]);

// State is now reconstructed in memory
const messages = await council.getMessages();
```

Replay order matters: the reconstructed message order follows the original
`message.emitted` record order.

## Durability Pattern

```typescript
// 1. Persist incoming event (host responsibility)
await yourStore.append({ type: 'host.chat', event: chatEvent });

// 2. Process turn
const result = await council.post(chatEvent);

// 3. Persist returned records (host responsibility)
for (const record of result.records) {
  await yourStore.append({ type: 'council.record', record });
}

// 4. If persistence fails, discard council and replay from durable log
```

Hosts should also inspect `result.errors` if they need to surface non-stream
turn failures without parsing the durable records.

## Runtime Events (Streaming)

```typescript
for await (const event of council.stream(chatEvent)) {
  switch (event.type) {
    case 'turn.started':
    case 'turn.completed':
    case 'agent.started':
    case 'agent.finished':
    case 'message.emitted':
    case 'tool.called':
    case 'tool.result':
    case 'mode.changed':
    case 'error':
      // Handle event
  }
}
```

## Utilities

```typescript
import { generateId, normalizeTimestamp } from 'council-of-experts';

const id = generateId(); // Unique ID
const ts = normalizeTimestamp(Date.now()); // ISO string
```

## Further Reading

- [../packages/core/src/types.ts](../packages/core/src/types.ts) for the complete TypeScript definitions
- [CONTRACT.md](./CONTRACT.md) for the normative contract, replay semantics, and stability guarantees
