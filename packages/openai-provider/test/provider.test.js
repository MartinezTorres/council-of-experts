import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CouncilOpenAIProviderApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { DocumentVault } from '../dist/documentVault.js';

function createResult(includePublic = true) {
  return {
    turnId: 'turn-1',
    mode: 'oracle',
    nextMode: 'oracle',
    publicMessages: includePublic
      ? [
          {
            id: 'public-1',
            turnId: 'turn-1',
            author: { type: 'oracle', id: 'oracle', name: 'Oracle' },
            visibility: 'public',
            content: 'final oracle answer',
            timestamp: new Date().toISOString(),
          },
        ]
      : [],
    privateMessages: [
      {
        id: 'private-1',
        turnId: 'turn-1',
        author: { type: 'agent', id: 'a', name: 'A' },
        visibility: 'private',
        content: 'private thought a',
        timestamp: new Date().toISOString(),
      },
      {
        id: 'private-2',
        turnId: 'turn-1',
        author: { type: 'agent', id: 'b', name: 'B' },
        visibility: 'private',
        content: 'private thought b',
        timestamp: new Date().toISOString(),
      },
    ],
    records: [],
    errors: [],
  };
}

function createFakeCouncilModule() {
  return {
    async openCouncil() {
      return {
        async post(_event, options) {
          return createResult(options?.emitPublicOracle !== false);
        },
        async getStatus() {
          return { mode: 'oracle', messageCount: 3 };
        },
        getConfig() {
          return {
            councilId: 'request-1',
            initialMode: 'oracle',
            runtime: {
              initialMode: 'open',
              maxRounds: 1,
              maxAgentReplies: 2,
            },
          };
        },
        async dispose() {},
      };
    },
    getConfig() {
      return {
        runtime: {
          initialMode: 'open',
          maxRounds: 1,
          maxAgentReplies: 2,
        },
      };
    },
  };
}

function createFakeEngine() {
  return {
    async generate(input) {
      const prompt = input.event.content;
      const promptMessages = input.event.promptMessages ?? [];
      const promptMessageText = JSON.stringify(promptMessages);
      const toolResultText =
        input.toolResults?.map((result) => result.content ?? '').join('\n') ?? '';

      if (
        (input.tools?.length ?? 0) > 0 &&
        !promptMessageText.includes('sunny') &&
        !toolResultText.includes('sunny')
      ) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call_weather',
              name: 'get_weather',
              args: {
                city: 'Berlin',
              },
            },
          ],
        };
      }

      if (promptMessageText.includes('sunny') || toolResultText.includes('sunny')) {
        return {
          content: 'It is sunny in Berlin.',
        };
      }

      return {
        content: 'final oracle answer',
      };
    },
  };
}

function createFakeDocumentEngine() {
  return {
    async generate(input) {
      const toolResult = input.toolResults?.[0]?.content ?? '';

      if ((input.tools?.length ?? 0) > 0 && input.tools[0].name === 'vault.read') {
        if (!toolResult) {
          return {
            content: '',
            toolCalls: [
              {
                id: 'call_doc',
                name: 'vault.read',
                args: {
                  path: 'docs/brief.txt',
                },
              },
            ],
          };
        }

        return {
          content: `Oracle summary: ${toolResult.split('\n').pop()}`,
        };
      }

      return {
        content: 'final oracle answer',
      };
    },
  };
}

