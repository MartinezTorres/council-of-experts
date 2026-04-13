import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCouncilModule,
  DEFAULT_COUNCIL_PROMPTS,
  OpenAIChatCompletionsEngine,
} from '../dist/index.js';

function createAgent(id, engineId = 'engine') {
  return {
    id,
    name: id.toUpperCase(),
    engine: {
      id: engineId,
      model: 'test-model',
      contextWindow: 1024,
    },
    summary: `${id} summary`,
    systemPrompt: `${id} prompt`,
  };
}

function createEvent(content) {
  return {
    actor: {
      type: 'user',
      id: 'user',
      name: 'User',
    },
    content,
  };
}

function summarize(messages) {
  return messages.map((message) => `${message.visibility}:${message.content}`);
}

function createTransportResponse({
  status = 200,
  statusText = 'OK',
  headers = {},
  body,
}) {
  const normalizedHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: normalizedHeaders,
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test('post, replay, and stream converge on the same message order', async () => {
  const engine = {
    async generate(input) {
      const content = input.event.content.startsWith('Based on the council')
        ? `public-${input.agent.id}`
        : `private-${input.agent.id}`;

      return { content };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('a'), createAgent('b')],
    engines: { engine },
  });

  const event = createEvent('review this repository');

  const liveCouncil = await module.openCouncil({
    councilId: 'live',
    initialMode: 'open',
  });
  const postResult = await liveCouncil.post(event, { mode: 'council' });
  const liveState = summarize(await liveCouncil.getMessages({ visibility: 'all' }));

  const replayCouncil = await module.openCouncil({
    councilId: 'replay',
    initialMode: 'open',
  });
  const replayEntries = postResult.records.map((record) => ({
    type: 'council.record',
    record,
  }));
  await replayCouncil.replay(replayEntries);
  const replayState = summarize(
    await replayCouncil.getMessages({ visibility: 'all' })
  );

  const streamCouncil = await module.openCouncil({
    councilId: 'stream',
    initialMode: 'open',
  });
  for await (const _event of streamCouncil.stream(event, { mode: 'council' })) {
    // Drain the stream to completion.
  }
  const streamState = summarize(
    await streamCouncil.getMessages({ visibility: 'all' })
  );

  assert.deepEqual(liveState, replayState);
  assert.deepEqual(liveState, streamState);
  assert.deepEqual(liveState, [
    'private:private-a',
    'private:private-b',
    'public:public-a',
    'public:public-b',
  ]);
});

test('getMessages returns immutable snapshots', async () => {
  const engine = {
    async generate(input) {
      return {
        content: `reply-${input.agent.id}`,
        metadata: { nested: { ok: true } },
      };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('a')],
    engines: { engine },
  });
  const council = await module.openCouncil({
    councilId: 'immutability',
    initialMode: 'open',
  });

  await council.post(createEvent('hello'));

  const firstRead = await council.getMessages();
  firstRead.push({
    id: 'fake',
    turnId: 'fake',
    author: { type: 'agent', id: 'fake', name: 'Injected' },
    visibility: 'public',
    content: 'injected',
    timestamp: new Date().toISOString(),
  });
  firstRead[0].content = 'tampered';
  firstRead[0].author.name = 'Tampered';
  firstRead[0].metadata.nested.ok = false;

  const secondRead = await council.getMessages();

  assert.equal(secondRead.length, 1);
  assert.equal(secondRead[0].content, 'reply-a');
  assert.equal(secondRead[0].author.name, 'A');
  assert.deepEqual(secondRead[0].metadata, { nested: { ok: true } });
});

