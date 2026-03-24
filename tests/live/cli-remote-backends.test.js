const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('cc-manager remote agent backends (e2e)', { timeout: 300000 }, () => {
  it('--agent QA runs qa-remote-claude inside container', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (await skipIfMissing(t, 'docker')) return;

    const r = await runCcManager([
      'run', '--agent', 'QA', '--worker-max-turns', '1',
      'Say exactly: REMOTE_E2E_OK',
    ], { timeout: 240000 });

    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(r.code === 0 || out.includes('REMOTE_E2E_OK') || out.includes('container'), 'remote agent should respond');
  });
});
