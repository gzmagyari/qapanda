const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir } = require('../helpers/test-utils');
const { prepareNewRun } = require('../../src/state');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');

let tmp;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { tmp.cleanup(); });

describe('Transcript writing', () => {
  it('prepareNewRun creates transcript file path', async () => {
    const manifest = await prepareNewRun({
      message: 'Hello',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: 'codex',
      workerBin: 'claude',
    });

    assert.ok(manifest.files.transcript, 'should have transcript path');
    assert.ok(manifest.files.transcript.endsWith('transcript.jsonl'));
  });

  it('transcript file is created during run', async () => {
    const manifest = await prepareNewRun({
      message: 'Test message',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: 'codex',
      workerBin: 'claude',
    });

    // Manually write transcript entries (simulating what orchestrator does)
    const { appendText } = require('../../src/utils');
    const entry1 = { ts: new Date().toISOString(), role: 'user', text: 'Hello', requestId: 'req-0001' };
    const entry2 = { ts: new Date().toISOString(), role: 'claude', text: 'Hi there!', requestId: 'req-0001', loopIndex: 1 };

    await appendText(manifest.files.transcript, JSON.stringify(entry1) + '\n');
    await appendText(manifest.files.transcript, JSON.stringify(entry2) + '\n');

    // Read and verify
    const content = fs.readFileSync(manifest.files.transcript, 'utf8');
    const lines = content.trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].role, 'user');
    assert.equal(lines[0].text, 'Hello');
    assert.equal(lines[1].role, 'claude');
    assert.equal(lines[1].text, 'Hi there!');
    assert.ok(lines[0].ts, 'should have timestamp');
    assert.ok(!isNaN(new Date(lines[0].ts).getTime()), 'timestamp should be valid ISO');
  });

  it('transcript entries have correct format for all roles', async () => {
    const manifest = await prepareNewRun({
      message: 'Test',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: 'codex',
      workerBin: 'claude',
    });

    const { appendText } = require('../../src/utils');
    const entries = [
      { ts: new Date().toISOString(), role: 'user', text: 'Fix the bug', requestId: 'req-0001' },
      { ts: new Date().toISOString(), role: 'controller', text: 'I will delegate to dev', controllerCli: 'codex', requestId: 'req-0001', loopIndex: 1 },
      { ts: new Date().toISOString(), role: 'claude', text: '\n\nFixed it!', requestId: 'req-0001', loopIndex: 1 },
      { ts: new Date().toISOString(), role: 'controller', text: '[STOP]', controllerCli: 'codex', requestId: 'req-0001', loopIndex: 2 },
    ];

    for (const entry of entries) {
      await appendText(manifest.files.transcript, JSON.stringify(entry) + '\n');
    }

    const content = fs.readFileSync(manifest.files.transcript, 'utf8');
    const lines = content.trim().split('\n').map(l => JSON.parse(l));

    assert.equal(lines.length, 4);
    assert.equal(lines[0].role, 'user');
    assert.equal(lines[1].role, 'controller');
    assert.equal(lines[1].controllerCli, 'codex');
    assert.equal(lines[2].role, 'claude');
    assert.equal(lines[3].text, '[STOP]');
  });
});

describe('Transcript writing with real worker', { timeout: 60000 }, () => {
  it('runDirectWorkerTurn writes transcript entries', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const { runDirectWorkerTurn } = require('../../src/orchestrator');
    const { mockRenderer } = require('../helpers/test-utils');
    const renderer = mockRenderer();

    const manifest = await prepareNewRun({
      message: 'Say hi',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: 'codex',
      workerBin: 'claude',
    });

    await runDirectWorkerTurn(manifest, renderer, { userMessage: 'Say exactly: TRANSCRIPT_TEST' });

    // Read transcript
    assert.ok(fs.existsSync(manifest.files.transcript), 'transcript file should exist');
    const content = fs.readFileSync(manifest.files.transcript, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

    assert.ok(lines.length >= 2, 'should have at least user + worker entries');
    assert.equal(lines[0].role, 'user');
    assert.equal(lines[0].text, 'Say exactly: TRANSCRIPT_TEST');

    const workerEntry = lines.find(l => l.role === 'claude');
    assert.ok(workerEntry, 'should have claude entry');
    assert.ok(workerEntry.text.length > 0, 'worker should have response text');
  });
});
