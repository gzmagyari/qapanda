const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('qapanda run --print (e2e)', { timeout: 120000 }, () => {
  it('--print --agent dev runs once and exits', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--print', '--agent', 'dev', '--worker-max-turns', '1', 'Say exactly: PRINT_MODE_OK'], { timeout: 90000 });
    assert.equal(r.code, 0, 'should exit 0');
    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(out.includes('Direct worker turn completed') || out.includes('PRINT_MODE_OK'), 'should contain response');
  });
});