test('provider resolves virtual models, chat completions, and debug traces', async () => {
  const app = new CouncilOpenAIProviderApp({
    server: {
      host: '127.0.0.1',
      port: 0,
      apiKeys: [],
    },
    debug: {
      enabled: true,
      traceRetention: 10,
    },
    limits: {
      requestBodyBytes: 1_000_000,
    },
    fallbacks: {
      agentContextExhaustedMessage: "It's dizzy.",
    },
    virtualModels: {
      'oracle-test': {
        id: 'oracle-test',
        description: 'Test model',
        synthesizerAgentId: 'a',
        runtime: {
          maxRounds: 1,
          maxAgentReplies: 2,
        },
        agents: [
          {
            id: 'a',
            name: 'A',
            summary: 'First agent',
            systemPrompt: 'Be concise.',
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 1024,
              charsPerToken: 4,
              timeoutMs: 1000,
            },
          },
          {
            id: 'b',
            name: 'B',
            summary: 'Second agent',
            systemPrompt: 'Be concise.',
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 1024,
              charsPerToken: 4,
              timeoutMs: 1000,
            },
          },
        ],
      },
    },
  });

  app.modelRuntimes.set('oracle-test', {
    id: 'oracle-test',
    description: 'Test model',
    synthesizerAgentId: 'a',
    documentVault: new DocumentVault({}),
    agents: [
      {
        id: 'a',
        name: 'A',
        engine: {
          id: 'oracle-test:a',
        },
      },
      {
        id: 'b',
        name: 'B',
        engine: {
          id: 'oracle-test:b',
        },
      },
    ],
    councilModule: createFakeCouncilModule(),
    engines: {
      'oracle-test:a': createFakeEngine(),
      'oracle-test:b': createFakeEngine(),
    },
  });

  const models = app.listModelsResponse();
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].id, 'oracle-test');

  const completion = await app.handleChatCompletions({
    model: 'oracle-test',
    messages: [
      {
        role: 'user',
        content: 'Explain why replayable state matters.',
      },
    ],
  });
  assert.equal(completion.choices[0].message.content, 'final oracle answer');

  const debugStatus = app.getDebugStatus();
  assert.equal(debugStatus.virtualModels.length, 1);
  assert.equal(debugStatus.virtualModels[0].stats.successCount, 1);
  assert.equal(debugStatus.virtualModels[0].stats.degradedCount, 0);

  assert.equal(app.recentTraces.length, 1);
  assert.equal(app.recentTraces[0].council.publicMessages.length, 0);
  assert.equal(app.recentTraces[0].council.privateMessages.length, 2);
  assert.equal(app.recentTraces[0].council.agentExecutions.length, 2);
  assert.equal(app.recentTraces[0].council.agentExecutions[0].status, 'succeeded');
  assert.match(app.recentTraces[0].debugTranscript, /Conversation transcript:/);
});

test('provider returns OpenAI tool calls and can follow up from tool results statelessly', async () => {
  const app = new CouncilOpenAIProviderApp({
    server: {
      host: '127.0.0.1',
      port: 0,
      apiKeys: [],
    },
    debug: {
      enabled: true,
      traceRetention: 10,
    },
    limits: {
      requestBodyBytes: 1_000_000,
    },
    fallbacks: {
      agentContextExhaustedMessage: "It's dizzy.",
    },
    virtualModels: {
      'oracle-tools': {
        id: 'oracle-tools',
        description: 'Tool model',
        synthesizerAgentId: 'synth',
        runtime: {
          maxRounds: 1,
          maxAgentReplies: 2,
        },
        agents: [
          {
            id: 'synth',
            name: 'Synth',
            summary: 'Synthesizer',
            systemPrompt: 'Use tools when necessary.',
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 1024,
              charsPerToken: 4,
              timeoutMs: 1000,
            },
          },
          {
            id: 'reviewer',
            name: 'Reviewer',
            summary: 'Reviewer',
            systemPrompt: 'Review carefully.',
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 1024,
              charsPerToken: 4,
              timeoutMs: 1000,
            },
          },
        ],
      },
    },
  });

  app.modelRuntimes.set('oracle-tools', {
    id: 'oracle-tools',
    description: 'Tool model',
    synthesizerAgentId: 'synth',
    documentVault: new DocumentVault({}),
    agents: [
      {
        id: 'synth',
        name: 'Synth',
        engine: {
          id: 'oracle-tools:synth',
        },
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        engine: {
          id: 'oracle-tools:reviewer',
        },
      },
    ],
    councilModule: createFakeCouncilModule(),
    engines: {
      'oracle-tools:synth': createFakeEngine(),
      'oracle-tools:reviewer': createFakeEngine(),
    },
  });

  const firstResponse = await app.handleChatCompletions({
    model: 'oracle-tools',
    messages: [
      {
        role: 'user',
        content: 'What is the weather in Berlin?',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather by city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' },
            },
            required: ['city'],
          },
        },
      },
    ],
  });

  assert.equal(firstResponse.choices[0].finish_reason, 'tool_calls');
  assert.equal(firstResponse.choices[0].message.tool_calls.length, 1);
  assert.equal(firstResponse.choices[0].message.tool_calls[0].function.name, 'get_weather');

  const secondResponse = await app.handleChatCompletions({
    model: 'oracle-tools',
    messages: [
      {
        role: 'user',
        content: 'What is the weather in Berlin?',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: firstResponse.choices[0].message.tool_calls,
      },
      {
        role: 'tool',
        tool_call_id: firstResponse.choices[0].message.tool_calls[0].id,
        content: 'sunny',
      },
    ],
  });

  assert.equal(secondResponse.choices[0].finish_reason, 'stop');
  assert.equal(secondResponse.choices[0].message.content, 'It is sunny in Berlin.');
});

