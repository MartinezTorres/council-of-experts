# API Reference

## CouncilOrchestrator

Main orchestration class that coordinates expert responses.

### Constructor

```typescript
constructor(config: CouncilConfig)
```

**Parameters:**
- `config.documentProvider: DocumentProvider` - Required. Provides document access.
- `config.settingsProvider: SettingsProvider` - Required. Provides configuration.
- `config.loggerProvider?: LoggerProvider` - Optional. Logging interface.
- `config.broadcaster?: EventBroadcaster` - Optional. Real-time event broadcasting.

**Example:**
```typescript
const council = new CouncilOrchestrator({
  documentProvider: new MyDocumentProvider(),
  settingsProvider: new MySettingsProvider()
});
```

---

### orchestrate()

Orchestrates multiple experts to respond to a user message.

```typescript
async orchestrate(
  documentId: string,
  userMessage: string,
  triggerUserId: string,
  experts: Expert[],
  context: {
    documentContent?: string;
    chatHistory?: ChatMessage[];
  },
  options?: {
    isIndirectInvocation?: boolean;
  }
): Promise<void>
```

**Parameters:**
- `documentId` - ID of the document being discussed
- `userMessage` - The user's message/prompt
- `triggerUserId` - ID of the user who triggered this orchestration
- `experts` - Array of experts to invoke
- `context.documentContent` - Optional document content for context
- `context.chatHistory` - Optional chat history for context
- `options.isIndirectInvocation` - Optional flag for indirect triggers

**Returns:** Promise<void> - Responses come via the callback set with `onResponse()`

**Example:**
```typescript
await council.orchestrate(
  "doc-123",
  "Please review this code",
  "user-456",
  [securityExpert, codeReviewer],
  {
    documentContent: "const x = 1;",
    chatHistory: previousMessages
  }
);
```

---

### onResponse()

Register a callback to receive expert responses.

```typescript
onResponse(
  callback: (response: ExpertResponse, documentId: string) => Promise<void>
): void
```

**Parameters:**
- `callback` - Async function called when an expert responds

**Response Object:**
```typescript
interface ExpertResponse {
  expertUserId: string;     // Expert identifier
  message: string;          // Expert's response
  timestamp: string;        // ISO timestamp
  diagnosticId?: string;    // Optional diagnostic ID for debugging
}
```

**Example:**
```typescript
council.onResponse(async (response, documentId) => {
  await saveMessageToDatabase({
    documentId,
    userId: response.expertUserId,
    content: response.message,
    timestamp: response.timestamp
  });
});
```

---

### registerTool()

Register a custom tool that experts can use.

```typescript
registerTool(tool: Tool, executor: ToolExecutor): void
```

**Parameters:**
- `tool` - Tool definition
- `executor` - Async function that executes the tool

**Tool Interface:**
```typescript
interface Tool {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  needsProcessing: boolean;  // Should expert see the result?
}

interface ToolParameter {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
}
```

**Executor Function:**
```typescript
type ToolExecutor = (
  args: Record<string, any>,
  context: ToolExecutionContext
) => Promise<ToolResult>;

interface ToolExecutionContext {
  documentId: string;
  expertUserId: string;
  triggerUserId: string;
}

interface ToolResult {
  tool: string;
  result: string;
  success: boolean;
}
```

**Example:**
```typescript
council.registerTool(
  {
    name: "calculate_complexity",
    description: "Calculate code complexity score",
    parameters: {
      code: {
        type: "string",
        description: "Code to analyze",
        required: true
      }
    },
    needsProcessing: true
  },
  async (args, context) => {
    const score = analyzeComplexity(args.code);
    return {
      tool: "calculate_complexity",
      result: `Complexity score: ${score}`,
      success: true
    };
  }
);
```

---

### summarize()

Generate a summary using AI (with caching).

```typescript
async summarize(text: string): Promise<string>
```

**Parameters:**
- `text` - Text to summarize

**Returns:** Promise<string> - Summary text

**Features:**
- LRU cache (100 entries)
- Uses summarization config from SettingsProvider
- Falls back to first 200 words if no config

**Example:**
```typescript
const summary = await council.summarize(longSystemPrompt);
```

---

### getDiagnostic()

Retrieve diagnostic information for debugging AI requests.

```typescript
getDiagnostic(diagnosticId: string): Diagnostic | undefined
```

**Parameters:**
- `diagnosticId` - ID returned in ExpertResponse

**Returns:** Diagnostic object or undefined

**Diagnostic Interface:**
```typescript
interface Diagnostic {
  id: string;
  timestamp: string;
  modelName: string;
  modelUrl: string;
  request: {
    prompt: string;
    systemPrompt?: string;
    temperature: number;
    maxTokens: number;
  };
  response: {
    content: string;
    finishReason?: string;
  };
  performance: {
    responseTimeMs: number;
    tokensPerSecond?: number;
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  error?: string;
}
```

