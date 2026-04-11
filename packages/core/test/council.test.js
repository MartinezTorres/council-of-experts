import assert from 'node:assert/strict';
import test from 'node:test';
import { createCouncilModule } from '../dist/index.js';

function createAgent(id, engineId = 'engine') {
  return {
    id,
    name: id.toUpperCase(),
    engine: {
      id: engineId,
      model: 'test-model',
      contextWindow: 1024,
    },
    modelName: 'test-model',
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
