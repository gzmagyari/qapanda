const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager, stripAnsi } = require('../helpers/cli-runner');

describe('qapanda doctor (e2e)', { timeout: 30000 }, () => {
  it('exits with code 0', async () => {
    const r = await runCcManager(['doctor']);
    assert.equal(r.code, 0, 'doctor should exit cleanly');
  });

  it('reports Claude Code CLI', async () => {
    const r = await runCcManager(['doctor']);
    assert.ok(r.stdout.includes('Claude Code CLI'), 'should show Claude status');
  });

  it('reports Codex CLI', async () => {
    const r = await runCcManager(['doctor']);
    assert.ok(r.stdout.includes('Codex CLI'), 'should show Codex status');
  });

  it('reports Chrome', async () => {
    const r = await runCcManager(['doctor']);
    assert.ok(r.stdout.includes('Google Chrome'), 'should show Chrome status');
  });

  it('reports Docker', async () => {
    const r = await runCcManager(['doctor']);
    assert.ok(r.stdout.includes('Docker Desktop'), 'should show Docker status');
  });

  it('reports bundled tools', async () => {
    const r = await runCcManager(['doctor']);
    assert.ok(r.stdout.includes('detached-command'), 'should show detached-command');
    assert.ok(r.stdout.includes('tasks-mcp'), 'should show tasks-mcp');
  });

  it('reports onboarding status', async () => {
    const r = await runCcManager(['doctor']);
    assert.ok(r.stdout.includes('Onboarding'), 'should show onboarding status');
  });
});