test('OpenAIChatCompletionsEngine includes the full relevant history', async () => {
  let requestBody;
  let output;

  const engine = new OpenAIChatCompletionsEngine(1000);
  engine.sendRequest = async ({ body }) => {
    requestBody = JSON.parse(body);
    return createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });
  };

  const history = Array.from({ length: 12 }, (_, index) => ({
    id: `m-${index + 1}`,
    turnId: `t-${index + 1}`,
    author: { type: 'agent', id: 'a', name: `Agent ${index + 1}` },
    visibility: 'public',
    content: `message-${index + 1}`,
    timestamp: new Date().toISOString(),
  }));

  output = await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 4096,
        charsPerToken: 5,
      },
      summary: 'summary',
      systemPrompt: 'system prompt',
    },
    mode: 'open',
    event: createEvent('current message'),
    history,
  });

  assert.equal(requestBody.messages.length, 14);
  assert.equal(requestBody.messages[1].content, 'Agent 1: message-1');
  assert.equal(requestBody.messages[12].content, 'Agent 12: message-12');
  assert.equal(requestBody.messages[13].content, 'User: current message');
  assert.equal(output.metadata.tokenEstimate.strategy, 'chars_per_token');
  assert.equal(output.metadata.tokenEstimate.charsPerToken, 5);
  assert.equal(output.metadata.tokenEstimate.contextWindow, 4096);
  assert.ok(output.metadata.tokenEstimate.promptTokens > 0);
  assert.ok(output.metadata.tokenEstimate.completionTokens > 0);
  assert.equal(output.metadata.tokenEstimate.promptPack.strategy, 'full_history');
});

test('OpenAIChatCompletionsEngine packs older history into a summary under budget pressure', async () => {
  let requestBody;
  let output;

  const engine = new OpenAIChatCompletionsEngine(1000);
  engine.sendRequest = async ({ body }) => {
    requestBody = JSON.parse(body);
    return createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });
  };

  const history = Array.from({ length: 8 }, (_, index) => ({
    id: `m-${index + 1}`,
    turnId: `t-${index + 1}`,
    author: { type: 'agent', id: 'a', name: `Agent ${index + 1}` },
    visibility: 'public',
    content:
      `message-${index + 1} ` +
      'detail '.repeat(20) +
      `conclusion-${index + 1}`,
    timestamp: new Date().toISOString(),
  }));

  output = await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 220,
        charsPerToken: 5,
      },
      summary: 'summary',
      systemPrompt: 'system prompt',
    },
    mode: 'open',
    event: createEvent('current message'),
    history,
  });

  assert.equal(
    requestBody.messages.filter((message) => message.role === 'system').length,
    1
  );
  assert.match(requestBody.messages[0].content, /Earlier conversation summary/);
  assert.equal(requestBody.messages.at(-1).content, 'User: current message');
  assert.equal(
    output.metadata.tokenEstimate.promptPack.strategy,
    'recent_plus_summary'
  );
  assert.equal(output.metadata.tokenEstimate.promptPack.promptBudgetTokens, 110);
  assert.equal(
    output.metadata.tokenEstimate.promptPack.reservedForResponseAndToolsTokens,
    110
  );
  assert.equal(output.metadata.tokenEstimate.promptPack.promptBudgetRatio, 0.5);
  assert.ok(output.metadata.tokenEstimate.promptPack.rawHistoryMessages > 0);
  assert.ok(output.metadata.tokenEstimate.promptPack.summarizedHistoryMessages > 0);
  assert.ok(output.metadata.tokenEstimate.remainingContextTokens >= 0);
});

test('OpenAIChatCompletionsEngine packs explicit promptMessages and folds external system messages into one leading system message', async () => {
  let requestBody;
  let output;

  const engine = new OpenAIChatCompletionsEngine(1000);
  engine.sendRequest = async ({ body }) => {
    requestBody = JSON.parse(body);
    return createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });
  };

  output = await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 220,
        charsPerToken: 4,
      },
      summary: 'summary',
      systemPrompt: 'system prompt',
    },
    mode: 'oracle',
    event: {
      ...createEvent('Produce the next assistant reply.'),
      promptMessages: [
        {
          role: 'system',
          content: 'client system instruction',
        },
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
          content: 'Second question detail '.repeat(12),
        },
      ],
    },
    history: [],
  });

  assert.equal(
    requestBody.messages.filter((message) => message.role === 'system').length,
    1
  );
  assert.match(requestBody.messages[0].content, /system prompt/);
  assert.match(requestBody.messages[0].content, /client system instruction/);
  assert.equal(requestBody.messages.at(-1).content, 'Produce the next assistant reply.');
  assert.equal(output.metadata.tokenEstimate.promptPack.historySourceMessages, 3);
  assert.ok(
    ['full_history', 'recent_plus_summary', 'summary_only'].includes(
      output.metadata.tokenEstimate.promptPack.strategy
    )
  );
});

