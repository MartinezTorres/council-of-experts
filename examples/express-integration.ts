/**
 * Example: Integrating council-of-experts with Express
 *
 * This example shows how to:
 * - Implement provider interfaces
 * - Set up CouncilOrchestrator
 * - Handle expert responses
 * - Register custom tools
 */

import express from 'express';
import { CouncilOrchestrator, DocumentProvider, SettingsProvider, LoggerProvider, EventBroadcaster, Document, AIModel, SuggestionResult, Attachment } from 'council-of-experts';

// ============================================================================
// 1. Implement Provider Interfaces
// ============================================================================

/**
 * Document Provider - connects council to your data storage
 */
class SimpleDocumentProvider implements DocumentProvider {
  private documents = new Map<string, { content: string; version: number; attachments: Attachment[] }>();
  private suggestions = new Map<string, any>();

  async getDocument(id: string): Promise<Document> {
    const doc = this.documents.get(id) || {
      content: "# Sample Document\n\nThis is a sample document.",
      version: 1,
      attachments: []
    };

    return {
      id,
      content: doc.content,
      version: doc.version,
      attachments: doc.attachments
    };
  }

  async createSuggestion(
    documentId: string,
    content: string,
    baseVersion: number,
    userId: string
  ): Promise<SuggestionResult> {
    const suggestionId = `sugg-${Date.now()}`;

    const suggestion = {
      id: suggestionId,
      created_by: userId,
      created_at: new Date().toISOString(),
      base_version: baseVersion,
      content
    };

    this.suggestions.set(suggestionId, suggestion);

    console.log(`[DocumentProvider] Created suggestion ${suggestionId} by ${userId}`);

    return {
      id: suggestionId,
      created_by: userId,
      created_at: suggestion.created_at,
      base_version: baseVersion
    };
  }

  async getAttachment(documentId: string, attachmentId: string): Promise<Attachment | null> {
    const doc = this.documents.get(documentId);
    if (!doc) return null;

    return doc.attachments.find(a => a.id === attachmentId) || null;
  }
}

/**
 * Settings Provider - provides AI model configuration
 */
class SimpleSettingsProvider implements SettingsProvider {
  private models = new Map<string, AIModel>();

  constructor() {
    // Example: Add some default models
    this.models.set('gpt-4', {
      name: 'gpt-4',
      url: 'http://localhost:1234/v1',
      model: 'gpt-4',
      api_key: ''
    });

    this.models.set('claude-3', {
      name: 'claude-3',
      url: 'https://api.anthropic.com/v1',
      model: 'claude-3-sonnet-20240229',
      api_key: process.env.ANTHROPIC_API_KEY || ''
    });
  }

  async getModel(modelName: string): Promise<AIModel | null> {
    return this.models.get(modelName) || null;
  }

  async getTimeoutMs(): Promise<number> {
    return 120000; // 2 minutes
  }

  async getSummarizationConfig() {
    return {
      model: 'gpt-4',
      promptTemplate: 'Summarize the following in 2-3 sentences:\n\n{text}'
    };
  }

  async getChatSystemPrompt(): Promise<string | null> {
    return 'You are a helpful AI assistant participating in a collaborative discussion.';
  }
}

/**
 * Logger Provider - handles activity logging
 */
class SimpleLoggerProvider implements LoggerProvider {
  async logOperation(operation: string, userId: string, metadata?: any): Promise<void> {
    console.log(`[LOG] ${operation} by ${userId}`, metadata);
  }

  async logError(operation: string, error: Error): Promise<void> {
    console.error(`[ERROR] ${operation}:`, error.message);
  }
}

/**
 * Event Broadcaster - sends real-time updates (Socket.IO example)
 */
class SimpleEventBroadcaster implements EventBroadcaster {
  constructor(private io: any) {}

  emit(room: string, event: string, data: any): void {
    this.io.to(room).emit(event, data);
    console.log(`[BROADCAST] ${event} to room ${room}`);
  }
}

// ============================================================================
// 2. Set Up Express Server with Council
// ============================================================================

const app = express();
app.use(express.json());

// Mock Socket.IO instance for this example
const mockIO = {
  to: (room: string) => ({
    emit: (event: string, data: any) => {
      console.log(`[MockIO] Event '${event}' to room '${room}'`, data);
    }
  })
};

