const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { extractProxyFlags, rewriteArgv, injectContainerMcps } = require('../../qa-desktop/proxy');

describe('proxy flag extraction', () => {
  it('extracts --agent flag', () => {
    const cfg = extractProxyFlags(['--agent', 'claude', '-p', 'hello']);
    assert.equal(cfg.agent, 'claude');
    assert.deepEqual(cfg.forwardArgs, ['-p', 'hello']);
  });

  it('extracts --agent=codex flag', () => {
    const cfg = extractProxyFlags(['--agent=codex', 'exec', '-p', 'hi']);
    assert.equal(cfg.agent, 'codex');
  });

  it('extracts --remote-port flag', () => {
    const cfg = extractProxyFlags(['--remote-port', '9999', '-p', 'hi']);
    assert.equal(cfg.port, 9999);
  });

  it('extracts --remote-port= flag', () => {
    const cfg = extractProxyFlags(['--remote-port=8080']);
    assert.equal(cfg.port, 8080);
  });

  it('extracts --remote-host flag', () => {
    const cfg = extractProxyFlags(['--remote-host', '10.0.0.1']);
    assert.equal(cfg.host, '10.0.0.1');
  });

  it('extracts --remote-cwd flag', () => {
    const cfg = extractProxyFlags(['--remote-cwd', '/custom/path']);
    assert.equal(cfg.cwd, '/custom/path');
  });

  it('extracts --remote-cwd= flag', () => {
    const cfg = extractProxyFlags(['--remote-cwd=/workspace']);
    assert.equal(cfg.cwd, '/workspace');
  });

  it('extracts --remote-timeout flag', () => {
    const cfg = extractProxyFlags(['--remote-timeout', '300']);
    assert.equal(cfg.timeout, 300);
  });

  it('extracts --session-id flag', () => {
    const cfg = extractProxyFlags(['--session-id', 'abc-123']);
    assert.equal(cfg.sessionId, 'abc-123');
  });

  it('defaults to localhost:8765 /workspace', () => {
    const cfg = extractProxyFlags([]);
    assert.equal(cfg.host, 'localhost');
    assert.equal(cfg.port, 8765);
    assert.equal(cfg.cwd, '/workspace');
  });

  it('passes non-proxy args as forwardArgs', () => {
    const cfg = extractProxyFlags(['--remote-port=9000', '-p', '--output-format', 'stream-json', '--verbose']);
    assert.deepEqual(cfg.forwardArgs, ['-p', '--output-format', 'stream-json', '--verbose']);
  });
});

describe('argv rewriting', () => {
  it('strips --output-last-message and captures path', () => {
    const result = rewriteArgv(['claude', '--output-last-message', '/tmp/result.json', '-p', 'hi']);
    assert.equal(result.outputLastMessage, '/tmp/result.json');
    assert.ok(!result.argv.includes('--output-last-message'));
    assert.ok(!result.argv.includes('/tmp/result.json'));
    assert.ok(result.argv.includes('-p'));
  });

  it('strips --output-last-message= and captures path', () => {
    const result = rewriteArgv(['claude', '--output-last-message=/tmp/r.json', '-p', 'hi']);
    assert.equal(result.outputLastMessage, '/tmp/r.json');
  });

  it('strips --cd and consumes next arg', () => {
    const result = rewriteArgv(['codex', 'exec', '--cd', '/host/path', '-p', 'hi']);
    assert.ok(!result.argv.includes('--cd'));
    assert.ok(!result.argv.includes('/host/path'));
    assert.ok(result.argv.includes('-p'));
  });

  it('strips --cd= style', () => {
    const result = rewriteArgv(['codex', '--cd=/host/path', '-p', 'hi']);
    assert.ok(!result.argv.includes('--cd=/host/path'));
  });

  it('passes through --mcp-config', () => {
    const config = JSON.stringify({ mcpServers: { test: { command: 'node', args: ['s.js'] } } });
    const result = rewriteArgv(['claude', '--mcp-config', config]);
    assert.ok(result.argv.includes('--mcp-config'));
  });

  it('passes through -c flags for codex', () => {
    const result = rewriteArgv(['codex', '-c', 'mcp_servers.test.command="node"']);
    assert.ok(result.argv.includes('-c'));
  });

  it('returns empty files when no local paths', () => {
    const result = rewriteArgv(['claude', '-p', 'hello']);
    assert.deepEqual(result.files, {});
  });
});

describe('container MCP injection', () => {
  it('injects container MCP config for claude', () => {
    const argv = ['claude', '-p', 'hello'];
    const result = injectContainerMcps([...argv], 'claude');
    assert.ok(result.includes('--mcp-config'));
    assert.ok(result.includes('/opt/qa-agent/config/claude.mcp.json'));
  });

  it('does not inject for codex (container handles it)', () => {
    const argv = ['codex', 'exec', '-p', 'hello'];
    const original = [...argv];
    const result = injectContainerMcps([...argv], 'codex');
    // Codex container MCPs are baked in — no injection needed from proxy
    assert.equal(result.length, original.length);
  });
});
