# Simplification Proposal

## Current Problem
- 4 provider interfaces (DocumentProvider, SettingsProvider, LoggerProvider, EventBroadcaster)
- 10+ methods to implement
- Heavy abstraction for what's essentially: "call AI APIs in parallel"

## Proposed Simplified Interface

### Option 1: Function-based (Simplest)
```typescript
const council = new CouncilOrchestrator({
  // Single callback - library tells you what it needs
  onRequest: async (request: Request) => {
    if (request.type === 'get_document') {
      return await repo.getDocument(request.documentId);
    }
    if (request.type === 'get_model') {
      return await settings.getModel(request.modelName);
    }
    if (request.type === 'response') {
      await saveMessage(request.response);
    }
  }
});

// Simple orchestration
await council.orchestrate({
  documentId: 'doc-123',
  message: 'Review this',
  experts: [{ name: 'Pat', model: 'gpt-4', prompt: '...' }],
  context: { content: '...', history: [...] }
});
```

### Option 2: Context-based (No providers at all)
```typescript
// Just pass everything needed each time - no setup
await council.orchestrate({
  documentId: 'doc-123',
  message: 'Review this',
  experts: [
    {
      name: 'Pat',
      systemPrompt: '...',
      modelConfig: {
        url: 'http://localhost:1234/v1',
        model: 'gpt-4',
        apiKey: ''
      }
    }
  ],
  context: {
    documentContent: '...',
    chatHistory: [...]
  },
  callbacks: {
    onResponse: async (response) => { await save(response); },
    onToolCall: async (tool, args) => { return await execute(tool, args); }
  }
});
```

### Option 3: Minimal Providers (Compromise)
```typescript
// Just 2 providers instead of 4
const council = new CouncilOrchestrator({
  // Data access
  data: {
    getDocument: async (id) => {...},
    getModel: async (name) => {...}
  },
  // Events
  events: {
    onResponse: async (response) => {...},
    onError: async (error) => {...}
  }
});
```

## Recommendation

**Option 2 (Context-based)** is cleanest for experimentation because:
- No setup ceremony
- Everything explicit in the call
- Easy to test different configurations
- You can iterate on agent behavior without changing interfaces
- Neural Storm just passes what it has, no adapter code needed

The library becomes a pure function: `orchestrate(config) => responses via callback`

## What This Enables

With a simpler interface, you can focus on:
- Agent selection strategies
- Parallel vs sequential execution patterns
- Agent-to-agent communication
- Tool invocation patterns
- Context management
- Response aggregation

Without being bogged down by provider abstractions.

## Migration Path

1. Create new simplified interface in library
2. Update Neural Storm to use simpler interface (remove adapters)
3. Remove old provider-based code
4. Library shrinks from 1,249 lines to ~400-500 lines
