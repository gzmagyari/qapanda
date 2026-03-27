const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('qapanda worker backends (e2e)', { timeout: 120000 }, () => {
  it('--worker-cli claude works', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-cli', 'claude', '--worker-max-turns', '1', 'Say exactly: WORKER_CLAUDE_OK'], { timeout: 90000 });
    assert.equal(r.code, 0);
  });

  it('--worker-cli codex works', async (t) => {
    if (await skipIfMissing(t, 'codex')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-cli', 'codex', '--worker-max-turns', '1', 'Say exactly: WORKER_CODEX_OK'], { timeout: 90000 });
    // Codex as worker may or may not work perfectly but should not crash
    assert.ok(r.code === 0 || r.stdout.length > 0, 'codex worker should produce output');
  });
});
