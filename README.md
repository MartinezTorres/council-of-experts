# council-of-experts

Multi-agent AI orchestration runtime with three operating modes, private deliberation, and event-sourced state management.

## What It Does

- **Three Operating Modes** - `open` (independent responses), `council` (private deliberation → public synthesis), `oracle` (private deliberation → unified voice)
- **Private/Public Channels** - Agents can deliberate privately before emitting public responses
- **Event-Sourced** - Pure replay from persisted records, no file system dependencies
- **Turn-Based API** - Clean separation of durable records vs diagnostic data
- **Host-Owned Persistence** - Core module is 100% in-memory, host owns all storage
- **EngineAdapter Pattern** - Bring your own AI provider implementation

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
import { createCouncilModule } from 'council-of-experts';
import type {
  AgentDefinition,
  EngineAdapter,
  EngineInput,
  EngineOutput,
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
    },
    modelName: 'your-model-name',
    summary: 'Data analysis expert',
    systemPrompt: 'You are an analytical expert...',
    metadata: { icon: '📊' }
  }
];

// 2. Implement EngineAdapter (example: /v1/chat/completions compatible)
class ChatCompletionsEngine implements EngineAdapter {
  async generate(input: EngineInput): Promise<EngineOutput> {
    const response = await fetch(`${input.agent.engine.provider}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.agent.engine.model,
        messages: [
          { role: 'system', content: input.agent.systemPrompt },
          { role: 'user', content: input.event.content }
        ]
      })
    });

    const data = await response.json();
    return { content: data.choices[0].message.content };
  }
}

// 3. Implement ToolHost (optional)
const toolHost: ToolHost = {
  async execute(call, ctx) {
    if (call.name === 'read_document') {
      const doc = await yourDocStore.get(ctx.councilId);
      return { ok: true, content: doc };
    }
    return { ok: false, error: 'Unknown tool' };
  }
};

// 4. Create council module
const councilModule = createCouncilModule({
  agents,
  engines: { 'local': new ChatCompletionsEngine() },
  toolHost
});

// 5. Open council and post events
const council = await councilModule.openCouncil({
  councilId: 'session-123',
  initialMode: 'open'
});

const result = await council.post({
  actor: { type: 'user', id: 'user-1', name: 'Alice' },
  content: 'Analyze this data'
});

// 6. Persist records
await yourStorage.append(result.records);

// 7. Display responses
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

## Inspecting Private Channel

```typescript
// Get all messages (public and private)
const allMessages = await council.getMessages({ visibility: 'all' });

// Get only private deliberation
const privateMessages = await council.getMessages({ visibility: 'private' });

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

**Returns:** `CouncilModule`

### CouncilModule

- `openCouncil(input)` - Create in-memory council instance
- `listAgents()` - Get all agent definitions

### Council

- `getMode()` - Get current mode
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
  publicMessages: CouncilMessage[];
  privateMessages: CouncilMessage[];
  records: CouncilRecord[];  // PERSIST THESE
}
```

## Example Application

See **[packages/cli](./packages/cli)** for a complete working CLI:

```bash
cd packages/cli
npm install
npm run build
npm start config.example.json
```

## Configuration Example

```json
{
  "engines": [{
    "id": "local-llm",
    "provider": "http://localhost:1234",
    "model": "your-model-name",
    "contextWindow": 8192,
    "settings": { "temperature": 0.7 }
  }],
  "agents": [{
    "id": "analyst",
    "name": "Analyst",
    "icon": "📊",
    "engine": "local-llm",
    "summary": "Data analysis expert",
    "systemPrompt": "You are an expert...",
    "tools": ["read_document"]
  }]
}
```

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
│   │   │   ├── types.ts                # Contract types
│   │   │   ├── CouncilImpl.ts          # Council implementation
│   │   │   ├── CouncilModule.ts        # Factory
│   │   │   └── utils.ts
│   │   └── dist/
│   └── cli/                            # Example CLI application
│       ├── src/
│       │   ├── index.ts
│       │   ├── ChatCompletionsEngine.ts # EngineAdapter implementation
│       │   ├── tools.ts                # ToolHost example
│       │   ├── chat.ts
│       │   └── config.ts
│       └── config.example.json
```

## Development

```bash
# Build core library
cd packages/core
npm install
npm run build

# Build CLI
cd packages/cli
npm install
npm run build

# Run CLI
npm start config.example.json
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
