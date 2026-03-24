const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runShell, stripAnsi } = require('../helpers/cli-runner');
const { createTempDir } = require('../helpers/test-utils');

describe('cc-manager shell commands (e2e)', { timeout: 30000 }, () => {
  it('/config shows all configuration fields', async () => {
    const r = await runShell(['/config']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('Mode:'), 'should show mode');
    assert.ok(out.includes('Controller CLI:'), 'should show controller CLI');
    assert.ok(out.includes('Worker CLI:'), 'should show worker CLI');
    assert.ok(out.includes('Controller model:'), 'should show controller model');
    assert.ok(out.includes('Worker thinking:'), 'should show worker thinking');
    assert.ok(out.includes('Wait delay:'), 'should show wait delay');
  });

  it('/modes lists available modes', async () => {
    const r = await runShell(['/modes']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('quick-test'), 'should list quick-test');
    assert.ok(out.includes('quick-dev'), 'should list quick-dev');
    assert.ok(out.includes('auto-dev'), 'should list auto-dev');
  });

  it('/agents lists available agents', async () => {
    const r = await runShell(['/agents']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('dev') || out.includes('Developer'), 'should list dev agent');
    assert.ok(out.includes('QA'), 'should list QA agent');
  });

  it('/mcp shows MCP info', async () => {
    const r = await runShell(['/mcp']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('MCP') || out.includes('Auto-injected') || out.includes('detached-command'), 'should show MCP info');
  });

  it('/mode quick-dev changes mode', async () => {
    const r = await runShell(['/mode quick-dev']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('quick-dev') && out.includes('direct'), 'should confirm mode set to quick-dev with direct agent');
  });

  it('/agent dev sets direct agent', async () => {
    const r = await runShell(['/agent dev']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('Switched to direct agent: dev') || out.includes('Developer'), 'should confirm dev agent');
  });

  it('/agent none switches back to controller', async () => {
    const r = await runShell(['/agent none']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('controller'), 'should confirm controller mode');
  });

  it('/controller-cli claude changes controller CLI', async () => {
    const r = await runShell(['/controller-cli claude']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('Controller CLI set to: claude'), 'should confirm controller CLI change');
  });

  it('/worker-thinking high sets thinking level', async () => {
    const r = await runShell(['/worker-thinking high']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('Worker thinking set to: high'), 'should confirm thinking level');
  });

  it('/worker-model claude-sonnet-4-6 sets model', async () => {
    const r = await runShell(['/worker-model claude-sonnet-4-6']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('Worker model set to: claude-sonnet-4-6'), 'should confirm model');
  });

  it('/tasks with no tasks shows empty', async () => {
    const tmp = createTempDir();
    try {
      const r = await runShell(['/tasks'], { cwd: tmp.root });
      const out = stripAnsi(r.stdout);
      assert.ok(out.includes('No tasks') || out.includes('tasks'), 'should show no tasks');
    } finally { tmp.cleanup(); }
  });

  it('/task add creates a task, /tasks lists it', async () => {
    const tmp = createTempDir();
    try {
      const r = await runShell(['/task add E2E Test Task', '/tasks'], { cwd: tmp.root });
      const out = stripAnsi(r.stdout);
      assert.ok(out.includes('E2E Test Task'), 'task should be created and listed');
    } finally { tmp.cleanup(); }
  });

  it('/help shows all commands', async () => {
    const r = await runShell(['/help']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('/config'), 'should list /config');
    assert.ok(out.includes('/mode'), 'should list /mode');
    assert.ok(out.includes('/agent'), 'should list /agent');
    assert.ok(out.includes('/tasks'), 'should list /tasks');
    assert.ok(out.includes('/instances'), 'should list /instances');
    assert.ok(out.includes('/mcp'), 'should list /mcp');
  });

  it('/clear detaches from run', async () => {
    const r = await runShell(['/clear', '/config']);
    const out = stripAnsi(r.stdout);
    assert.ok(out.includes('Chat cleared') || out.includes('Run attached: no'), 'should clear chat');
  });
});
