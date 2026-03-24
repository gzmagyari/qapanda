const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('cc-manager run --mode (e2e)', { timeout: 120000 }, () => {
  it('--mode quick-dev runs dev agent directly', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--mode', 'quick-dev', '--worker-max-turns', '1', 'Say exactly: MODE_DEV_OK'], { timeout: 90000 });
    assert.equal(r.code, 0, 'should exit 0');
    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(out.includes('Direct worker turn completed') || out.includes('MODE_DEV_OK'), 'should complete as direct worker turn');
  });

  it('--mode quick-dev uses dev agent (no controller)', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--mode', 'quick-dev', '--worker-max-turns', '1', 'Say hi'], { timeout: 90000 });
    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(out.includes('Direct worker turn'), 'should be direct worker (no controller)');
    assert.ok(!out.includes('Controller session:') || out.includes('not started'), 'controller should not have run');
  });
});
