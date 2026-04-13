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

See **[docs/CONTRACT.md](./docs/CONTRACT.md)** for the complete specification.

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
      contextWindow: 8192,
      charsPerToken: 4,
    },
    summary: 'Data analysis expert',
    systemPrompt: 'You are an analytical expert...',
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
  engines: { 'local': new OpenAIChatCompletionsEngine(60000) },
  toolHost,
  runtime: {
    initialMode: 'open',
    maxRounds: 3,
  },
  prompts: {
    oracleSynthesisTemplate:
      'You are the Oracle.\n\nPrivate deliberation:\n{{privateThoughts}}\n\nRespond with one unified answer.',
  },
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

## OpenAI Adapter

For OpenAI-compatible `/v1/chat/completions` servers, the core package exports `OpenAIChatCompletionsEngine(timeoutMs)`.

The built-in adapter requires `engine.contextWindow` and `engine.charsPerToken`. It can also take `engine.promptBudgetRatio` and `engine.promptSummaryPolicy` to make prompt-packing policy explicit.

If you need to drive that adapter from external chat history instead of council history, `ChatEvent.promptMessages` can carry structured prior chat messages.

If uncontrolled fixed inputs such as system prompts, tool schemas, or raw tool continuations exceed the configured prompt budget, the engine call is skipped and the turn records `agent_context_exhausted`.

The built-in workflow prompts are also explicit. `createCouncilModule({ prompts })` can override the default council/oracle synthesis templates and the built-in `council` / `oracle` mode system addenda.

## More Docs

- [docs/API.md](./docs/API.md) for the practical TypeScript API and integration examples
- [docs/CONTRACT.md](./docs/CONTRACT.md) for the normative contract, replay semantics, and stability guarantees
- [packages/cli/README.md](./packages/cli/README.md) for the demo CLI
- [packages/openai-provider/README.md](./packages/openai-provider/README.md) for the OpenAI-compatible provider app

The runnable example is the CLI in [packages/cli/README.md](./packages/cli/README.md). For the validated local-provider setup:

```bash
npm install
npm run demo:local-cli
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

## License

MIT