**Example:**
```typescript
const diagnostic = council.getDiagnostic(diagnosticId);
console.log('Response time:', diagnostic?.performance.responseTimeMs);
```

---

### getModelDiagnostics()

Get all diagnostics for a specific model.

```typescript
getModelDiagnostics(modelName: string): Diagnostic[]
```

**Parameters:**
- `modelName` - Model name to filter by

**Returns:** Array of diagnostics (max 100 per model, LRU)

**Example:**
```typescript
const diagnostics = council.getModelDiagnostics("gpt-4");
const avgTime = diagnostics.reduce((sum, d) =>
  sum + d.performance.responseTimeMs, 0) / diagnostics.length;
```

---

### aiClient

Public AIClient instance for utility operations.

```typescript
council.aiClient: AIClient
```

**Available Methods:**
- `chat(prompt, modelName, temperature?, maxTokens?)` - Direct AI chat
- `summarize(text, config?)` - Generate summary

**Example:**
```typescript
// Direct AI call for utilities
const response = await council.aiClient.chat(
  "Test connection",
  "gpt-4",
  0.7,
  100
);
console.log(response.content);
```

---

## Provider Interfaces

### DocumentProvider

Provides access to documents and suggestions.

```typescript
interface DocumentProvider {
  getDocument(id: string): Promise<Document>;

  createSuggestion(
    documentId: string,
    content: string,
    baseVersion: number,
    userId: string
  ): Promise<SuggestionResult>;

  getAttachment(
    documentId: string,
    attachmentId: string
  ): Promise<Attachment | null>;
}
```

**Document:**
```typescript
interface Document {
  id: string;
  content: string;
  version?: number;
  attachments?: Attachment[];
}
```

**Attachment:**
```typescript
interface Attachment {
  id: string;
  type: string;
  description?: string;
  files: AttachmentFile[];
}

interface AttachmentFile {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  data?: Buffer;
}
```

**SuggestionResult:**
```typescript
interface SuggestionResult {
  id: string;
  created_by: string;
  created_at: string;
  base_version: number;
}
```

---

### SettingsProvider

Provides configuration access.

```typescript
interface SettingsProvider {
  getModel(modelName: string): Promise<AIModel | null>;
  getTimeoutMs(): Promise<number>;
  getSummarizationConfig(): Promise<SummarizationConfig | null>;
  getChatSystemPrompt(): Promise<string | null>;
}
```

**AIModel:**
```typescript
interface AIModel {
  name: string;       // Model identifier
  url: string;        // API endpoint
  model: string;      // Model name for API
  api_key: string;    // API key (empty string for local models)
}
```

**SummarizationConfig:**
```typescript
interface SummarizationConfig {
  model: string;               // Model to use for summaries
  promptTemplate?: string;     // Custom prompt template
}
```

---

### LoggerProvider

Optional logging interface.

```typescript
interface LoggerProvider {
  logOperation(
    operation: string,
    userId: string,
    metadata?: any
  ): Promise<void>;

  logError(
    operation: string,
    error: Error
  ): Promise<void>;
}
```

---

### EventBroadcaster

Optional real-time event broadcasting.

```typescript
interface EventBroadcaster {
  emit(room: string, event: string, data: any): void;
}
```

**Events Emitted:**
- `ai-response` - When expert responds
- `ai-tool-call` - When expert uses a tool
- `ai-error` - When expert encounters an error

---

## Built-in Tools

### get_attachment

Retrieve a specific attachment.

**Parameters:**
- `documentId: string` - Document ID
- `attachmentId: string` - Attachment ID

**Returns:** Attachment data or error message

---

### list_attachments

List all attachments on a document.

**Parameters:**
- `documentId: string` - Document ID

**Returns:** JSON list of attachments

---

### suggest_edit

Create a content suggestion (respects your permission model).

**Parameters:**
- `documentId: string` - Document ID
- `newContent: string` - Suggested content
- `baseVersion: number` - Base version number

**Returns:** Suggestion ID or error

**Note:** Permission enforcement happens in your `DocumentProvider.createSuggestion()` implementation.

---

### analyze_attachment

Request human to analyze an attachment.

**Parameters:**
- `attachmentId: string` - Attachment to analyze

**Returns:** Instructions for human to review

**Note:** This is a meta-tool that doesn't process directly - it returns a message asking the human to review the attachment.

---

## Types Reference

See [types.ts](../packages/core/src/types.ts) for complete type definitions.

### Expert

```typescript
interface Expert {
  name: string;
  icon: string;
  systemPrompt: string;
  model: string;
  temperature: number;
  userId: string;  // e.g., "system-agent:SecurityExpert"
}
```

### ChatMessage

```typescript
interface ChatMessage {
  sender: string;
  content: string;
  timestamp: string;
  type: 'human' | 'ai';
}
```

---

## Error Handling

All async methods may throw errors. Wrap in try-catch:

```typescript
try {
  await council.orchestrate(...);
} catch (error) {
  console.error('Orchestration failed:', error);
}
```

Errors are also logged via LoggerProvider if provided.
