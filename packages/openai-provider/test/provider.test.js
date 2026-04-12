import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CouncilOpenAIProviderApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';

function createResult() {
  return {
    turnId: 'turn-1',
    mode: 'oracle',
    nextMode: 'oracle',
    publicMessages: [
      {
        id: 'public-1',
        turnId: 'turn-1',
        author: { type: 'oracle', id: 'oracle', name: 'Oracle' },
        visibility: 'public',
        content: 'final oracle answer',
        timestamp: new Date().toISOString(),
      },
    ],
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
        async post() {
          return createResult();
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

      if ((input.tools?.length ?? 0) > 0 && !prompt.includes('[tool')) {
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

      if (prompt.includes('[tool') && prompt.includes('sunny')) {
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
    },
    virtualModels: {
      'oracle-test': {
        id: 'oracle-test',
        description: 'Test model',
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
            },
          },
        ],
      },
    },
  });

  app.modelRuntimes.set('oracle-test', {
    id: 'oracle-test',
    description: 'Test model',
    runtime: {
      maxRounds: 1,
      maxAgentReplies: 2,
    },
    documentsByAgent: {},
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

  assert.equal(app.recentTraces.length, 1);
  assert.equal(app.recentTraces[0].council.publicMessages[0].content, 'final oracle answer');
  assert.equal(app.recentTraces[0].council.privateMessages.length, 2);
  assert.match(app.recentTraces[0].transcript, /Conversation transcript:/);
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
    },
    virtualModels: {
      'oracle-tools': {
        id: 'oracle-tools',
        description: 'Tool model',
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
            },
          },
        ],
      },
    },
  });

  app.modelRuntimes.set('oracle-tools', {
    id: 'oracle-tools',
    description: 'Tool model',
    runtime: {
      maxRounds: 1,
      maxAgentReplies: 2,
    },
    documentsByAgent: {},
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
  assert.equal(runtime.documentsByAgent.editor[0].path, 'docs/brief.txt');
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
