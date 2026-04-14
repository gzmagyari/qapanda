const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMockServer } = require('./llm-mock-server');
const { createEmptyUsageSummary } = require('../../src/usage-summary');

let mock;
let tmpDir;

before(async () => {
  mock = await createMockServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-apic-test-'));
  fs.mkdirSync(path.join(tmpDir, '.qpanda', 'runs', 'test-run'), { recursive: true });
});
after(async () => {
  if (mock) await mock.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeManifest(handler) {
  if (handler) mock.setHandler(handler);
  const runDir = path.join(tmpDir, '.qpanda', 'runs', 'test-run');
  return {
    runId: 'test-run',
    repoRoot: tmpDir,
    stateRoot: path.join(tmpDir, '.qpanda'),
    runDir,
    controller: {
      cli: 'api',
      model: null,
      sessionId: null,
      lastSeenChatLine: 0,
      lastSeenTranscriptLine: 0,
      apiConfig: {
        provider: 'custom',
        apiKey: 'test',
        baseURL: mock.url + '/v1',
        model: 'test-model',
      },
      apiSystemPromptSnapshot: null,
    },
    apiConfig: {
      provider: 'custom',
      apiKey: 'test',
      baseURL: mock.url + '/v1',
      model: 'test-model',
    },
    worker: { cli: 'api', bin: 'api', hasStarted: false, sessionId: null },
    agents: {
      dev: { name: 'Developer', description: 'Dev agent' },
      'QA-Browser': { name: 'QA Engineer', description: 'QA agent' },
    },
    settings: {},
    controllerSystemPrompt: null,
    controllerMcpServers: {},
    workerMcpServers: {},
    files: {
      manifest: path.join(runDir, 'manifest.json'),
      events: path.join(runDir, 'events.jsonl'),
    },
    counters: { request: 1, loop: 1, controllerTurn: 0, workerTurn: 0 },
    requests: [],
    stopReason: null,
    selfTesting: false,
    usageSummary: createEmptyUsageSummary(),
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
    usageStats: (summary) => output.push({ type: 'usageStats', summary }),
  };
}

describe('API Controller - valid delegate decision', () => {
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
      request: { id: 'r1', userMessage: 'test login', startedAt: 'now', loops: [], latestWorkerResult: null },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(result.decision.action, 'delegate');
    assert.equal(result.decision.agent_id, 'QA-Browser');
    assert.equal(result.decision.claude_message, 'Please test the login page.');
  });
});

describe('API Controller - valid stop decision', () => {
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
      request: { id: 'r1', userMessage: 'test', startedAt: 'now', loops: [], latestWorkerResult: null },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt2.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(result.decision.action, 'stop');
    assert.ok(result.decision.stop_reason.includes('complete'));
  });
});

describe('API Controller - JSON in fenced code block', () => {
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
      request: { id: 'r1', userMessage: 'fix', startedAt: 'now', loops: [], latestWorkerResult: null },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt3.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(result.decision.action, 'delegate');
    assert.equal(result.decision.agent_id, 'dev');
  });
});

describe('API Controller - invalid response', () => {
  it('throws on non-JSON response', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const manifest = makeManifest(() => ({ text: 'I am not sure what to do next.' }));
    const renderer = makeRenderer();

    await assert.rejects(
      () => runApiControllerTurn({
        manifest,
        request: { id: 'r1', userMessage: 'test', startedAt: 'now', loops: [], latestWorkerResult: null },
        loop: { controller: { promptFile: path.join(tmpDir, 'prompt4.txt') } },
        renderer,
        emitEvent: () => {},
      }),
      (err) => err.message.includes('no JSON')
    );
  });
});

describe('API Controller - stable system snapshot', () => {
  it('reuses the first controller system prompt snapshot across turns', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const seenSystemPrompts = [];
    const manifest = makeManifest((_req, body) => {
      seenSystemPrompts.push(body.messages[0].content);
      return {
        text: JSON.stringify({
          action: 'stop',
          agent_id: null,
          claude_message: null,
          controller_messages: ['done'],
          stop_reason: 'done',
          progress_updates: [],
        }),
      };
    });
    const renderer = makeRenderer();

    await runApiControllerTurn({
      manifest,
      request: { id: 'r1', userMessage: 'first', startedAt: 'now', loops: [], latestWorkerResult: null },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt5.txt') } },
      renderer,
      emitEvent: () => {},
    });

    manifest.controller.extraInstructions = 'Changed later';

    await runApiControllerTurn({
      manifest,
      request: { id: 'r2', userMessage: 'second', startedAt: 'later', loops: [], latestWorkerResult: null },
      loop: { controller: { promptFile: path.join(tmpDir, 'prompt6.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(seenSystemPrompts.length, 2);
    assert.equal(seenSystemPrompts[0], seenSystemPrompts[1]);
    assert.doesNotMatch(seenSystemPrompts[1], /Changed later/);
  });
});

describe('API Controller - usage summary aggregation', () => {
  it('persists controller usage summary and emits live updates', async () => {
    const { runApiControllerTurn } = require('../../src/api-controller');
    const manifest = makeManifest(() => ({
      text: JSON.stringify({
        action: 'stop',
        agent_id: null,
        claude_message: null,
        controller_messages: ['done'],
        stop_reason: 'done',
        progress_updates: [],
      }),
      usage: {
        prompt_tokens: 44,
        completion_tokens: 11,
        total_tokens: 55,
        prompt_tokens_details: {
          cached_tokens: 40,
          cache_write_tokens: 2,
        },
        cost: 0.0044,
        cost_details: {
          upstream_inference_prompt_cost: 0.0031,
          upstream_inference_completions_cost: 0.0013,
        },
      },
    }));
    const renderer = makeRenderer();

    await runApiControllerTurn({
      manifest,
      request: { id: 'r-usage', userMessage: 'test', startedAt: 'now', loops: [], latestWorkerResult: null },
      loop: { index: 1, controller: { promptFile: path.join(tmpDir, 'prompt-usage.txt') } },
      renderer,
      emitEvent: () => {},
    });

    assert.equal(manifest.usageSummary.totalCostUsd, 0.0044);
    assert.equal(manifest.usageSummary.byActor.controller.totalCostUsd, 0.0044);
    assert.equal(manifest.usageSummary.byActor.worker.totalCostUsd, 0);
    assert.equal(fs.existsSync(manifest.files.manifest), true, 'should save manifest with usage summary');
    const usageMsg = renderer.output.find((entry) => entry.type === 'usageStats');
    assert.ok(usageMsg, 'should emit live usage summary');
    assert.equal(usageMsg.summary.byActor.controller.promptTokens, 44);
  });
});
