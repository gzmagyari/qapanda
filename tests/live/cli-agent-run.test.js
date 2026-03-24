const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('cc-manager run --agent (e2e)', { timeout: 120000 }, () => {
  it('--agent dev runs dev agent directly', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-max-turns', '1', 'Say exactly: AGENT_DEV_OK'], { timeout: 90000 });
    assert.equal(r.code, 0);
    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(out.includes('Direct worker turn completed') || out.includes('AGENT_DEV_OK'), 'dev agent should respond');
  });

  it('--agent QA-Browser with --no-chrome responds', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'QA-Browser', '--no-chrome', '--worker-max-turns', '1', 'Say exactly: QA_BROWSER_OK'], { timeout: 90000 });
    assert.equal(r.code, 0);
  });
});
