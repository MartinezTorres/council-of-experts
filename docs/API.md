# API Reference

**For the complete API specification, see [council-of-experts-contract.md](./council-of-experts-contract.md).**

This document provides a quick reference for the most commonly used APIs.

## Quick Reference

### createCouncilModule(config)

Factory function to create a council module.

```typescript
import { createCouncilModule } from 'council-of-experts';

const councilModule = createCouncilModule({
  agents: agentDefinitions,
  engines: engineImplementations,
  toolHost: optionalToolHost
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
  modelName: string;
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

// Engine specification
interface EngineSpec {
  id: string;
  provider?: string;
  model: string;
  contextWindow: number;
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
- `TurnOptions.maxRounds` limits tool-call round trips per agent (default 3).
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
```

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

## Complete Type Definitions

See [../packages/core/src/types.ts](../packages/core/src/types.ts) for complete TypeScript definitions.

## Complete Specification

See [council-of-experts-contract.md](./council-of-experts-contract.md) for the complete contract specification, including:
- Durability model
- Replay semantics
- Stability guarantees
- Integration patterns
- Full type reference
