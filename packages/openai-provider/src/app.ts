import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import {
  createCouncilModule,
  generateId,
  OpenAIChatCompletionsEngine,
  type AgentDefinition,
  type CouncilModule,
  type EngineAdapter,
  type EngineInput,
  type EngineOutput,
  type EngineSpec,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type TurnResult,
} from 'council-of-experts';
import { loadConfig } from './config.js';
import {
  DocumentVault,
  mergeAgentTools,
} from './documentVault.js';
import { buildChatEvent, buildTranscript } from './transcript.js';
import type {
  ModelStats,
  OpenAIChatCompletionRequest,
  OpenAIToolChoice,
  RequestTrace,
  ResolvedProviderConfig,
  VirtualModelRuntime,
} from './types.js';

const JSON_BODY_LIMIT_BYTES = 1_000_000;
const TRACE_LIMIT = 100;

function buildPrivateDeliberation(input: {
  transcript: string;
  privateMessages: Array<{ author: { name: string }; content: string }>;
}) {
  return input.privateMessages.length === 0
    ? '(no private deliberation)'
    : input.privateMessages
        .map((message) => `${message.author.name}: ${message.content}`)
        .join('\n\n');
}

function buildOraclePreparationPrompt(input: {
  transcript: string;
  privateMessages: Array<{ author: { name: string }; content: string }>;
  hasLocalDocuments: boolean;
}): string {
  const privateDeliberation = buildPrivateDeliberation(input);
  return [
    'You are the Oracle, speaking with one unified voice for the council.',
    'Prepare the best possible assistant response for the conversation below.',
    input.hasLocalDocuments
      ? 'If you need one of your assigned documents, call vault.read(path) with the exact path.'
      : 'No local documents are available in this step.',
    'Do not call client-visible tools in this step.',
    'Do not mention hidden deliberation or internal agents.',
    '',
    'Original request transcript:',
    input.transcript,
    '',
    'Private deliberation from council members:',
    privateDeliberation,
  ].join('\n');
}

function buildOracleExternalSynthesisPrompt(input: {
  transcript: string;
  privateMessages: Array<{ author: { name: string }; content: string }>;
  draftContent?: string;
}): string {
  const privateDeliberation = buildPrivateDeliberation(input);

  return [
    'You are the Oracle, speaking with one unified voice for the council.',
    'Produce the single best next assistant action for the conversation below.',
    'If client-visible tools are available and necessary, you may call them.',
    'Do not mention hidden deliberation or internal agents.',
    '',
    'Original request transcript:',
    input.transcript,
    '',
    'Private deliberation from council members:',
    privateDeliberation,
    '',
    'Preparation draft:',
    input.draftContent && input.draftContent.trim().length > 0
      ? input.draftContent
      : '(no draft)',
  ].join('\n');
}

function normalizeOpenAITools(tools: OpenAIChatCompletionRequest['tools']): ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool, index) => {
    if (!tool || tool.type !== 'function' || !tool.function || typeof tool.function.name !== 'string') {
      throw new HttpError(400, `Unsupported tool definition at tools[${index}]`);
    }

    return {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    };
  });
}

function normalizeToolChoice(
  toolChoice: OpenAIToolChoice | undefined
): OpenAIToolChoice | undefined {
  if (
    toolChoice === undefined ||
    toolChoice === 'auto' ||
    toolChoice === 'none' ||
    toolChoice === 'required'
  ) {
    return toolChoice;
  }

  if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.type === 'function' &&
    toolChoice.function &&
    typeof toolChoice.function.name === 'string'
  ) {
    return toolChoice;
  }

  throw new HttpError(400, 'Unsupported tool_choice value');
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly type: string = 'invalid_request_error',
    readonly code?: string
  ) {
    super(message);
  }
}

function assertRequestMethod(
  req: IncomingMessage,
  method: string
): void {
  if (req.method !== method) {
    throw new HttpError(405, `Method not allowed: expected ${method}`);
  }
}

