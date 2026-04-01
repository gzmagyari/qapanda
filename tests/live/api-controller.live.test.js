const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockServer } = require('../unit/llm-mock-server');
const { createApiTestDir, createApiTestManifest, createApiTestRenderer } = require('../helpers/api-test-utils');
const { runApiControllerTurn } = require('../../src/api-controller');

let mock, tmp;
before(async () => { mock = await createMockServer(); tmp = createApiTestDir(); });
after(async () => { if (mock) await mock.close(); if (tmp) tmp.cleanup(); });

function run(handler) {
  mock.setHandler(handler);
  const manifest = createApiTestManifest(mock.url, tmp.dir);
  const renderer = createApiTestRenderer();
  const promptFile = path.join(tmp.dir, `prompt-${Date.now()}.txt`);
  return runApiControllerTurn({
    manifest,
    request: { id: 'r1', message: 'test the app', loopIndex: 0, workerResults: [], loops: [] },
    loop: { controller: { promptFile } },
    renderer,
    emitEvent: () => {},
  });
}

describe('API Controller Live — delegate decision', () => {
  it('returns valid delegate decision', async () => {
    const decision = JSON.stringify({
      action: 'delegate', agent_id: 'QA-Browser',
      claude_message: 'Test the login page thoroughly.',
      controller_messages: ['Starting QA on login.'],
      stop_reason: null, progress_updates: ['Testing login'],
    });
    const result = await run(() => ({ text: decision }));
    assert.equal(result.decision.action, 'delegate');
    assert.equal(result.decision.agent_id, 'QA-Browser');
    assert.ok(result.decision.claude_message.includes('login'));
  });
});

describe('API Controller Live — stop decision', () => {
  it('returns valid stop decision', async () => {
    const decision = JSON.stringify({
      action: 'stop', agent_id: null, claude_message: null,
      controller_messages: ['All tests passed.'],
      stop_reason: 'QA complete, no bugs found.',
      progress_updates: [],
    });
    const result = await run(() => ({ text: decision }));
    assert.equal(result.decision.action, 'stop');
    assert.ok(result.decision.stop_reason.includes('complete'));
  });
});

describe('API Controller Live — fenced JSON', () => {
  it('extracts JSON from markdown code block', async () => {
    const json = JSON.stringify({
      action: 'delegate', agent_id: 'dev',
      claude_message: 'Fix the CSS bug.',
      controller_messages: ['Fixing CSS.'],
      stop_reason: null, progress_updates: [],
    });
    const result = await run(() => ({ text: '```json\n' + json + '\n```' }));
    assert.equal(result.decision.action, 'delegate');
    assert.equal(result.decision.agent_id, 'dev');
  });
});

describe('API Controller Live — invalid response', () => {
  it('throws on non-JSON response', async () => {
    await assert.rejects(
      () => run(() => ({ text: 'I think we should test more things.' })),
      (err) => err.message.includes('no JSON')
    );
  });

  it('throws on invalid schema', async () => {
    await assert.rejects(
      () => run(() => ({ text: '{"action":"unknown","foo":"bar"}' })),
      (err) => err.message.length > 0
    );
  });
});
