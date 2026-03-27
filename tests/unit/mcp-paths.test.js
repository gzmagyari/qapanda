const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.resolve(__dirname, '../../extension');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('MCP path existence validation', () => {
  it('detached-command-mcp/dist/index.js exists in extension dir', () => {
    const p = path.join(EXTENSION_DIR, 'detached-command-mcp', 'dist', 'index.js');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('tasks-mcp-server.js exists in extension dir', () => {
    const p = path.join(EXTENSION_DIR, 'tasks-mcp-server.js');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('tasks-mcp-http.js exists in extension dir', () => {
    const p = path.join(EXTENSION_DIR, 'tasks-mcp-http.js');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('qa-desktop-mcp-server.js exists in extension dir', () => {
    const p = path.join(EXTENSION_DIR, 'qa-desktop-mcp-server.js');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('mcp-http-server.js exists in extension dir', () => {
    const p = path.join(EXTENSION_DIR, 'mcp-http-server.js');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('system-agents.json exists in extension resources', () => {
    const p = path.join(EXTENSION_DIR, 'resources', 'system-agents.json');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('system-modes.json exists in extension resources', () => {
    const p = path.join(EXTENSION_DIR, 'resources', 'system-modes.json');
    assert.ok(fs.existsSync(p), `Missing: ${p}`);
  });

  it('{EXTENSION_DIR} placeholder resolves to real detached-command path', () => {
    // Simulate the placeholder replacement
    const template = '{EXTENSION_DIR}/detached-command-mcp/dist/index.js';
    const resolved = template.replace('{EXTENSION_DIR}', EXTENSION_DIR.replace(/\\/g, '/'));
    // Convert forward slashes back for fs check on Windows
    const fsPath = resolved.replace(/\//g, path.sep);
    assert.ok(fs.existsSync(fsPath), `Resolved path missing: ${fsPath}`);
  });

  it('{REPO_ROOT}/.qpanda parent dir is creatable', () => {
    const template = '{REPO_ROOT}/.qpanda/.detached-jobs';
    const resolved = template.replace('{REPO_ROOT}', PROJECT_ROOT.replace(/\\/g, '/'));
    // The .qpanda dir should either exist or its parent should
    const parent = path.dirname(resolved.replace(/\//g, path.sep));
    const grandparent = path.dirname(parent);
    assert.ok(fs.existsSync(grandparent), `Grandparent dir missing: ${grandparent}`);
  });

  it('detached-command-mcp dist/index.js is a valid Node.js file', () => {
    const p = path.join(EXTENSION_DIR, 'detached-command-mcp', 'dist', 'index.js');
    const content = fs.readFileSync(p, 'utf8');
    assert.ok(content.length > 100, 'file should have substantial content');
    // Should be importable without syntax errors
    assert.ok(!content.startsWith('<!DOCTYPE'), 'should not be HTML');
  });

  it('tasks-mcp-server.js is a valid Node.js file', () => {
    const p = path.join(EXTENSION_DIR, 'tasks-mcp-server.js');
    const content = fs.readFileSync(p, 'utf8');
    assert.ok(content.includes('handleToolCall') || content.includes('tools/call'), 'should contain MCP handler code');
  });
});
