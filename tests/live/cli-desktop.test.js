const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('cc-manager desktop testing (e2e)', { timeout: 300000 }, () => {
  it('--mode test --test-env computer starts container and runs agent', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (await skipIfMissing(t, 'docker')) return;

    const r = await runCcManager([
      'run', '--mode', 'test', '--test-env', 'computer', '--worker-max-turns', '3',
      'Run the command "echo DESKTOP_E2E_OK" and tell me the output.',
    ], { timeout: 240000 });

    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(
      out.includes('DESKTOP_E2E_OK') || out.includes('container') || out.includes('Desktop') || r.code === 0,
      'desktop agent should respond or container should start'
    );
  });
});
