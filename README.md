# council-of-experts

Multi-agent AI orchestration library with tool calling, parallel execution, and provider-based architecture.

## What It Does

- **Orchestrate multiple AI agents** in parallel responding to user messages
- **Tool system** - Agents can call functions to read documents, analyze attachments, suggest edits
- **Provider-based** - Bring your own storage, settings, and logging via clean interfaces
- **OpenAI-compatible** - Works with any OpenAI-compatible API (local LLMs, cloud providers)

## Installation

```bash
npm install council-of-experts
```

## Quick Start

```typescript
import { CouncilOrchestrator } from 'council-of-experts';

// 1. Implement providers (or use examples from packages/cli)
const council = new CouncilOrchestrator({
  documentProvider: new MyDocumentProvider(),
  settingsProvider: new MySettingsProvider(),
  loggerProvider: new MyLogger(),
  broadcaster: new MyBroadcaster() // optional
});

// 2. Define experts
const experts = [
  {
    userId: 'agent-1',
    name: 'Analyst',
    icon: '📊',
    systemPrompt: 'You analyze data and provide insights.',
    model: 'gpt-4',
    temperature: 0.7
  },
  {
    userId: 'agent-2',
    name: 'Writer',
    icon: '✍️',
    systemPrompt: 'You write and edit content clearly.',
    model: 'gpt-4',
    temperature: 0.8
  }
];

// 3. Register custom tools (optional)
council.registerTool(
  {
    name: 'search_web',
    description: 'Search the web for information',
    parameters: {
      query: { type: 'string', description: 'Search query', required: true }
    },
    needsProcessing: true // Agent sees result
  },
  async (args, context) => {
    const results = await mySearchAPI(args.query);
    return {
      tool: 'search_web',
      result: results,
      success: true
    };
  }
);

// 4. Orchestrate agents
await council.orchestrate(
  'document-123',           // Document ID
  '@Analyst what trends do you see?',  // User message
  'user-456',              // User ID
  experts,                 // Experts to invoke
  {
    documentContent: 'Q2 2024 Revenue: $5.2M (+15% YoY)...',
    chatHistory: 'Previous messages...'
  }
);

// 5. Handle responses
council.onResponse(async (response, documentId) => {
  console.log(`${response.expertUserId}: ${response.message}`);
  // Save to database, broadcast via WebSocket, etc.
});
```

## Architecture

### Provider Interfaces

Implement these to connect council-of-experts to your application:

```typescript
interface DocumentProvider {
  getDocument(id: string): Promise<Document>;
  createSuggestion(documentId, content, baseVersion, userId): Promise<SuggestionResult>;
  getAttachment(documentId, attachmentId): Promise<Attachment | null>;
}

interface SettingsProvider {
  getModel(modelName: string): Promise<AIModel | null>;
  getSetting<T>(key: string, defaultValue?: T): Promise<T>;
}

interface LoggerProvider {
  logOperation(operation: string, userId: string, metadata?: any): Promise<void>;
  logError(operation: string, error: Error): Promise<void>;
}

interface EventBroadcaster {
  emit(room: string, event: string, data: any): void;
}
```

### Built-in Tools

Agents automatically have access to:

- `get_attachment` - Read attachment content
- `list_attachments` - List available attachments
- `suggest_edit` - Suggest document edits
- `analyze_attachment` - AI-powered attachment analysis

### Custom Tools

Register your own tools:

```typescript
council.registerTool(tool, executor);
```

Tools can either:
- **Need processing** (`needsProcessing: true`) - Agent sees the result and responds
- **Fire and forget** (`needsProcessing: false`) - Result stored, no follow-up

## Utilities

### Mention Parsing

```typescript
import { parseMentions, filterExpertsByMention } from 'council-of-experts';

const mentions = parseMentions('@Analyst and @Writer, help me');
// Returns: Set { 'analyst', 'writer' }

const invoked = filterExpertsByMention(allExperts, mentions);
```

### Recent Activity Detection

```typescript
import { filterExpertsByRecentActivity } from 'council-of-experts';

const activeExperts = filterExpertsByRecentActivity(
  allExperts,
  recentMessages,
  10 // lookback count
);
```

### Model Discovery & Testing

```typescript
// Discover models from provider
const models = await council.aiClient.discoverModels(
  'http://localhost:1234/v1',
  'api-key'
);

// Test connection
const result = await council.aiClient.testConnection('model-name');

// Test tool support
const toolSupport = await council.aiClient.testToolSupport('model-name');
```

