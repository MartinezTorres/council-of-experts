/**
 * Example: Integrating council-of-experts with Express
 *
 * This example shows how to:
 * - Implement EngineAdapter for OpenAI
 * - Implement ToolHost for custom tools
 * - Set up councils in an Express application
 * - Handle persistence of council records
 * - Expose council API via HTTP endpoints
 */

import express from 'express';
import {
  createCouncilModule,
  type AgentDefinition,
  type EngineAdapter,
  type EngineInput,
  type EngineOutput,
  type ToolHost,
  type ToolCall,
  type ToolResult,
  type ToolExecutionContext,
  type Council,
  type CouncilReplayEntry,
  type CouncilRecord
} from 'council-of-experts';

// ============================================================================
// 1. Implement EngineAdapter
// ============================================================================

/**
 * /v1/chat/completions compatible engine adapter.
 * Works with any local model server (llama.cpp, Ollama, LM Studio, vLLM, etc.)
 */
class ChatCompletionsEngine implements EngineAdapter {
  async generate(input: EngineInput): Promise<EngineOutput> {
    const { agent, event, history, mode } = input;
    const engineSpec = agent.engine;

    // Build messages
    const messages = [
      { role: 'system' as const, content: agent.systemPrompt }
    ];

    // Add history
    for (const msg of history.slice(-10)) {
      messages.push({
        role: msg.author.type === 'agent' ? 'assistant' as const : 'user' as const,
        content: `${msg.author.name}: ${msg.content}`
      });
    }

    // Add current event
    messages.push({
      role: 'user' as const,
      content: event.content
    });

    // Call OpenAI API
    const response = await fetch(`${engineSpec.provider}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${engineSpec.settings?.api_key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: engineSpec.model,
        messages,
        temperature: engineSpec.settings?.temperature ?? 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    return {
      content,
      metadata: { model: engineSpec.model }
    };
  }
}

// ============================================================================
// 2. Implement ToolHost
// ============================================================================

/**
 * Simple in-memory tool host
 */
class SimpleToolHost implements ToolHost {
  private documents = new Map<string, string>();

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
    switch (call.name) {
      case 'read_document':
        const content = this.documents.get(ctx.councilId) || 'Empty document';
        return { ok: true, content };

      case 'write_document':
        const newContent = call.args?.content as string;
        if (!newContent) {
          return { ok: false, error: 'Missing content argument' };
        }
        this.documents.set(ctx.councilId, newContent);
        return { ok: true, content: `Document updated (${newContent.length} chars)` };

      default:
        return { ok: false, error: `Unknown tool: ${call.name}` };
    }
  }
}

// ============================================================================
// 3. Persistence Layer (In-Memory Example)
// ============================================================================

/**
 * Simple in-memory persistence for demonstration
 * In production, use a database or event store
 */
class InMemoryPersistence {
  private logs = new Map<string, CouncilReplayEntry[]>();

  async append(councilId: string, entry: CouncilReplayEntry): Promise<void> {
    const log = this.logs.get(councilId) || [];
    log.push(entry);
    this.logs.set(councilId, log);
  }

  async appendRecords(councilId: string, records: CouncilRecord[]): Promise<void> {
    for (const record of records) {
      await this.append(councilId, { type: 'council.record', record });
    }
  }

  async load(councilId: string): Promise<CouncilReplayEntry[]> {
    return this.logs.get(councilId) || [];
  }
}

// ============================================================================
// 4. Set Up Express Server
// ============================================================================

const app = express();
app.use(express.json());

// Initialize persistence
const persistence = new InMemoryPersistence();

// Define agents
const agents: AgentDefinition[] = [
  {
    id: 'security-expert',
    name: 'Security Expert',
    engine: {
      id: 'local-llm',
      provider: process.env.LLM_URL || 'http://localhost:1234',
      model: process.env.LLM_MODEL || 'your-model-name',
      contextWindow: 8192,
      settings: { temperature: 0.3 }
    },
    modelName: process.env.LLM_MODEL || 'your-model-name',
    summary: 'Security and vulnerability analysis',
    systemPrompt: 'You are a security expert. Review code for vulnerabilities and best practices.',
    metadata: { icon: '🔒' }
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    engine: {
      id: 'local-llm',
      provider: process.env.LLM_URL || 'http://localhost:1234',
      model: process.env.LLM_MODEL || 'your-model-name',
      contextWindow: 8192,
      settings: { temperature: 0.5 }
    },
    modelName: process.env.LLM_MODEL || 'your-model-name',
    summary: 'Code quality and maintainability',
    systemPrompt: 'You are a code reviewer. Focus on code quality, readability, and maintainability.',
    metadata: { icon: '👨‍💻' }
  }
];

// Create council module
const councilModule = createCouncilModule({
  agents,
  engines: { 'local-llm': new ChatCompletionsEngine() },
  toolHost: new SimpleToolHost()
});

// Council cache (in production, manage lifecycle appropriately)
const councils = new Map<string, Council>();

/**
 * Get or create council
 */
async function getCouncil(councilId: string): Promise<Council> {
  let council = councils.get(councilId);

  if (!council) {
    // Open new council
    council = await councilModule.openCouncil({
      councilId,
      initialMode: 'open'
    });

    // Replay persisted history
    const entries = await persistence.load(councilId);
    if (entries.length > 0) {
      await council.replay(entries);
    }

    councils.set(councilId, council);
  }

  return council;
}

// ============================================================================
// 5. API Endpoints
// ============================================================================

/**
 * POST /api/council/:councilId/post
 * Post a new event to the council
 */
app.post('/api/council/:councilId/post', async (req, res) => {
  const { councilId } = req.params;
  const { content, userId, mode } = req.body;

  try {
    const council = await getCouncil(councilId);

    // Create chat event
    const chatEvent = {
      actor: {
        type: 'user' as const,
        id: userId || 'anonymous',
        name: req.body.userName || 'User'
      },
      content,
      timestamp: new Date().toISOString()
    };

    // Persist incoming event
    await persistence.append(councilId, { type: 'host.chat', event: chatEvent });

    // Process turn
    const result = await council.post(chatEvent, { mode: mode || 'open' });

    // Persist records
    await persistence.appendRecords(councilId, result.records);

    res.json({
      turnId: result.turnId,
      mode: result.mode,
      publicMessages: result.publicMessages.map(m => ({
        author: m.author.name,
        content: m.content,
        timestamp: m.timestamp
      })),
      privateMessageCount: result.privateMessages.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Turn processing failed',
      details: (error as Error).message
    });
  }
});

/**
 * GET /api/council/:councilId/messages
 * Get message history
 */
app.get('/api/council/:councilId/messages', async (req, res) => {
  const { councilId } = req.params;
  const visibility = req.query.visibility as 'public' | 'private' | 'all' | undefined;

  try {
    const council = await getCouncil(councilId);
    const messages = await council.getMessages({ visibility: visibility || 'public' });

    res.json({
      messages: messages.map(m => ({
        author: m.author.name,
        content: m.content,
        visibility: m.visibility,
        timestamp: m.timestamp
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve messages',
      details: (error as Error).message
    });
  }
});

/**
 * GET /api/council/:councilId/status
 * Get council diagnostic status
 */
app.get('/api/council/:councilId/status', async (req, res) => {
  const { councilId } = req.params;

  try {
    const council = await getCouncil(councilId);
    const status = await council.getStatus();

    res.json(status);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve status',
      details: (error as Error).message
    });
  }
});

/**
 * POST /api/council/:councilId/mode
 * Change council mode
 */
app.post('/api/council/:councilId/mode', async (req, res) => {
  const { councilId } = req.params;
  const { mode } = req.body;

  if (mode !== 'open' && mode !== 'council' && mode !== 'oracle') {
    res.status(400).json({ error: 'Invalid mode' });
    return;
  }

  try {
    const council = await getCouncil(councilId);
    const currentMode = council.getMode();

    res.json({
      currentMode,
      message: `Mode will change to '${mode}' on next turn`
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to change mode',
      details: (error as Error).message
    });
  }
});

/**
 * GET /api/agents
 * List available agents
 */
app.get('/api/agents', (req, res) => {
  const agentList = councilModule.listAgents();
  res.json({
    agents: agentList.map(a => ({
      id: a.id,
      name: a.name,
      summary: a.summary,
      icon: a.metadata?.icon
    }))
  });
});

// ============================================================================
// 6. Start Server
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n🚀 Council of Experts API running on http://localhost:${PORT}`);
  console.log(`\nExample requests:`);
  console.log(`\n  POST http://localhost:${PORT}/api/council/session-123/post`);
  console.log(`       { "content": "Review this code", "userId": "user-1", "mode": "open" }`);
  console.log(`\n  GET  http://localhost:${PORT}/api/council/session-123/messages?visibility=all`);
  console.log(`\n  GET  http://localhost:${PORT}/api/council/session-123/status`);
  console.log(`\n  GET  http://localhost:${PORT}/api/agents`);
  console.log();
});
