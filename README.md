# council-of-experts

Multi-agent AI orchestration runtime with three operating modes, private deliberation, and event-sourced state management.

## What It Does

- **Three Operating Modes** - `open` (independent responses), `council` (private deliberation → public synthesis), `oracle` (private deliberation → unified voice)
- **Private/Public Channels** - Agents can deliberate privately before emitting public responses
- **Event-Sourced** - Pure replay from persisted records, no file system dependencies
- **Turn-Based API** - Clean separation of durable records vs diagnostic data
- **Host-Owned Persistence** - Core module is 100% in-memory, host owns all storage
- **EngineAdapter Pattern** - Bring your own AI provider implementation

## Workspace Packages

- `packages/core` - the published `council-of-experts` runtime library
- `packages/cli` - interactive demo shell for local councils
- `packages/openai-provider` - OpenAI-compatible provider app backed by oracle-mode councils

## Runnable Apps

- CLI demo: `npm run demo:local-cli`
- OpenAI-compatible provider demo: `npm run demo:openai-provider`

The provider app supports:

- `GET /v1/models`
- `POST /v1/chat/completions`
- OpenAI-style client tool calls on the final outward oracle step
- per-agent local document access via `vault.read(path)`

See [packages/openai-provider/README.md](./packages/openai-provider/README.md) for the app-specific config and behavior.

## Architecture

See **[docs/council-of-experts-contract.md](./docs/council-of-experts-contract.md)** for the complete specification.

### Key Concepts

**Council**: In-memory runtime instance identified by a `councilId`

**Operating Modes**:
- `open` - Agents speak independently in public
- `council` - Agents deliberate privately, then emit public messages
- `oracle` - Agents deliberate privately, oracle synthesizes unified response

**Durability Model**:
- Core module never touches files or databases
- Returns `CouncilRecord[]` to persist after each turn
- Pure replay reconstructs state from records

## Installation

```bash
npm install council-of-experts
```

## Quick Start

```typescript
import {
  createCouncilModule,
  OpenAIChatCompletionsEngine,
} from 'council-of-experts';
import type {
  AgentDefinition,
  ToolHost,
} from 'council-of-experts';

// 1. Define agents
const agents: AgentDefinition[] = [
  {
    id: 'analyst',
    name: 'Analyst',
    engine: {
      id: 'local',
      provider: 'http://localhost:1234',
      model: 'your-model-name',
      charsPerToken: 4
    },
    summary: 'Data analysis expert',
    systemPrompt: 'You are an analytical expert...',
    metadata: { icon: '📊' }
  }
];

// 2. Implement ToolHost (optional)
const toolHost: ToolHost = {
  async execute(call, ctx) {
    if (call.name === 'lookup_context') {
      const doc = await yourContextStore.get(ctx.councilId);
      return { ok: true, content: doc };
    }
    return { ok: false, error: 'Unknown tool' };
  }
};

// 3. Create council module
const councilModule = createCouncilModule({
  agents,
  engines: { 'local': new OpenAIChatCompletionsEngine() },
  toolHost,
  runtime: {
    initialMode: 'open',
    maxRounds: 3
  }
});

// 4. Open council and post events
const council = await councilModule.openCouncil({
  councilId: 'session-123',
  initialMode: 'open'
});

const result = await council.post({
  actor: { type: 'user', id: 'user-1', name: 'Alice' },
  content: 'Analyze this data'
});

// 5. Persist records
await yourStorage.append(result.records);

// 6. Display responses
for (const msg of result.publicMessages) {
  console.log(`${msg.author.name}: ${msg.content}`);
}
```

## Operating Modes

### Open Mode
```typescript
const result = await council.post(event, { mode: 'open' });
// All agents respond independently in public
```

### Council Mode
```typescript
const result = await council.post(event, { mode: 'council' });
// Phase 1: Private deliberation
// Phase 2: Public synthesis based on private thoughts
console.log(result.privateMessages); // Hidden deliberation
console.log(result.publicMessages);  // Public synthesis
```

### Oracle Mode
```typescript
const result = await council.post(event, { mode: 'oracle' });
// Phase 1: Private agent deliberation
// Phase 2: Unified oracle response
// result.publicMessages contains single oracle message

const privateOnly = await council.post(event, {
  mode: 'oracle',
  emitPublicOracle: false,
});
// privateOnly.privateMessages contains deliberation
// privateOnly.publicMessages is empty
```

## Replay and Durability

```typescript
// On application boot
const council = await councilModule.openCouncil({ councilId: 'idea-456' });

// Replay persisted history
const entries = await yourStorage.load('idea-456');
await council.replay(entries); // Pure state reconstruction, no LLM calls

// Process new event
const result = await council.post(userEvent);

// Persist returned records
await yourStorage.append('idea-456', result.records);
```

## Streaming API

```typescript
for await (const event of council.stream(chatEvent)) {
  switch (event.type) {
    case 'turn.started':
      console.log('Turn started');
      break;
    case 'agent.started':
      console.log(`Agent ${event.agentId} thinking...`);
      break;
    case 'message.emitted':
      console.log(`${event.message.author.name}: ${event.message.content}`);
      break;
  }
}
```

## Tool Calling

