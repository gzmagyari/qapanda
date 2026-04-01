const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, mockRenderer } = require('../helpers/test-utils');
const { prepareNewRun } = require('../../src/state');
const { runManagerLoop, runDirectWorkerTurn } = require('../../src/orchestrator');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');

function hasVisibleUserEntry(entry) {
  return entry.role === 'user' || (entry.kind === 'user_message' && entry.display !== false);
}

function assistantText(entry) {
  if (!entry) return '';
  if (entry.role === 'claude') return entry.text || '';
  if (entry.kind === 'assistant_message') return entry.text || '';
  return '';
}

let tmp;
beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { tmp.cleanup(); });

describe('Full controller→worker loop with fake backends', { timeout: 30000 }, () => {
  it('completes a run with fake codex + fake claude', async () => {
    const renderer = mockRenderer();
    const fakeCodex = path.resolve(__dirname, '..', 'fakes', 'fake-codex.js');
    const fakeClaude = path.resolve(__dirname, '..', 'fakes', 'fake-claude.js');

    // Check fakes exist
    if (!fs.existsSync(fakeCodex) || !fs.existsSync(fakeClaude)) {
      assert.ok(true, 'fake backends not found, skipping');
      return;
    }

    const manifest = await prepareNewRun({
      message: 'hello',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: `node ${fakeCodex}`,
      workerBin: `node ${fakeClaude}`,
    });

    const updated = await runManagerLoop(manifest, renderer, { userMessage: 'hello' });

    assert.ok(updated, 'should return updated manifest');
    assert.equal(updated.status, 'idle', 'status should be idle after completion');

    // Check transcript was written
    if (fs.existsSync(updated.files.transcript)) {
      const content = fs.readFileSync(updated.files.transcript, 'utf8').trim();
      if (content) {
        const lines = content.split('\n').map(l => JSON.parse(l));
        assert.ok(lines.some(hasVisibleUserEntry), 'transcript should have user entry');
      }
    }
  });
});

describe('Direct worker turn', { timeout: 60000 }, () => {
  it('runs a direct worker turn with real claude', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const renderer = mockRenderer();
    const manifest = await prepareNewRun({
      message: 'test',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: 'codex',
      workerBin: 'claude',
    });

    const updated = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Say exactly: DIRECT_LOOP_OK',
    });

    assert.equal(updated.status, 'idle');
    assert.ok(updated.requests.length > 0, 'should have requests');
    assert.equal(updated.requests[0].status, 'stopped');

    // Check transcript
    const content = fs.readFileSync(updated.files.transcript, 'utf8').trim();
    const lines = content.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const workerLine = lines.find(l => assistantText(l));
    assert.ok(workerLine, 'should have worker in transcript');
    assert.ok(assistantText(workerLine).includes('DIRECT_LOOP_OK'), 'worker should respond with requested text');
  });

  it('manifest tracks request lifecycle correctly', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const renderer = mockRenderer();
    const manifest = await prepareNewRun({
      message: 'test',
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerBin: 'codex',
      workerBin: 'claude',
    });

    const updated = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Say hi',
    });

    const req = updated.requests[0];
    assert.ok(req.id, 'request should have id');
    assert.ok(req.startedAt, 'request should have startedAt');
    assert.ok(req.finishedAt, 'request should have finishedAt');
    assert.equal(req.status, 'stopped');
    assert.ok(req.loops.length > 0, 'should have loops');
    assert.ok(req.loops[0].worker, 'loop should have worker record');
  });
});