test('provider prompt overrides drive request mapping and oracle synthesis prompts', async () => {
  let capturedCouncilEvent;
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'council-openai-provider-prompts-'));
  mkdirSync(path.join(fixtureDir, 'docs'));
  writeFileSync(
    path.join(fixtureDir, 'docs', 'brief.txt'),
    'Prompt test document.',
    'utf8'
  );

  const customCouncilModule = {
    async openCouncil() {
      return {
        async post(event) {
          capturedCouncilEvent = event;
          return createResult(false);
        },
        async getStatus() {
          return { mode: 'oracle', messageCount: 2 };
        },
        getConfig() {
          return {
            councilId: 'request-1',
            initialMode: 'oracle',
            runtime: {
              initialMode: 'open',
              maxRounds: 1,
              maxAgentReplies: 2,
            },
          };
        },
        async dispose() {},
      };
    },
    getConfig() {
      return {
        runtime: {
          initialMode: 'open',
          maxRounds: 1,
          maxAgentReplies: 2,
        },
      };
    },
  };

  const customEngine = {
    async generate(input) {
      if (input.event.content.includes('CUSTOM PREPARATION PROMPT')) {
        return { content: 'draft from custom preparation' };
      }

      if (input.event.content.includes('CUSTOM FINAL PROMPT')) {
        return { content: 'final answer from custom synthesis' };
      }

      return { content: 'unexpected' };
    },
  };

  const app = new CouncilOpenAIProviderApp({
    server: {
      host: '127.0.0.1',
      port: 0,
      apiKeys: [],
    },
    debug: {
      enabled: true,
      traceRetention: 10,
    },
    limits: {
      requestBodyBytes: 1_000_000,
    },
    fallbacks: {
      agentContextExhaustedMessage: "It's dizzy.",
    },
    prompts: {
      requestInstruction: 'CUSTOM REQUEST INSTRUCTION',
      oraclePreparationTemplate:
        'CUSTOM PREPARATION PROMPT\n{{privateDeliberation}}\n{{localDocumentsInstruction}}',
      oracleExternalSynthesisTemplate:
        'CUSTOM FINAL PROMPT\n{{privateDeliberation}}\n{{draftContent}}',
    },
    virtualModels: {
      'oracle-prompts': {
        id: 'oracle-prompts',
        description: 'Prompt model',
        synthesizerAgentId: 'synth',
        runtime: {
          maxRounds: 1,
          maxAgentReplies: 2,
        },
        agents: [
          {
            id: 'synth',
            name: 'Synth',
            summary: 'Synthesizer',
            systemPrompt: 'Use custom prompts.',
            documents: [
              {
                path: 'docs/brief.txt',
              },
            ],
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 1024,
              charsPerToken: 4,
              timeoutMs: 1000,
            },
          },
        ],
      },
    },
  });

  app.modelRuntimes.set('oracle-prompts', {
    id: 'oracle-prompts',
    description: 'Prompt model',
    synthesizerAgentId: 'synth',
    documentVault: new DocumentVault({
      synth: [
        {
          path: 'docs/brief.txt',
          absolutePath: path.join(fixtureDir, 'docs', 'brief.txt'),
        },
      ],
    }),
    agents: [
      {
        id: 'synth',
        name: 'Synth',
        engine: {
          id: 'oracle-prompts:synth',
        },
      },
    ],
    councilModule: customCouncilModule,
    engines: {
      'oracle-prompts:synth': customEngine,
    },
  });

  const response = await app.handleChatCompletions({
    model: 'oracle-prompts',
    messages: [
      {
        role: 'user',
        content: 'Say hello.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'noop_tool',
        },
      },
    ],
  });

  assert.equal(capturedCouncilEvent.content, 'CUSTOM REQUEST INSTRUCTION');
  assert.equal(
    response.choices[0].message.content,
    'final answer from custom synthesis'
  );
});

