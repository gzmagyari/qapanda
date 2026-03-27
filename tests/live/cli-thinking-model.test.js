const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('qapanda thinking and model flags (e2e)', { timeout: 120000 }, () => {
  it('--worker-thinking high runs without error', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-thinking', 'high', '--worker-max-turns', '1', 'Say hi'], { timeout: 90000 });
    assert.equal(r.code, 0, 'should run with high thinking');
  });

  it('--worker-model claude-sonnet-4-6 runs with specified model', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-model', 'claude-sonnet-4-6', '--worker-max-turns', '1', 'Say hi'], { timeout: 90000 });
    assert.equal(r.code, 0, 'should run with sonnet model');
  });
});