Engine adapters can request tools by returning `EngineOutput.toolCalls`. The council executes those calls through `ToolHost`, emits `tool.called` / `tool.result` records (and stream events), then calls the engine again with `EngineInput.toolCalls` + `EngineInput.toolResults` for the current turn.

For OpenAI-compatible `/v1/chat/completions` servers, the core package also exports `OpenAIChatCompletionsEngine`.

When `engine.charsPerToken` is configured, `OpenAIChatCompletionsEngine` also attaches approximate prompt/completion token estimates to `EngineOutput.metadata.tokenEstimate`. This is instrumentation only; it does not clip or summarize history.

Tools are only executed if the tool name appears in `agent.tools`. You can provide richer tool definitions (name/description/parameters) as `ToolDefinition` entries in `agent.tools`, which are passed to the engine as `EngineInput.tools`.

`TurnOptions.maxRounds` limits tool-call round trips per agent. The module-level default comes from `createCouncilModule({ runtime: { maxRounds } })`, and defaults to `3`.

Non-stream execution failures are surfaced through `TurnResult.errors` and durable `error` records.

## Inspecting Private Channel

```typescript
// Get all messages (public and private)
const allMessages = await council.getMessages({ visibility: 'all' });

// Get only private deliberation
const privateMessages = await council.getMessages({ visibility: 'private' });

// Returned arrays/messages are detached snapshots.

// Get resolved runtime config
const config = council.getConfig();

// Get diagnostic snapshot (unstable across versions)
const status = await council.getStatus();
console.log(status);
```

## API Reference

### createCouncilModule(config)

Creates a council module.

**Config:**
- `agents: AgentDefinition[]` - Agent definitions
- `engines: Record<string, EngineAdapter>` - Engine implementations
- `toolHost?: ToolHost` - Optional tool executor
- `runtime?: Partial<CouncilRuntimeConfig>` - Optional runtime defaults for `initialMode`, `maxRounds`, and `maxAgentReplies`

**Returns:** `CouncilModule`

### CouncilModule

- `openCouncil(input)` - Create in-memory council instance
- `listAgents()` - Get all agent definitions
- `getConfig()` - Get resolved module runtime config

### Council

- `getMode()` - Get current mode
- `getConfig()` - Get resolved council instance config
- `replay(entries)` - Replay persisted records (pure state reconstruction)
- `post(event, options?)` - Process turn, returns `TurnResult`
- `stream(event, options?)` - Stream turn execution events
- `getMessages(options?)` - Get message history
- `getStatus()` - Get diagnostic snapshot (unstable)
- `dispose()` - Release in-memory resources

### TurnResult

```typescript
interface TurnResult {
  turnId: string;
  mode: CouncilMode;
  nextMode?: CouncilMode;
  publicMessages: CouncilMessage[];
  privateMessages: CouncilMessage[];
  records: CouncilRecord[];  // PERSIST THESE
  errors: TurnError[];
}
```

## Example Application

The runnable example is the CLI in [packages/cli/README.md](./packages/cli/README.md).

For the validated local-provider setup:

```bash
npm install
npm run demo:local-cli
```

For CLI-specific configuration examples, see:

- [packages/cli/config.example.json](./packages/cli/config.example.json)
- [packages/cli/config.local-provider.example.json](./packages/cli/config.local-provider.example.json)

The core library itself does not require a JSON config file format.

## Contract Stability

**Stable (replayable across versions):**
- TypeScript API
- `CouncilRecord` types
- `CouncilReplayEntry` types
- Replay semantics

**Unstable (may change):**
- `getStatus()` payload shape
- Internal orchestration logic
- Runtime event details beyond documented meaning

## Project Structure

```
council-of-experts/
├── docs/
│   └── council-of-experts-contract.md  # Complete specification
├── packages/
│   ├── core/                           # Main library
│   │   ├── src/
│   │   │   ├── config.ts               # Runtime default resolution
│   │   │   ├── types.ts                # Contract types
│   │   │   ├── OpenAIChatCompletionsEngine.ts
│   │   │   ├── CouncilImpl.ts          # Council implementation
│   │   │   ├── CouncilModule.ts        # Factory
│   │   │   ├── utils.ts
│   │   │   └── workflows/              # Mode executors
│   │   └── dist/
│   ├── cli/                            # Example CLI application
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── tools.ts                # Built-in CLI tool host
│   │   │   ├── session.ts
│   │   │   ├── chat.ts
│   │   │   └── config.ts
│   │   ├── config.example.json
│   │   └── config.local-provider.example.json
│   └── openai-provider/                # OpenAI-compatible provider app
```

## Development

```bash
# Install workspace dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Run the local-provider CLI example
npm run demo:local-cli
```

## Use Cases

- **Multi-agent deliberation** - Experts privately discuss before public response
- **Oracle synthesis** - Multiple perspectives unified into single voice
- **Event-sourced AI** - Full audit trail of agent activity
- **Host-controlled persistence** - Integrate with your storage/event system
- **Mode switching** - Adapt orchestration strategy per turn

## License

MIT

## Contributing

See [docs/council-of-experts-contract.md](./docs/council-of-experts-contract.md) for the complete contract specification.
