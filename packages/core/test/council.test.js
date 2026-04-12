import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCouncilModule,
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
  const originalFetch = global.fetch;
  let requestBody;
  let output;

  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: 'ok',
              },
            },
          ],
        };
      },
    };
  };

  try {
    const engine = new OpenAIChatCompletionsEngine(1000);
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
          contextWindow: 100,
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
    assert.equal(output.metadata.tokenEstimate.contextWindow, 100);
    assert.ok(output.metadata.tokenEstimate.promptTokens > 0);
    assert.ok(output.metadata.tokenEstimate.completionTokens > 0);
  } finally {
    global.fetch = originalFetch;
  }
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
    },
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
    },
    metadata: { nested: { ok: true } },
  });
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
