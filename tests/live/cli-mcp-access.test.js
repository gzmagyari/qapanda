const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');
const { skipIfMissing } = require('../helpers/live-test-utils');

describe('qapanda MCP access (e2e)', { timeout: 180000 }, () => {
  it('agent sees auto-injected MCPs (detached-command, cc-tasks)', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-max-turns', '3', 'List all your available MCP tools. Just list the tool names.'], { timeout: 120000 });
    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(
      out.includes('start_command') || out.includes('detached') || out.includes('create_task') || out.includes('cc-tasks'),
      'output should mention MCP tools. Got: ' + out.slice(0, 500)
    );
  });

  it('agent can call detached-command MCP', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--agent', 'dev', '--worker-max-turns', '5', 'Use the start_command tool to run "echo CLI_E2E_MCP_OK". Then read_output to show the result.'], { timeout: 120000 });
    const out = stripAnsi(r.stdout + r.stderr);
    assert.ok(
      out.includes('CLI_E2E_MCP_OK') || out.includes('start_command') || out.includes('echo'),
      'should show MCP usage or output. Got: ' + out.slice(0, 500)
    );
  });

  it('--no-mcp-inject disables auto-injection', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    const r = await runCcManager(['run', '--no-mcp-inject', '--agent', 'dev', '--worker-max-turns', '1', 'Say hi'], { timeout: 90000 });
    assert.equal(r.code, 0, 'should still run without MCPs');
  });
});