test('OpenAIChatCompletionsEngine requires explicit sizing for prompt packing', async () => {
  const engine = new OpenAIChatCompletionsEngine(1000);

  await assert.rejects(
    () =>
      engine.generate({
        councilId: 'c',
        turnId: 't',
        agent: {
          id: 'a',
          name: 'Agent A',
          engine: {
            id: 'engine',
            provider: 'http://example.test',
            model: 'test-model',
          },
          summary: 'summary',
          systemPrompt: 'system prompt',
        },
        mode: 'open',
        event: createEvent('current message'),
        history: [],
      }),
    /contextWindow/
  );

  await assert.rejects(
    () =>
      engine.generate({
        councilId: 'c',
        turnId: 't',
        agent: {
          id: 'a',
          name: 'Agent A',
          engine: {
            id: 'engine',
            provider: 'http://example.test',
            model: 'test-model',
            contextWindow: 1024,
          },
          summary: 'summary',
          systemPrompt: 'system prompt',
        },
        mode: 'open',
        event: createEvent('current message'),
        history: [],
      }),
    /charsPerToken/
  );
});

test('OpenAIChatCompletionsEngine retries 429 using Retry-After', async () => {
  const engine = new OpenAIChatCompletionsEngine(5000);
  const waits = [];
  let attempts = 0;

  engine.getStartDelayMs = () => 0;
  engine.waitWithAbort = async (ms) => {
    waits.push(ms);
  };
  engine.sendRequest = async () => {
    attempts += 1;
    if (attempts === 1) {
      return createTransportResponse({
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '2' },
        body: 'retry later',
      });
    }

    return createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });
  };

  const output = await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 1024,
        charsPerToken: 4,
      },
      summary: 'summary',
      systemPrompt: 'system prompt',
    },
    mode: 'open',
    event: createEvent('current message'),
    history: [],
  });

  assert.equal(output.content, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [0, 2000]);
  assert.equal(output.metadata.requestDebug.startDelayMs, 0);
  assert.equal(output.metadata.requestDebug.retryCount, 1);
  assert.equal(output.metadata.requestDebug.totalRetryDelayMs, 2000);
  assert.equal(output.metadata.requestDebug.attempts, 2);
  assert.equal(output.metadata.requestDebug.finalOutcome, 'success');
});

test('OpenAIChatCompletionsEngine retries 503 with constant delay and jitter', async () => {
  const engine = new OpenAIChatCompletionsEngine(5000);
  const waits = [];
  let attempts = 0;

  engine.getStartDelayMs = () => 0;
  engine.getRetryDelayMs = (retryAttempt, retryAfterHeader) => {
    assert.ok(retryAttempt >= 1);
    assert.equal(retryAfterHeader, null);
    return 1500;
  };
  engine.waitWithAbort = async (ms) => {
    waits.push(ms);
  };
  engine.sendRequest = async () => {
    attempts += 1;
    if (attempts <= 2) {
      return createTransportResponse({
        status: 503,
        statusText: 'Service Unavailable',
        body: 'retry later',
      });
    }

    return createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });
  };

  const output = await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 1024,
        charsPerToken: 4,
      },
      summary: 'summary',
      systemPrompt: 'system prompt',
    },
    mode: 'open',
    event: createEvent('current message'),
    history: [],
  });

  assert.equal(output.content, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [0, 1500, 1500]);
  assert.equal(output.metadata.requestDebug.retryCount, 2);
  assert.equal(output.metadata.requestDebug.totalRetryDelayMs, 3000);
  assert.equal(output.metadata.requestDebug.attempts, 3);
  assert.equal(
    output.metadata.requestDebug.attemptDetails[0].outcome,
    'retry'
  );
});

test('OpenAIChatCompletionsEngine surfaces transport cause details', async () => {
  const engine = new OpenAIChatCompletionsEngine(5000);
  const cause = new Error('Headers Timeout Error');
  cause.code = 'UND_ERR_HEADERS_TIMEOUT';

  engine.getStartDelayMs = () => 0;
  engine.sendRequest = async () => {
    throw new TypeError('fetch failed', { cause });
  };

  await assert.rejects(
    () =>
      engine.generate({
        councilId: 'c',
        turnId: 't',
        agent: {
          id: 'a',
          name: 'Agent A',
          engine: {
            id: 'engine',
            provider: 'http://example.test',
            model: 'test-model',
            contextWindow: 1024,
            charsPerToken: 4,
          },
          summary: 'summary',
          systemPrompt: 'system prompt',
        },
        mode: 'open',
        event: createEvent('current message'),
        history: [],
      }),
    /UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error/
  );
});

