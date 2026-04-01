const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMockServer } = require('./llm-mock-server');

let mock;
let tmpDir;

before(async () => {
  mock = await createMockServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-apic-test-'));
  // Create minimal state files the controller prompt builder expects
  fs.mkdirSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run'), { recursive: true });
});
after(async () => {
  if (mock) await mock.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeManifest(handler) {
  if (handler) mock.setHandler(handler);
  return {
    runId: 'test-run',
    repoRoot: tmpDir,
    stateRoot: path.join(tmpDir, '.qpanda'),
    runDir: path.join(tmpDir, '.qpanda', 'runs', 'test-run'),
    controller: {
      cli: 'api',
      model: null,
      sessionId: null,
      lastSeenChatLine: 0,
      apiConfig: {
        provider: 'custom',
        apiKey: 'test',
        baseURL: mock.url + '/v1',
        model: 'test-model',
      },
    },
    apiConfig: {
      provider: 'custom',
      apiKey: 'test',
      baseURL: mock.url + '/v1',
      model: 'test-model',
    },
    worker: { cli: 'api', bin: 'api' },
    agents: {
      dev: { name: 'Developer', description: 'Dev agent' },
      'QA-Browser': { name: 'QA Engineer', description: 'QA agent' },
    },
    settings: {},
    controllerSystemPrompt: null,
    controllerMcpServers: {},
    workerMcpServers: {},
    files: { events: path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'events.jsonl') },
    counters: { request: 1, loop: 1, controllerTurn: 0, workerTurn: 0 },
    requests: [],
  };
}

function makeRenderer() {
  const output = [];
  return {
    output,
    controller: (text) => output.push({ type: 'controller', text }),
    controllerEvent: () => {},
    streamMarkdown: () => {},
    flushStream: () => {},
  };
}

describe('API Controller — valid delegate decision', () => {
  it('returns a delegate decision', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const decision = JSON.stringify({
      action: 'delegate',
      agent_id: 'QA-Browser',
      claude_message: 'Please test the login page.',
      controller_messages: ['Starting QA test on login page.'],
      stop_reason: null,
      progress_updates: ['Testing login'],
    });
    const manifest = makeManifest(() => ({ text: decision }));
    const renderer = makeRenderer();

    const result = await runApiControllerTurn({
      manifest,
      request: { id: 'r1', message: 'test login', loopIndex: 0, workerResults: [], loops: [] },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(result.decision.action, 'delegate');
    assert.equal(result.decision.agent_id, 'QA-Browser');
    assert.equal(result.decision.claude_message, 'Please test the login page.');
  });
});

describe('API Controller — valid stop decision', () => {
  it('returns a stop decision', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const decision = JSON.stringify({
      action: 'stop',
      agent_id: null,
      claude_message: null,
      controller_messages: ['All done.'],
      stop_reason: 'Testing complete, all passed.',
      progress_updates: [],
    });
    const manifest = makeManifest(() => ({ text: decision }));
    const renderer = makeRenderer();

    const result = await runApiControllerTurn({
      manifest,
      request: { id: 'r1', message: 'test', loopIndex: 0, workerResults: [], loops: [] },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt2.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(result.decision.action, 'stop');
    assert.ok(result.decision.stop_reason.includes('complete'));
  });
});

describe('API Controller — JSON in fenced code block', () => {
  it('extracts JSON from markdown fences', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const fenced = '```json\n' + JSON.stringify({
      action: 'delegate',
      agent_id: 'dev',
      claude_message: 'Fix the bug.',
      controller_messages: ['Fixing bug.'],
      stop_reason: null,
      progress_updates: [],
    }) + '\n```';
    const manifest = makeManifest(() => ({ text: fenced }));
    const renderer = makeRenderer();

    const result = await runApiControllerTurn({
      manifest,
      request: { id: 'r1', message: 'fix', loopIndex: 0, workerResults: [], loops: [] },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt3.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(result.decision.action, 'delegate');
    assert.equal(result.decision.agent_id, 'dev');
  });
});

describe('API Controller — invalid response', () => {
  it('throws on non-JSON response', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const manifest = makeManifest(() => ({ text: 'I am not sure what to do next.' }));
    const renderer = makeRenderer();

    await assert.rejects(
      () => runApiControllerTurn({
        manifest,
        request: { id: 'r1', message: 'test', loopIndex: 0, workerResults: [], loops: [] },
        loop: { controller: { promptFile: path.join(tmpDir, 'prompt4.txt') } },
        renderer,
        emitEvent: () => {},
      }),
      (err) => err.message.includes('no JSON')
    );
  });
});