test('provider forwards structured OpenAI chat history to the shared prompt packer', async () => {
  const app = new CouncilOpenAIProviderApp({
    server: {
      host: '127.0.0.1',
      port: 0,
      apiKeys: [],
    },
    debug: {
      enabled: true,
      traceRetention: 10,
    },
    limits: {
      requestBodyBytes: 1_000_000,
    },
    fallbacks: {
      agentContextExhaustedMessage: "It's dizzy.",
    },
    virtualModels: {
      'oracle-packed-history': {
        id: 'oracle-packed-history',
        description: 'Packed history model',
        synthesizerAgentId: 'editor',
        runtime: {
          maxRounds: 1,
          maxAgentReplies: 1,
        },
        agents: [
          {
            id: 'editor',
            name: 'Editor',
            summary: 'Synthesizer',
            systemPrompt: 'Respond in one short sentence.',
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 1024,
              charsPerToken: 4,
              timeoutMs: 1000,
            },
          },
        ],
      },
    },
  });

  const requestBodies = [];
  app.modelRuntimes.get('oracle-packed-history').engines[
    'oracle-packed-history:editor'
  ].sendRequest = async ({ body }) => {
    requestBodies.push(JSON.parse(body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      bodyText: JSON.stringify({
        choices: [
          {
            message: {
              content: 'final oracle answer',
            },
          },
        ],
      }),
    };
  };

  const response = await app.handleChatCompletions({
    model: 'oracle-packed-history',
    messages: [
      {
        role: 'user',
        content: 'First question',
      },
      {
        role: 'assistant',
        content: 'First answer',
      },
      {
        role: 'user',
        content: 'Second question',
      },
    ],
  });

  assert.equal(response.choices[0].message.content, 'final oracle answer');
  assert.ok(requestBodies.length >= 2);
  assert.equal(requestBodies[0].messages[1].role, 'user');
  assert.equal(requestBodies[0].messages[1].content, 'First question');
  assert.equal(requestBodies[0].messages[2].role, 'assistant');
  assert.equal(requestBodies[0].messages[2].content, 'First answer');
  assert.equal(requestBodies[0].messages[3].role, 'user');
  assert.equal(requestBodies[0].messages[3].content, 'Second question');
  assert.doesNotMatch(
    requestBodies[0].messages.at(-1).content,
    /Conversation transcript:/
  );
});