test('OpenAIChatCompletionsEngine exposes explicit prompt packing policy', async () => {
  let output;

  const engine = new OpenAIChatCompletionsEngine(1000);
  engine.sendRequest = async () =>
    createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });

  output = await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 200,
        charsPerToken: 4,
        promptBudgetRatio: 0.6,
        promptSummaryPolicy: {
          maxMessagesPerGroup: 2,
          minGroupSnippetChars: 30,
          minMessageSnippetChars: 12,
          shrinkTargetRatio: 0.8,
        },
      },
      summary: 'summary',
      systemPrompt: 'system prompt',
    },
    mode: 'open',
    event: createEvent('current message'),
    history: [],
  });

  assert.equal(output.metadata.tokenEstimate.promptPack.promptBudgetRatio, 0.6);
  assert.equal(output.metadata.tokenEstimate.promptPack.promptBudgetTokens, 120);
  assert.equal(
    output.metadata.tokenEstimate.promptPack.reservedForResponseAndToolsTokens,
    80
  );
  assert.deepEqual(output.metadata.tokenEstimate.promptPack.promptSummaryPolicy, {
    maxMessagesPerGroup: 2,
    minGroupSnippetChars: 30,
    minMessageSnippetChars: 12,
    shrinkTargetRatio: 0.8,
  });
});

test('OpenAIChatCompletionsEngine uses explicit module prompt addenda when provided', async () => {
  let requestBody;

  const engine = new OpenAIChatCompletionsEngine(1000);
  engine.sendRequest = async ({ body }) => {
    requestBody = JSON.parse(body);
    return createTransportResponse({
      body: {
        choices: [
          {
            message: {
              content: 'ok',
            },
          },
        ],
      },
    });
  };

  await engine.generate({
    councilId: 'c',
    turnId: 't',
    agent: {
      id: 'a',
      name: 'Agent A',
      engine: {
        id: 'engine',
        provider: 'http://example.test',
        model: 'test-model',
        contextWindow: 256,
        charsPerToken: 4,
      },
      summary: 'summary',
      systemPrompt: 'base system prompt',
    },
    mode: 'council',
    event: createEvent('current message'),
    history: [],
    promptConfig: {
      ...DEFAULT_COUNCIL_PROMPTS,
      councilModeSystemAddendum: 'Custom council addendum.',
    },
  });

  assert.match(requestBody.messages[0].content, /base system prompt/);
  assert.match(requestBody.messages[0].content, /Custom council addendum\./);
  assert.doesNotMatch(
    requestBody.messages[0].content,
    /Deliberate carefully with other agents/
  );
});

test('post surfaces non-stream execution failures in turn errors and records', async () => {
  const okEngine = {
    async generate() {
      return { content: 'ok' };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('working'), createAgent('broken', 'missing-engine')],
    engines: { engine: okEngine },
  });
  const council = await module.openCouncil({
    councilId: 'errors',
    initialMode: 'open',
  });

  const result = await council.post(createEvent('run'));
  const errorRecords = result.records.filter((record) => record.type === 'error');

  assert.equal(result.publicMessages.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].agentId, 'broken');
  assert.match(result.errors[0].error.message, /broken/);
  assert.equal(errorRecords.length, 1);
  assert.equal(errorRecords[0].agentId, 'broken');
});

test('post surfaces agent_context_exhausted for oversized fixed inputs', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  try {
    const module = createCouncilModule({
      agents: [
        {
          id: 'a',
          name: 'A',
          engine: {
            id: 'engine',
            provider: 'http://example.test',
            model: 'test-model',
            contextWindow: 256,
            charsPerToken: 1,
          },
          summary: 'summary',
          systemPrompt: 'system '.repeat(40),
        },
      ],
      engines: {
        engine: new OpenAIChatCompletionsEngine(1000),
      },
    });
    const council = await module.openCouncil({
      councilId: 'context-exhausted',
      initialMode: 'open',
    });

    const result = await council.post(createEvent('hello'));

    assert.equal(fetchCalled, false);
    assert.equal(result.publicMessages.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].error.code, 'agent_context_exhausted');
    assert.equal(
      result.errors[0].error.data.reason,
      'uncontrolled_fixed_inputs_exceed_prompt_budget'
    );
    assert.equal(result.records.filter((record) => record.type === 'error').length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('oversized chat content remains a normal execution failure', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  try {
    const module = createCouncilModule({
      agents: [
        {
          id: 'a',
          name: 'A',
          engine: {
            id: 'engine',
            provider: 'http://example.test',
            model: 'test-model',
            contextWindow: 256,
            charsPerToken: 1,
          },
          summary: 'summary',
          systemPrompt: 'small',
        },
      ],
      engines: {
        engine: new OpenAIChatCompletionsEngine(1000),
      },
    });
    const council = await module.openCouncil({
      councilId: 'oversized-chat',
      initialMode: 'open',
    });

    const result = await council.post(createEvent('chat '.repeat(80)));

    assert.equal(fetchCalled, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].error.code, 'agent_execution_failed');
  } finally {
    global.fetch = originalFetch;
  }
});

