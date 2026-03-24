const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager } = require('../helpers/cli-runner');

describe('cc-manager modes (e2e)', { timeout: 10000 }, () => {
  it('lists all system modes', async () => {
    const r = await runCcManager(['modes']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('quick-test'), 'should list quick-test');
    assert.ok(r.stdout.includes('auto-test'), 'should list auto-test');
    assert.ok(r.stdout.includes('quick-dev'), 'should list quick-dev');
    assert.ok(r.stdout.includes('auto-dev'), 'should list auto-dev');
    assert.ok(r.stdout.includes('auto-dev-test') || r.stdout.includes('Auto Dev & Test'), 'should list auto-dev-test');
  });

  it('shows direct vs controller', async () => {
    const r = await runCcManager(['modes']);
    assert.ok(r.stdout.includes('direct'), 'should show direct modes');
    assert.ok(r.stdout.includes('controller'), 'should show controller modes');
  });
});

describe('cc-manager agents (e2e)', { timeout: 10000 }, () => {
  it('lists all system agents', async () => {
    const r = await runCcManager(['agents']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('dev') || r.stdout.includes('Developer'), 'should list dev');
    assert.ok(r.stdout.includes('QA'), 'should list QA');
    assert.ok(r.stdout.includes('QA-Browser'), 'should list QA-Browser');
    assert.ok(r.stdout.includes('setup-browser'), 'should list setup-browser');
    assert.ok(r.stdout.includes('setup-computer'), 'should list setup-computer');
  });

  it('shows CLI backends', async () => {
    const r = await runCcManager(['agents']);
    assert.ok(r.stdout.includes('claude'), 'should show claude CLI');
    assert.ok(r.stdout.includes('qa-remote-claude'), 'should show remote CLI');
  });
});

describe('cc-manager mcp (e2e)', { timeout: 10000 }, () => {
  it('lists MCP info', async () => {
    const r = await runCcManager(['mcp']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Auto-injected') || r.stdout.includes('detached-command'), 'should mention auto-injected MCPs');
  });
});
