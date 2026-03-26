const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runCcManager } = require('../helpers/cli-runner');

describe('cc-manager modes (e2e)', { timeout: 10000 }, () => {
  it('lists all system modes', async () => {
    const r = await runCcManager(['modes']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('test'), 'should list test');
    assert.ok(r.stdout.includes('test'), 'should list test');
    assert.ok(r.stdout.includes('dev'), 'should list dev');
    assert.ok(r.stdout.includes('dev-test'), 'should list dev-test');
    assert.ok(r.stdout.includes('dev-test') || r.stdout.includes('Dev & Test & Test'), 'should list dev-test');
  });

  it('shows direct mode type', async () => {
    const r = await runCcManager(['modes']);
    assert.ok(r.stdout.includes('direct'), 'should show direct modes');
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
    // CLI may be claude or codex depending on user config overrides
    assert.ok(r.stdout.includes('claude') || r.stdout.includes('codex'), 'should show a CLI backend');
    assert.ok(r.stdout.includes('qa-remote-claude') || r.stdout.includes('qa-remote-codex'), 'should show a remote CLI backend');
  });
});

describe('cc-manager mcp (e2e)', { timeout: 10000 }, () => {
  it('lists MCP info', async () => {
    const r = await runCcManager(['mcp']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('Auto-injected') || r.stdout.includes('detached-command'), 'should mention auto-injected MCPs');
  });
});
