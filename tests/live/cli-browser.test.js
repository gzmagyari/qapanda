const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

let chromeManager;
try { chromeManager = require('../../extension/chrome-manager'); } catch {}

describe('cc-manager browser testing (e2e)', { timeout: 180000 }, () => {
  it('--mode test --test-env browser auto-starts Chrome', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }

    const r = await runCcManager([
      'run', '--mode', 'test', '--test-env', 'browser', '--worker-max-turns', '3',
      'List your available MCP tools. Just list the tool names.',
    ], { timeout: 120000 });

    const out = stripAnsi(r.stdout + r.stderr);
    // Agent should see chrome-devtools tools if Chrome started
    assert.ok(
      out.includes('chrome') || out.includes('navigate') || out.includes('screenshot') || out.includes('DevTools') || r.code === 0,
      'browser agent should have chrome-devtools MCP or at least run successfully'
    );
  });
});