test('provider lets the oracle read assigned documents with vault.read(path)', async () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'council-openai-provider-'));
  mkdirSync(path.join(fixtureDir, 'docs'));
  writeFileSync(
    path.join(fixtureDir, 'docs', 'brief.txt'),
    'Event-sourced replay rebuilds state from the record stream.',
    'utf8'
  );
  writeFileSync(
    path.join(fixtureDir, 'provider.json'),
    JSON.stringify(
      {
        server: {
          host: '127.0.0.1',
          port: 8787,
          apiKeys: [],
        },
        debug: {
          enabled: true,
        },
        virtualModels: {
          'oracle-docs': {
            description: 'Oracle with documents',
            synthesizerAgentId: 'editor',
            runtime: {
              maxRounds: 2,
              maxAgentReplies: 1,
            },
            agents: [
              {
                id: 'editor',
                name: 'Editor',
                summary: 'Synthesizer',
                systemPrompt: 'Use documents when they help.',
                documents: [
                  {
                    path: 'docs/brief.txt',
                    description: 'Short architecture note',
                  },
                ],
                engine: {
                  provider: 'http://example.test',
                  model: 'stub-model',
                  contextWindow: 1024,
                  charsPerToken: 4,
                  timeoutMs: 1000,
                },
              },
            ],
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const config = loadConfig(path.join(fixtureDir, 'provider.json'));
  const app = new CouncilOpenAIProviderApp(config);
  const runtime = app.modelRuntimes.get('oracle-docs');

  assert.ok(runtime);
  assert.equal(runtime.documentVault.listDocumentsForAgent('editor')[0].path, 'docs/brief.txt');
  assert.equal(runtime.agents[0].tools[0].name, 'vault.read');

  runtime.councilModule = createFakeCouncilModule();
  runtime.engines['oracle-docs:editor'] = createFakeDocumentEngine();

  const response = await app.handleChatCompletions({
    model: 'oracle-docs',
    messages: [
      {
        role: 'user',
        content: 'Why does replay matter here?',
      },
    ],
  });

  assert.equal(
    response.choices[0].message.content,
    'Oracle summary: Event-sourced replay rebuilds state from the record stream.'
  );
  assert.equal(app.recentTraces[0].synthesis.localToolCalls[0].name, 'vault.read');
  assert.equal(
    app.recentTraces[0].synthesis.localToolResults[0].data.path,
    'docs/brief.txt'
  );
});

test('vault.read returns the full assigned document content', async () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'council-openai-provider-'));
  mkdirSync(path.join(fixtureDir, 'docs'));
  writeFileSync(
    path.join(fixtureDir, 'docs', 'large.txt'),
    '0123456789'.repeat(80),
    'utf8'
  );
  writeFileSync(
    path.join(fixtureDir, 'provider.json'),
    JSON.stringify(
      {
        server: {
          host: '127.0.0.1',
          port: 8787,
          apiKeys: [],
        },
        debug: {
          enabled: true,
        },
        virtualModels: {
          'oracle-docs': {
            description: 'Oracle with documents',
            synthesizerAgentId: 'editor',
            runtime: {
              maxRounds: 2,
              maxAgentReplies: 1,
            },
            agents: [
              {
                id: 'editor',
                name: 'Editor',
                summary: 'Synthesizer',
                systemPrompt: 'Use documents when they help.',
                documents: [
                  {
                    path: 'docs/large.txt',
                    description: 'Large architecture note',
                  },
                ],
                engine: {
                  provider: 'http://example.test',
                  model: 'stub-model',
                  contextWindow: 100,
                  charsPerToken: 4,
                  timeoutMs: 1000,
                },
              },
            ],
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  const config = loadConfig(path.join(fixtureDir, 'provider.json'));
  const app = new CouncilOpenAIProviderApp(config);
  const runtime = app.modelRuntimes.get('oracle-docs');

  assert.ok(runtime);

  const result = await runtime.documentVault.executeForAgent('editor', {
    name: 'vault.read',
    args: {
      path: 'docs/large.txt',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.path, 'docs/large.txt');
  assert.match(result.content, /^Path: docs\/large.txt/);
  assert.match(result.content, /01234567890123456789/);
});

test('provider agents must declare contextWindow, charsPerToken, and timeoutMs', () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'council-openai-provider-'));
  mkdirSync(path.join(fixtureDir, 'docs'));
  writeFileSync(path.join(fixtureDir, 'docs', 'brief.txt'), 'brief', 'utf8');
  writeFileSync(
    path.join(fixtureDir, 'provider.json'),
    JSON.stringify(
      {
        server: {
          host: '127.0.0.1',
          port: 8787,
          apiKeys: [],
        },
        virtualModels: {
          'oracle-docs': {
            synthesizerAgentId: 'editor',
            agents: [
              {
                id: 'editor',
                name: 'Editor',
                summary: 'Synthesizer',
                systemPrompt: 'Use documents when they help.',
                documents: [
                  {
                    path: 'docs/brief.txt',
                  },
                ],
                engine: {
                  provider: 'http://example.test',
                  model: 'stub-model',
                  timeoutMs: 1000,
                },
              },
            ],
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  assert.throws(
    () => loadConfig(path.join(fixtureDir, 'provider.json')),
    /contextWindow/
  );
});

test('provider virtual models must declare synthesizerAgentId', () => {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'council-openai-provider-'));
  writeFileSync(
    path.join(fixtureDir, 'provider.json'),
    JSON.stringify(
      {
        virtualModels: {
          'oracle-docs': {
            agents: [
              {
                id: 'editor',
                name: 'Editor',
                summary: 'Synthesizer',
                systemPrompt: 'Use documents when they help.',
                engine: {
                  provider: 'http://example.test',
                  model: 'stub-model',
                  contextWindow: 1024,
                  charsPerToken: 4,
                  timeoutMs: 1000,
                },
              },
            ],
          },
        },
      },
      null,
      2
    ),
    'utf8'
  );

  assert.throws(
    () => loadConfig(path.join(fixtureDir, 'provider.json')),
    /synthesizerAgentId/
  );
});

test("provider returns 'It's dizzy.' when fixed inputs exhaust the oracle budget", async () => {
  const app = new CouncilOpenAIProviderApp({
    server: {
      host: '127.0.0.1',
      port: 0,
      apiKeys: [],
    },
    debug: {
      enabled: true,
      traceRetention: 10,
    },
    limits: {
      requestBodyBytes: 1_000_000,
    },
    fallbacks: {
      agentContextExhaustedMessage: "It's dizzy.",
    },
    virtualModels: {
      'oracle-dizzy': {
        id: 'oracle-dizzy',
        description: 'Too much fixed input',
        synthesizerAgentId: 'editor',
        runtime: {
          maxRounds: 1,
          maxAgentReplies: 1,
        },
        agents: [
          {
            id: 'editor',
            name: 'Editor',
            summary: 'Synthesizer',
            systemPrompt: 'system '.repeat(40),
            engine: {
              provider: 'http://example.test',
              model: 'stub-model',
              contextWindow: 64,
              charsPerToken: 1,
              timeoutMs: 1000,
            },
          },
        ],
      },
    },
  });

  app.modelRuntimes.get('oracle-dizzy').engines[
    'oracle-dizzy:editor'
  ].sendRequest = async () => {
    throw new Error('request should not be called');
  };

  const response = await app.handleChatCompletions({
    model: 'oracle-dizzy',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  });

  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.equal(response.choices[0].message.content, "It's dizzy.");
  assert.equal(
    app.recentTraces[0].council.errors[0].error.code,
    'agent_context_exhausted'
  );
  assert.equal(app.getDebugStatus().virtualModels[0].stats.degradedCount, 1);
});