test('post surfaces requestDebug for transport failures', async () => {
  const engine = new OpenAIChatCompletionsEngine(1000);
  const cause = new Error('Headers Timeout Error');
  cause.code = 'UND_ERR_HEADERS_TIMEOUT';
  engine.getStartDelayMs = () => 0;
  engine.sendRequest = async () => {
    throw new TypeError('fetch failed', { cause });
  };

  const module = createCouncilModule({
    agents: [
      {
        id: 'a',
        name: 'A',
        engine: {
          id: 'engine',
          provider: 'http://example.test',
          model: 'test-model',
          contextWindow: 1024,
          charsPerToken: 4,
        },
        summary: 'summary',
        systemPrompt: 'system prompt',
      },
    ],
    engines: {
      engine,
    },
  });
  const council = await module.openCouncil({
    councilId: 'request-debug',
    initialMode: 'open',
  });

  const result = await council.post(createEvent('hello'));

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].error.code, 'agent_execution_failed');
  assert.match(
    result.errors[0].error.message,
    /fetch failed: UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error/
  );
  assert.equal(result.errors[0].error.data.requestDebug.startDelayMs, 0);
  assert.equal(result.errors[0].error.data.requestDebug.attempts, 1);
  assert.equal(
    result.errors[0].error.data.requestDebug.attemptDetails[0].outcome,
    'transport_error'
  );
});

test('module and council expose resolved runtime config snapshots', async () => {
  const module = createCouncilModule({
    agents: [createAgent('a')],
    engines: {
      engine: {
        async generate() {
          return { content: 'ok' };
        },
      },
    },
    runtime: {
      initialMode: 'council',
      maxRounds: 5,
      maxAgentReplies: 1,
    },
  });

  assert.deepEqual(module.getConfig(), {
    runtime: {
      initialMode: 'council',
      maxRounds: 5,
      maxAgentReplies: 1,
      agentSelectionStrategy: 'all_in_order',
      oracleSpeakerStrategy: 'first_active',
      oracleSpeakerAgentId: undefined,
    },
    prompts: DEFAULT_COUNCIL_PROMPTS,
  });

  const council = await module.openCouncil({
    councilId: 'configured',
    metadata: { nested: { ok: true } },
  });

  const config = council.getConfig();
  config.metadata.nested.ok = false;

  assert.deepEqual(council.getConfig(), {
    councilId: 'configured',
    initialMode: 'council',
    runtime: {
      initialMode: 'council',
      maxRounds: 5,
      maxAgentReplies: 1,
      agentSelectionStrategy: 'all_in_order',
      oracleSpeakerStrategy: 'first_active',
      oracleSpeakerAgentId: undefined,
    },
    prompts: DEFAULT_COUNCIL_PROMPTS,
    metadata: { nested: { ok: true } },
  });
});

test('oracle mode can explicitly select the public oracle speaker', async () => {
  const engine = {
    async generate(input) {
      if (input.event.content.includes('collective wisdom')) {
        return { content: `public-${input.agent.id}` };
      }

      return { content: `private-${input.agent.id}` };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('a'), createAgent('b')],
    engines: { engine },
    runtime: {
      oracleSpeakerStrategy: 'by_id',
      oracleSpeakerAgentId: 'b',
    },
  });
  const council = await module.openCouncil({
    councilId: 'oracle-speaker-by-id',
    initialMode: 'oracle',
  });

  const result = await council.post(createEvent('deliberate'), {
    mode: 'oracle',
  });

  assert.equal(result.privateMessages.length, 2);
  assert.equal(result.publicMessages.length, 1);
  assert.equal(result.publicMessages[0].content, 'public-b');
});