## Example Application

See **[packages/cli](./packages/cli)** for a complete working example:

- In-memory providers
- Interactive chat interface
- Basic tools (read/write document, introspection)
- Configuration via JSON

```bash
cd packages/cli
npm install
npm run dev
```

## Configuration

### Standard Settings Keys

The library uses these standard keys via `SettingsProvider.getSetting()`:

- `ai_timeout_ms` - API timeout (default: 60000)
- `summarization_model` - Model for summarization
- `summarization_prompt_template` - Custom prompt template
- `chat_system_prompt` - Global system prompt

Your provider can support additional keys as needed.

### AI Models

Models must be OpenAI-compatible. Configure via `SettingsProvider.getModel()`:

```typescript
{
  name: 'local-llm',
  url: 'http://localhost:1234/v1',
  api_key: '',
  model: 'model-id'
}
```

## How It Works

1. **User sends message** mentioning agents
2. **Orchestrator** invokes mentioned agents in parallel
3. **Each agent** gets system prompt + context + tools
4. **Agents respond** via AI API, optionally calling tools
5. **Tool results** fed back to agent for final response
6. **Responses** sent via callback to your application

### Direct vs Indirect Invocation

- **Direct** - Agent is `@mentioned` explicitly → must respond
- **Indirect** - Agent recently active but not mentioned → can respond or "SKIP"

## Diagnostics

Track AI API performance:

```typescript
// Get diagnostic by ID (from response)
const diagnostic = council.getDiagnostic(diagnosticId);

// Get all diagnostics for a model
const diagnostics = council.getModelDiagnostics('gpt-4');
```

Diagnostics include:
- Request/response content
- Token usage
- Response time
- Tokens per second
- Error messages

## API Reference

### CouncilOrchestrator

```typescript
class CouncilOrchestrator {
  constructor(config: CouncilConfig)

  // Orchestrate agents
  orchestrate(
    documentId: string,
    userMessage: string,
    triggerUserId: string,
    experts: Expert[],
    context: { documentContent?, chatHistory? },
    options?: { isIndirectInvocation? }
  ): Promise<void>

  // Register tools
  registerTool(tool: Tool, executor: ToolExecutor): void

  // Set response callback
  onResponse(callback: (response, documentId) => Promise<void>): void

  // Diagnostics
  getDiagnostic(id: string): Diagnostic | undefined
  getModelDiagnostics(modelName: string): Diagnostic[]

  // Summarization
  summarize(text: string): Promise<string>

  // Direct access
  aiClient: AIClient
}
```

### AIClient

```typescript
class AIClient {
  // Chat with model
  chat(
    prompt: string,
    modelName: string,
    temperature: number,
    maxTokens?: number,
    systemPrompt?: string,
    tools?: OpenAIFunction[]
  ): Promise<AIResponse>

  // Model operations
  discoverModels(url, apiKey?, timeoutMs?): Promise<ModelInfo[]>
  testConnection(modelName): Promise<TestResult>
  testToolSupport(modelName): Promise<ToolSupportResult>

  // Summarization
  summarize(text: string): Promise<string>
}
```

## Project Structure

```
council-of-experts/
├── packages/
│   ├── core/              # Main library
│   │   ├── src/
│   │   │   ├── CouncilOrchestrator.ts
│   │   │   ├── AIClient.ts
│   │   │   ├── ToolSystem.ts
│   │   │   ├── types.ts
│   │   │   └── utils.ts
│   │   └── dist/
│   │
│   └── cli/               # Example application
│       ├── src/
│       │   ├── index.ts
│       │   ├── providers.ts  # Example provider implementations
│       │   ├── tools.ts      # Example custom tools
│       │   └── chat.ts       # Interactive chat loop
│       └── config.example.json
```

## Development

```bash
# Build core library
cd packages/core
npm install
npm run build

# Build CLI example
cd packages/cli
npm install
npm run build

# Run CLI
npm run dev
```

## Use Cases

- **Multi-agent code review** - Security, performance, and style experts
- **Document collaboration** - Writers, editors, and reviewers
- **Data analysis** - Analysts, statisticians, and visualizers
- **Content creation** - Researchers, writers, and fact-checkers
- **Technical support** - Diagnostics, troubleshooting, and documentation experts

## License

MIT

## Contributing

Issues and PRs welcome. The library aims to be:
- **Generic** - No domain-specific logic
- **Flexible** - Provider-based architecture
- **Well-tested** - Core functionality covered
- **Well-documented** - Clear examples and API docs