// Initialize Council Orchestrator
const council = new CouncilOrchestrator({
  documentProvider: new SimpleDocumentProvider(),
  settingsProvider: new SimpleSettingsProvider(),
  loggerProvider: new SimpleLoggerProvider(),
  broadcaster: new SimpleEventBroadcaster(mockIO)
});

// Set up response handler
council.onResponse(async (response, documentId) => {
  console.log(`\n=== Expert Response ===`);
  console.log(`Document: ${documentId}`);
  console.log(`Expert: ${response.expertUserId}`);
  console.log(`Message: ${response.message.substring(0, 100)}...`);
  console.log(`Timestamp: ${response.timestamp}`);

  // In a real app, you would save this to your database:
  // await saveMessageToDatabase({
  //   documentId,
  //   userId: response.expertUserId,
  //   content: response.message,
  //   timestamp: response.timestamp,
  //   diagnosticId: response.diagnosticId
  // });
});

// ============================================================================
// 3. Register Custom Tools
// ============================================================================

council.registerTool(
  {
    name: 'check_code_style',
    description: 'Check if code follows style guidelines',
    parameters: {
      code: {
        type: 'string',
        description: 'Code to check',
        required: true
      }
    },
    needsProcessing: true
  },
  async (args, context) => {
    // Simulate style checking
    const hasIssues = args.code.includes('var ');

    return {
      tool: 'check_code_style',
      result: hasIssues
        ? 'Style issues found: Avoid using "var", use "const" or "let" instead.'
        : 'Code style looks good!',
      success: true
    };
  }
);

// ============================================================================
// 4. API Endpoints
// ============================================================================

/**
 * POST /api/orchestrate
 * Trigger expert orchestration
 */
app.post('/api/orchestrate', async (req, res) => {
  const { documentId, userMessage, userId } = req.body;

  // Define experts for this request
  const experts = [
    {
      userId: 'system-agent:SecurityExpert',
      name: 'SecurityExpert',
      icon: '🔒',
      systemPrompt: 'You are a security expert. Review code for vulnerabilities and security best practices.',
      model: 'gpt-4',
      temperature: 0.3
    },
    {
      userId: 'system-agent:CodeReviewer',
      name: 'CodeReviewer',
      icon: '👨‍💻',
      systemPrompt: 'You are a code reviewer. Focus on code quality, readability, and maintainability.',
      model: 'gpt-4',
      temperature: 0.5
    }
  ];

  try {
    // Trigger orchestration (runs in background)
    await council.orchestrate(
      documentId,
      userMessage,
      userId,
      experts,
      {
        documentContent: "const x = 1;", // In real app, fetch from DocumentProvider
        chatHistory: []
      },
      { isIndirectInvocation: false }
    );

    res.json({
      success: true,
      message: 'Orchestration triggered',
      expertCount: experts.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Orchestration failed',
      details: (error as Error).message
    });
  }
});

/**
 * GET /api/diagnostics/:diagnosticId
 * Retrieve diagnostic information
 */
app.get('/api/diagnostics/:diagnosticId', (req, res) => {
  const diagnostic = council.getDiagnostic(req.params.diagnosticId);

  if (!diagnostic) {
    res.status(404).json({ error: 'Diagnostic not found' });
    return;
  }

  res.json(diagnostic);
});

/**
 * GET /api/diagnostics/model/:modelName
 * Get all diagnostics for a model
 */
app.get('/api/diagnostics/model/:modelName', (req, res) => {
  const diagnostics = council.getModelDiagnostics(req.params.modelName);
  res.json(diagnostics);
});

/**
 * POST /api/test-connection
 * Test AI model connectivity
 */
app.post('/api/test-connection', async (req, res) => {
  const { modelName } = req.body;

  try {
    const response = await council.aiClient.chat(
      'Test connection - respond with "OK"',
      modelName,
      0.7,
      10
    );

    res.json({
      success: true,
      response: response.content,
      diagnosticId: response.diagnosticId
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

// ============================================================================
// 5. Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`\nExample requests:`);
  console.log(`  POST http://localhost:${PORT}/api/orchestrate`);
  console.log(`       { "documentId": "doc-123", "userMessage": "Review this code", "userId": "user-456" }`);
  console.log(`\n  POST http://localhost:${PORT}/api/test-connection`);
  console.log(`       { "modelName": "gpt-4" }`);
  console.log();
});
