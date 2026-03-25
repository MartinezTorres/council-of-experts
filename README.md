# Council of Experts

A role-agnostic, permission-agnostic AI agent orchestration library for multi-agent collaboration systems.

## Overview

Council of Experts enables you to orchestrate multiple AI agents (experts) working together on tasks. The library is designed to be completely independent of your application's permission system, business logic, and data storage - you provide the data access layer, we handle the AI orchestration.

### Key Features

- **Role-Agnostic**: No built-in permission logic - enforce roles at your application layer
- **Provider Pattern**: Dependency injection via simple interfaces
- **OpenAI-Compatible**: Works with OpenAI, Anthropic, local models, and any OpenAI-compatible API
- **Built-in Tools**: Attachment analysis, document editing, suggestion creation
- **Custom Tools**: Register your own tools for domain-specific functionality
- **Parallel Execution**: Multiple experts run concurrently
- **Diagnostic Tracking**: LRU cache for debugging AI requests/responses
- **Real-time Events**: Optional WebSocket broadcasting for live updates

## Installation

```bash
npm install council-of-experts
```

Or use as a local dependency:

```json
{
  "dependencies": {
    "council-of-experts": "file:path/to/council-of-experts/packages/core"
  }
}
```

## Quick Start

### 1. Implement Provider Interfaces

The library requires you to implement 4 provider interfaces that connect it to your application:

```typescript
import {
  DocumentProvider,
  SettingsProvider,
  LoggerProvider,
  EventBroadcaster
} from 'council-of-experts';

// Provide document access
class MyDocumentProvider implements DocumentProvider {
  async getDocument(id: string) {
    // Return document from your storage
    return { id, content: "...", version: 1 };
  }

  async createSuggestion(documentId: string, content: string, baseVersion: number, userId: string) {
    // Create a change suggestion in your system
    return { id: "sugg-123", created_by: userId, created_at: new Date().toISOString(), base_version: baseVersion };
  }

  async getAttachment(documentId: string, attachmentId: string) {
    // Return attachment from your storage
    return null; // or attachment data
  }
}

// Provide configuration access
class MySettingsProvider implements SettingsProvider {
  async getModel(modelName: string) {
    // Return AI model configuration
    return {
      name: modelName,
      url: "http://localhost:1234/v1",
      model: "gpt-4",
      api_key: ""
    };
  }

  async getTimeoutMs() { return 120000; }
  async getSummarizationConfig() { return null; }
  async getChatSystemPrompt() { return null; }
}

// Optional: Provide logging
class MyLoggerProvider implements LoggerProvider {
  async logOperation(operation: string, userId: string, metadata?: any) {
    console.log(`[${operation}] ${userId}`, metadata);
  }

  async logError(operation: string, error: Error) {
    console.error(`[${operation}]`, error);
  }
}

// Optional: Real-time event broadcasting (Socket.IO example)
class MyEventBroadcaster implements EventBroadcaster {
  constructor(private io: any) {}

  emit(room: string, event: string, data: any) {
    this.io.to(room).emit(event, data);
  }
}
```

### 2. Initialize Council Orchestrator

```typescript
import { CouncilOrchestrator } from 'council-of-experts';

const council = new CouncilOrchestrator({
  documentProvider: new MyDocumentProvider(),
  settingsProvider: new MySettingsProvider(),
  loggerProvider: new MyLoggerProvider(),
  broadcaster: new MyEventBroadcaster(io)
});
```

### 3. Define Experts

```typescript
const experts = [
  {
    userId: "system-agent:SecurityExpert",
    name: "SecurityExpert",
    icon: "🔒",
    systemPrompt: "You are a security expert. Review code for vulnerabilities...",
    model: "gpt-4",
    temperature: 0.3
  },
  {
    userId: "system-agent:CodeReviewer",
    name: "CodeReviewer",
    icon: "👨‍💻",
    systemPrompt: "You are a code reviewer. Focus on code quality...",
    model: "gpt-4",
    temperature: 0.5
  }
];
```

### 4. Orchestrate Collaboration

```typescript
// Set up response callback
council.onResponse(async (response, documentId) => {
  console.log(`Expert ${response.expertUserId} responded:`, response.message);
  // Save the response to your database/storage
});

// Trigger orchestration
await council.orchestrate(
  "doc-123",                    // documentId
  "Please review this code",    // userMessage
  "user-456",                   // triggerUserId
  experts,                      // experts to invoke
  {
    documentContent: "const x = 1;",
    chatHistory: []
  },
  { isIndirectInvocation: false }
);
```

## Architecture

### Provider Pattern

Council uses the **Provider Pattern** (dependency injection) to remain completely decoupled from your application:

```
┌─────────────────────────────────────┐
│   Your Application                  │
│   ┌─────────────────────────────┐   │
│   │  Adapters (Your Code)       │   │
│   │  - MyDocumentProvider       │   │
│   │  - MySettingsProvider       │   │
│   │  - MyLoggerProvider         │   │
│   │  - MyEventBroadcaster       │   │
│   └─────────────────────────────┘   │
│              ▲                       │
│              │                       │
│   ┌──────────┴──────────────────┐   │
│   │  CouncilOrchestrator        │   │
│   │  (council-of-experts)       │   │
│   │  - AIClient                 │   │
│   │  - ToolSystem               │   │
│   │  - Parallel execution       │   │
│   └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Built-in Tools

Council provides 4 built-in tools that experts can use:

1. **get_attachment**: Retrieve a specific attachment
2. **list_attachments**: List all attachments on a document
3. **suggest_edit**: Create a content suggestion (respects your application's permission model)
4. **analyze_attachment**: Request human to analyze an attachment

### Custom Tools

Register custom tools for domain-specific functionality:

```typescript
council.registerTool(
  {
    name: "search_database",
    description: "Search the company database",
    parameters: {
      query: { type: "string", description: "Search query", required: true }
    },
    needsProcessing: true  // Expert should see the results
  },
  async (args, context) => {
    const results = await searchDB(args.query);
    return {
      tool: "search_database",
      result: JSON.stringify(results),
      success: true
    };
  }
);
```

## API Reference

See [API.md](docs/API.md) for detailed API documentation.

## Design Principles

### 1. Role-Agnostic

The library has **no concept of roles or permissions**. It doesn't know about "authors", "reviewers", or any permission model. Your application enforces permissions by:

- Controlling which experts are passed to `orchestrate()`
- Implementing permission checks in your providers
- Filtering responses based on user roles

### 2. Permission-Agnostic

Council never makes permission decisions. When an expert calls `suggest_edit`, your `DocumentProvider.createSuggestion()` implementation decides whether to allow it.

### 3. Storage-Agnostic

Council has no database, no file system access, no event logs. It only operates on data you provide through the provider interfaces.

### 4. Framework-Agnostic

Works with any Node.js framework (Express, Fastify, Koa, Next.js, etc.)

## Examples

See the [examples/](examples/) directory for:

- Express integration example
- Custom tool registration
- Multi-document orchestration
- Diagnostic monitoring

## Development

```bash
# Build the library
cd packages/core
npm install
npm run build

# Run tests
npm test

# Type checking
npx tsc --noEmit
```

## License

MIT

## Contributing

Contributions welcome! This is an independent library with no dependencies on specific applications.

When contributing:
- Maintain role-agnostic design
- Keep provider interfaces minimal
- Add tests for new features
- Update documentation