test('module prompt templates override council and oracle synthesis prompts', async () => {
  const engine = {
    async generate(input) {
      if (input.event.content.includes('CUSTOM COUNCIL SYNTHESIS')) {
        return { content: `council-public-${input.agent.id}` };
      }

      if (input.event.content.includes('CUSTOM ORACLE SYNTHESIS')) {
        return { content: `oracle-public-${input.agent.id}` };
      }

      return { content: `private-${input.agent.id}` };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('a'), createAgent('b')],
    engines: { engine },
    prompts: {
      councilSynthesisTemplate:
        'CUSTOM COUNCIL SYNTHESIS\n\nPrivate thoughts:\n{{privateThoughts}}',
      oracleSynthesisTemplate:
        'CUSTOM ORACLE SYNTHESIS\n\nPrivate thoughts:\n{{privateThoughts}}',
    },
    runtime: {
      oracleSpeakerStrategy: 'by_id',
      oracleSpeakerAgentId: 'b',
    },
  });

  const council = await module.openCouncil({
    councilId: 'custom-prompts',
    initialMode: 'open',
  });

  const councilResult = await council.post(createEvent('deliberate'), {
    mode: 'council',
  });
  const oracleResult = await council.post(createEvent('deliberate again'), {
    mode: 'oracle',
  });

  assert.deepEqual(
    councilResult.publicMessages.map((message) => message.content),
    ['council-public-a', 'council-public-b']
  );
  assert.equal(oracleResult.publicMessages.length, 1);
  assert.equal(oracleResult.publicMessages[0].content, 'oracle-public-b');
});

test('runtime.maxAgentReplies becomes the default agent selection limit', async () => {
  const engine = {
    async generate(input) {
      return { content: `reply-${input.agent.id}` };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('a'), createAgent('b')],
    engines: { engine },
    runtime: { maxAgentReplies: 1 },
  });
  const council = await module.openCouncil({
    councilId: 'agent-limit',
  });

  const defaultResult = await council.post(createEvent('hello'));
  const overrideResult = await council.post(createEvent('hello again'), {
    maxAgentReplies: 2,
  });

  assert.equal(defaultResult.publicMessages.length, 1);
  assert.equal(defaultResult.publicMessages[0].author.id, 'a');
  assert.equal(overrideResult.publicMessages.length, 2);
});

test('runtime.maxRounds becomes the default tool round limit', async () => {
  const engine = {
    async generate(input) {
      if ((input.toolResults?.length ?? 0) >= 2) {
        return { content: 'done' };
      }

      return {
        content: '',
        toolCalls: [{ name: 'echo', args: { value: input.toolResults?.length ?? 0 } }],
      };
    },
  };

  const module = createCouncilModule({
    agents: [{ ...createAgent('a'), tools: ['echo'] }],
    engines: { engine },
    toolHost: {
      async execute(call) {
        return {
          ok: true,
          data: call.args,
        };
      },
    },
    runtime: { maxRounds: 1 },
  });
  const council = await module.openCouncil({
    councilId: 'tool-limit',
  });

  const limitedResult = await council.post(createEvent('loop once'));
  const overriddenResult = await council.post(createEvent('loop twice'), {
    maxRounds: 2,
  });

  assert.equal(limitedResult.publicMessages.length, 0);
  assert.equal(limitedResult.errors.length, 1);
  assert.equal(limitedResult.errors[0].error.code, 'tool_round_limit');
  assert.equal(overriddenResult.publicMessages.length, 1);
  assert.equal(overriddenResult.publicMessages[0].content, 'done');
});

test('oracle mode can skip the public oracle synthesis message', async () => {
  const engine = {
    async generate(input) {
      if (input.event.content.includes('collective wisdom')) {
        return { content: 'public oracle answer' };
      }

      return { content: `private-${input.agent.id}` };
    },
  };

  const module = createCouncilModule({
    agents: [createAgent('a'), createAgent('b')],
    engines: { engine },
  });
  const council = await module.openCouncil({
    councilId: 'oracle-private-only',
    initialMode: 'oracle',
  });

  const result = await council.post(createEvent('deliberate'), {
    mode: 'oracle',
    emitPublicOracle: false,
  });

  assert.equal(result.privateMessages.length, 2);
  assert.equal(result.publicMessages.length, 0);
  assert.equal(
    result.records.filter((record) => record.type === 'message.emitted').length,
    2
  );
});