function createErrorPayload(error: HttpError | Error) {
  if (error instanceof HttpError) {
    return {
      error: {
        message: error.message,
        type: error.type,
        code: error.code ?? null,
      },
    };
  }

  return {
    error: {
      message: error.message,
      type: 'server_error',
      code: null,
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > JSON_BODY_LIMIT_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  body: string
): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

export class CouncilOpenAIProviderApp {
  private readonly startedAt = Date.now();
  private readonly modelRuntimes = new Map<string, VirtualModelRuntime>();
  private readonly stats = new Map<string, ModelStats>();
  private readonly inFlight = new Map<string, RequestTrace>();
  private readonly recentTraces: RequestTrace[] = [];

  constructor(readonly config: ResolvedProviderConfig) {
    for (const [modelId, virtualModel] of Object.entries(config.virtualModels)) {
      const runtime = this.createVirtualModelRuntime(modelId, virtualModel);
      this.modelRuntimes.set(modelId, runtime);
      this.stats.set(modelId, {
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        inFlightCount: 0,
        totalLatencyMs: 0,
      });
    }
  }

  static fromConfigPath(configPath: string): CouncilOpenAIProviderApp {
    return new CouncilOpenAIProviderApp(loadConfig(configPath));
  }

  createServer(): Server {
    return createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
  }

  async listen(): Promise<Server> {
    const server = this.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.server.port, this.config.server.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  }

  private createVirtualModelRuntime(
    modelId: string,
    config: ResolvedProviderConfig['virtualModels'][string]
  ): VirtualModelRuntime {
    const documentVault = new DocumentVault(
      Object.fromEntries(
        config.agents.map((agentConfig) => [
          agentConfig.id,
          agentConfig.documents ?? [],
        ])
      )
    );
    const agents: AgentDefinition[] = [];
    const engines: Record<string, EngineAdapter> = {};

    for (const agentConfig of config.agents) {
      const engineId = `${modelId}:${agentConfig.id}`;
      const engineSpec: EngineSpec = {
        id: engineId,
        provider: agentConfig.engine.provider,
        model: agentConfig.engine.model,
        contextWindow: agentConfig.engine.contextWindow,
        charsPerToken: agentConfig.engine.charsPerToken,
        responseReserveTokens: agentConfig.engine.responseReserveTokens,
        settings: agentConfig.engine.settings,
      };

      agents.push({
        id: agentConfig.id,
        name: agentConfig.name,
        engine: engineSpec,
        summary: agentConfig.summary,
        systemPrompt: agentConfig.systemPrompt,
        tools: mergeAgentTools(
          agentConfig.tools,
          documentVault.getToolForAgent(agentConfig.id)
        ),
        metadata: agentConfig.metadata,
      });

      engines[engineId] = new OpenAIChatCompletionsEngine(
        agentConfig.engine.timeoutMs ?? 60000
      );
    }

    const councilModule = createCouncilModule({
      agents,
      engines,
      toolHost: documentVault.createToolHost(),
      runtime: config.runtime,
    });

    return {
      id: modelId,
      description: config.description,
      agents,
      documentVault,
      councilModule,
      engines,
    };
  }

  private async handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/health') {
        assertRequestMethod(req, 'GET');
        writeText(res, 200, 'OK');
        return;
      }

      if (url.pathname === '/v1/models') {
        this.assertAuthorized(req);
        assertRequestMethod(req, 'GET');
        writeJson(res, 200, this.listModelsResponse());
        return;
      }

      if (url.pathname === '/v1/chat/completions') {
        this.assertAuthorized(req);
        assertRequestMethod(req, 'POST');
        const body = (await readJsonBody(req)) as OpenAIChatCompletionRequest;
        const payload = await this.handleChatCompletions(body);
        writeJson(res, 200, payload);
        return;
      }

      if (url.pathname === '/debug/status') {
        this.assertDebugEnabled();
        assertRequestMethod(req, 'GET');
        writeJson(res, 200, this.getDebugStatus());
        return;
      }

      if (url.pathname === '/debug/config') {
        this.assertDebugEnabled();
        assertRequestMethod(req, 'GET');
        writeJson(res, 200, this.config);
        return;
      }

      if (url.pathname === '/debug/running') {
        this.assertDebugEnabled();
        assertRequestMethod(req, 'GET');
        writeJson(res, 200, Array.from(this.inFlight.values()));
        return;
      }

      if (url.pathname === '/debug/requests') {
        this.assertDebugEnabled();
        assertRequestMethod(req, 'GET');
        writeJson(res, 200, this.recentTraces);
        return;
      }

      if (url.pathname.startsWith('/debug/requests/')) {
        this.assertDebugEnabled();
        assertRequestMethod(req, 'GET');
        const requestId = decodeURIComponent(url.pathname.slice('/debug/requests/'.length));
        const trace = this.recentTraces.find((entry) => entry.id === requestId);
        if (!trace) {
          throw new HttpError(404, `Unknown request id: ${requestId}`);
        }
        writeJson(res, 200, trace);
        return;
      }

      throw new HttpError(404, `Unknown path: ${url.pathname}`);
    } catch (error) {
      const httpError =
        error instanceof HttpError
          ? error
          : new HttpError(500, error instanceof Error ? error.message : String(error), 'server_error');
      writeJson(res, httpError.statusCode, createErrorPayload(httpError));
    }
  }

  private assertAuthorized(req: IncomingMessage): void {
    const apiKeys = this.config.server.apiKeys;
    if (apiKeys.length === 0) {
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new HttpError(401, 'Missing bearer token', 'authentication_error');
    }

    const token = header.slice('Bearer '.length);
    if (!apiKeys.includes(token)) {
      throw new HttpError(401, 'Invalid bearer token', 'authentication_error');
    }
  }

  private assertDebugEnabled(): void {
    if (!this.config.debug.enabled) {
      throw new HttpError(404, 'Debug endpoints are disabled');
    }
  }

  private listModelsResponse() {
    return {
      object: 'list',
      data: Array.from(this.modelRuntimes.values()).map((runtime) => ({
        id: runtime.id,
        object: 'model',
        created: 0,
        owned_by: 'council-of-experts',
      })),
    };
  }

  private async handleChatCompletions(request: OpenAIChatCompletionRequest) {
    if (!request || typeof request !== 'object') {
      throw new HttpError(400, 'Request body must be an object');
    }

    if (typeof request.model !== 'string' || request.model.trim().length === 0) {
      throw new HttpError(400, 'Request model is required');
    }

    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new HttpError(400, 'Request messages must be a non-empty array');
    }

    if (request.stream === true) {
      throw new HttpError(400, 'stream=true is not supported');
    }

    const runtime = this.modelRuntimes.get(request.model);
    if (!runtime) {
      throw new HttpError(404, `Unknown model: ${request.model}`);
    }

    const requestId = generateId();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const transcript = buildTranscript(request);
    const tools = normalizeOpenAITools(request.tools);
    const toolChoice = normalizeToolChoice(request.tool_choice);
    if (!tools && toolChoice !== undefined) {
      throw new HttpError(400, 'tool_choice requires tools');
    }
    const trace: RequestTrace = {
      id: requestId,
      model: request.model,
      startedAt,
      request,
      transcript,
    };

    this.inFlight.set(requestId, trace);
    const stats = this.stats.get(request.model)!;
    stats.requestCount += 1;
    stats.inFlightCount += 1;

    let council:
      | Awaited<ReturnType<CouncilModule['openCouncil']>>
      | undefined;

    try {
      council = await runtime.councilModule.openCouncil({
        councilId: `request-${requestId}`,
        initialMode: 'oracle',
        metadata: {
          requestId,
          model: request.model,
        },
      });

      const result = await council.post(
        buildChatEvent(request, requestId, transcript),
        { mode: 'oracle', emitPublicOracle: false }
      );
      const status = await council.getStatus();
      const councilConfig = council.getConfig();
      await council.dispose();
      council = undefined;

      const synthesis = await this.runOracleSynthesis({
        requestId,
        runtime,
        transcript,
        privateMessages: result.privateMessages,
        tools,
        toolChoice,
      });
      const response = this.toChatCompletionResponse(
        requestId,
        request.model,
        synthesis.output
      );
      const durationMs = Date.now() - startedAtMs;

      stats.successCount += 1;
      stats.inFlightCount -= 1;
      stats.totalLatencyMs += durationMs;
      stats.lastLatencyMs = durationMs;

      trace.endedAt = new Date().toISOString();
      trace.durationMs = durationMs;
      trace.council = {
        config: councilConfig,
        status,
        publicMessages: result.publicMessages,
        privateMessages: result.privateMessages,
        records: result.records,
        errors: result.errors,
      };
      trace.synthesis = {
        agentId: synthesis.agent.id,
        localDocuments: runtime.documentVault.listDocumentsForAgent(
          synthesis.agent.id
        ),
        localToolCalls:
          synthesis.localToolCalls.length > 0 ? synthesis.localToolCalls : undefined,
        localToolResults:
          synthesis.localToolResults.length > 0
            ? synthesis.localToolResults
            : undefined,
        draftOutput: synthesis.draftOutput,
        finalOutput: synthesis.output,
      };
      trace.response = response;
      this.finishTrace(trace);

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAtMs;

      stats.errorCount += 1;
      stats.inFlightCount -= 1;
      stats.totalLatencyMs += durationMs;
      stats.lastLatencyMs = durationMs;
      stats.lastError = message;

      trace.endedAt = new Date().toISOString();
      trace.durationMs = durationMs;
      if (council) {
        try {
          trace.council = {
            config: council.getConfig(),
            status: await council.getStatus(),
          };
          await council.dispose();
        } catch {
          // Best-effort cleanup and diagnostics only.
        }
      }
      trace.error = {
        message,
        statusCode: 500,
      };
      this.finishTrace(trace);

      throw new HttpError(500, message, 'server_error');
    }
  }

  private toChatCompletionResponse(
    requestId: string,
    model: string,
    output: EngineOutput
  ) {
    const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
    const hasToolCalls = toolCalls.length > 0;

    return {
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: hasToolCalls ? (output.content || null) : output.content,
            ...(hasToolCalls
              ? {
                  tool_calls: toolCalls.map((call, index) => ({
                    id: call.id ?? `call_${index + 1}`,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.args ?? {}),
                    },
                  })),
                }
              : {}),
          },
          finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
        },
      ],
    };
  }

  private async runOracleSynthesis(input: {
    requestId: string;
    runtime: VirtualModelRuntime;
    transcript: string;
    privateMessages: TurnResult['privateMessages'];
    tools?: ToolDefinition[];
    toolChoice?: OpenAIToolChoice;
  }): Promise<{
    output: EngineOutput;
    agent: AgentDefinition;
    localToolCalls: ToolCall[];
    localToolResults: ToolResult[];
    draftOutput?: EngineOutput;
  }> {
    const agent = input.runtime.agents[0];
    if (!agent) {
      throw new Error(`Virtual model ${input.runtime.id} has no agents`);
    }

    const engine = input.runtime.engines[agent.engine.id];
    if (!engine) {
      throw new Error(`Engine ${agent.engine.id} not found for agent ${agent.id}`);
    }

    const localTool = input.runtime.documentVault.getToolForAgent(agent.id);

    let draftOutput: EngineOutput | undefined;
    let localToolCalls: ToolCall[] = [];
    let localToolResults: ToolResult[] = [];

    if (!input.tools || input.tools.length === 0 || localTool) {
      const preparation = await this.runOraclePreparation({
        requestId: input.requestId,
        runtime: input.runtime,
        agent,
        engine,
        transcript: input.transcript,
        privateMessages: input.privateMessages,
        localTool,
        documentVault: input.runtime.documentVault,
      });

      draftOutput = preparation.output;
      localToolCalls = preparation.localToolCalls;
      localToolResults = preparation.localToolResults;

      if (!input.tools || input.tools.length === 0) {
        return {
          output: preparation.output,
          agent,
          localToolCalls,
          localToolResults,
          draftOutput,
        };
      }
    }

    const output = await this.runOracleExternalSynthesis({
      requestId: input.requestId,
      agent,
      engine,
      transcript: input.transcript,
      privateMessages: input.privateMessages,
      draftContent: draftOutput?.content,
      tools: input.tools,
      toolChoice: input.toolChoice,
    });

    return {
      output,
      agent,
      localToolCalls,
      localToolResults,
      draftOutput,
    };
  }

  private createSynthesisInput(input: {
    requestId: string;
    turnId: string;
    agent: AgentDefinition;
    content: string;
    tools?: ToolDefinition[];
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    toolChoice?: OpenAIToolChoice;
  }): EngineInput {
    return {
      councilId: `request-${input.requestId}`,
      turnId: input.turnId,
      agent: input.agent,
      mode: 'oracle',
      event: {
        id: input.turnId,
        actor: {
          type: 'system',
          id: 'openai-provider',
          name: 'OpenAI Provider',
        },
        content: input.content,
        timestamp: new Date().toISOString(),
        metadata:
          input.toolChoice !== undefined
            ? {
                openai_tool_choice: input.toolChoice,
              }
            : undefined,
      },
      history: [],
      tools: input.tools,
      toolCalls: input.toolCalls,
      toolResults: input.toolResults,
    };
  }

  private async runOraclePreparation(input: {
    requestId: string;
    runtime: VirtualModelRuntime;
    agent: AgentDefinition;
    engine: EngineAdapter;
    transcript: string;
    privateMessages: TurnResult['privateMessages'];
    localTool?: ToolDefinition;
    documentVault: DocumentVault;
  }): Promise<{
    output: EngineOutput;
    localToolCalls: ToolCall[];
    localToolResults: ToolResult[];
  }> {
    const localToolCalls: ToolCall[] = [];
    const localToolResults: ToolResult[] = [];
    const maxRounds = input.runtime.councilModule.getConfig().runtime.maxRounds;
    let toolRounds = 0;

    while (true) {
      const output = await input.engine.generate(
        this.createSynthesisInput({
          requestId: input.requestId,
          turnId: `synthesis-prep-${input.requestId}`,
          agent: input.agent,
          content: buildOraclePreparationPrompt({
            transcript: input.transcript,
            privateMessages: input.privateMessages,
            hasLocalDocuments: input.localTool !== undefined,
          }),
          tools: input.localTool ? [input.localTool] : undefined,
          toolCalls:
            localToolCalls.length > 0 ? localToolCalls : undefined,
          toolResults:
            localToolResults.length > 0 ? localToolResults : undefined,
        })
      );

      const pendingCalls = Array.isArray(output.toolCalls)
        ? output.toolCalls
        : [];
      if (pendingCalls.length === 0) {
        return {
          output,
          localToolCalls,
          localToolResults,
        };
      }

      if (toolRounds >= maxRounds) {
        throw new Error(
          `Max local tool rounds (${maxRounds}) reached for oracle synthesizer ${input.agent.id}`
        );
      }
      toolRounds += 1;

      for (const call of pendingCalls) {
        const normalizedCall: ToolCall = {
          ...call,
          id: call.id ?? generateId(),
        };
        const result = await input.documentVault.executeForAgent(
          input.agent.id,
          normalizedCall
        );

        localToolCalls.push(normalizedCall);
        localToolResults.push({
          ...result,
          callId: normalizedCall.id,
        });
      }
    }
  }

  private async runOracleExternalSynthesis(input: {
    requestId: string;
    agent: AgentDefinition;
    engine: EngineAdapter;
    transcript: string;
    privateMessages: TurnResult['privateMessages'];
    draftContent?: string;
    tools: ToolDefinition[];
    toolChoice?: OpenAIToolChoice;
  }): Promise<EngineOutput> {
    const output = await input.engine.generate(
      this.createSynthesisInput({
        requestId: input.requestId,
        turnId: `synthesis-${input.requestId}`,
        agent: input.agent,
        content: buildOracleExternalSynthesisPrompt({
          transcript: input.transcript,
          privateMessages: input.privateMessages,
          draftContent: input.draftContent,
        }),
        tools: input.tools,
        toolChoice: input.toolChoice ?? 'auto',
      })
    );

    const allowedToolNames = new Set(input.tools.map((tool) => tool.name));
    const toolCalls = (output.toolCalls ?? []).filter((call) =>
      allowedToolNames.has(call.name)
    );

    return {
      ...output,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  private finishTrace(trace: RequestTrace): void {
    this.inFlight.delete(trace.id);
    this.recentTraces.unshift(trace);
    if (this.recentTraces.length > TRACE_LIMIT) {
      this.recentTraces.length = TRACE_LIMIT;
    }
  }

  getDebugStatus() {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      debugEnabled: this.config.debug.enabled,
      inFlightCount: this.inFlight.size,
      server: this.config.server,
      virtualModels: Array.from(this.modelRuntimes.values()).map((runtime) => ({
        id: runtime.id,
        description: runtime.description,
        runtime: runtime.councilModule.getConfig().runtime,
        stats: this.stats.get(runtime.id),
        agents: runtime.agents,
        documentsByAgent: Object.fromEntries(
          runtime.agents.map((agent) => [
            agent.id,
            runtime.documentVault.listDocumentsForAgent(agent.id),
          ])
        ),
      })),
      recentRequestCount: this.recentTraces.length,
    };
  }
}
