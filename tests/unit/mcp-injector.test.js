const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mcpServersForRole, findDetachedCommandPath, findTasksMcpPath } = require('../../src/mcp-injector');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXTENSION_DIR = path.join(PROJECT_ROOT, 'extension');

describe('findDetachedCommandPath', () => {
  it('finds the bundled detached-command-mcp', () => {
    const p = findDetachedCommandPath();
    assert.ok(p, 'should find detached-command path');
    assert.ok(p.includes('detached-command-mcp'));
  });
});

describe('findTasksMcpPath', () => {
  it('finds tasks-mcp-server.js', () => {
    const p = findTasksMcpPath();
    assert.ok(p, 'should find tasks MCP path');
    assert.ok(p.includes('tasks-mcp-server'));
  });
});

describe('mcpServersForRole', () => {
  it('auto-injects detached-command for local worker', () => {
    const mcps = mcpServersForRole('worker', { repoRoot: PROJECT_ROOT });
    assert.ok(mcps['detached-command'], 'should have detached-command');
    assert.ok(mcps['detached-command'].command === 'node');
  });

  it('auto-injects detached-command for local controller', () => {
    const mcps = mcpServersForRole('controller', { repoRoot: PROJECT_ROOT });
    assert.ok(mcps['detached-command']);
  });

  it('auto-injects cc-tasks as stdio when no HTTP port', () => {
    const mcps = mcpServersForRole('worker', { repoRoot: PROJECT_ROOT });
    assert.ok(mcps['cc-tasks'], 'should have cc-tasks');
    assert.ok(mcps['cc-tasks'].command === 'node', 'should be stdio');
  });

  it('uses HTTP cc-tasks when port provided', () => {
    const mcps = mcpServersForRole('worker', { repoRoot: PROJECT_ROOT, tasksMcpPort: 12345 });
    assert.ok(mcps['cc-tasks']);
    assert.equal(mcps['cc-tasks'].type, 'http');
    assert.ok(mcps['cc-tasks'].url.includes('12345'));
  });

  it('uses host.docker.internal for remote agents', () => {
    const mcps = mcpServersForRole('worker', {
      repoRoot: PROJECT_ROOT,
      isRemote: true,
      tasksMcpPort: 12345,
    });
    assert.ok(mcps['cc-tasks'].url.includes('host.docker.internal'));
    // Detached-command should use container path
    assert.ok(mcps['detached-command'].args[0].includes('/opt/detached-command-mcp'));
  });

  it('uses localhost for local agents', () => {
    const mcps = mcpServersForRole('worker', {
      repoRoot: PROJECT_ROOT,
      tasksMcpPort: 12345,
    });
    assert.ok(mcps['cc-tasks'].url.includes('127.0.0.1'));
  });

  it('filters user MCPs by target', () => {
    const mcps = mcpServersForRole('worker', {
      globalMcps: {
        'both-mcp': { command: 'a', target: 'both' },
        'ctrl-only': { command: 'b', target: 'controller' },
        'worker-only': { command: 'c', target: 'worker' },
        'off-mcp': { command: 'd', target: 'none' },
      },
      repoRoot: PROJECT_ROOT,
    });
    assert.ok(mcps['both-mcp']);
    assert.ok(!mcps['ctrl-only'], 'controller-only should not be in worker');
    assert.ok(mcps['worker-only']);
    assert.ok(!mcps['off-mcp'], 'none should be excluded');
  });

  it('controller gets controller-only MCPs', () => {
    const mcps = mcpServersForRole('controller', {
      globalMcps: { 'ctrl-only': { command: 'b', target: 'controller' } },
      repoRoot: PROJECT_ROOT,
    });
    assert.ok(mcps['ctrl-only']);
  });

  it('merges agent MCPs on top of base', () => {
    const mcps = mcpServersForRole('worker', {
      globalMcps: { 'base': { command: 'base' } },
      agentMcps: { 'agent-mcp': { command: 'agent' } },
      repoRoot: PROJECT_ROOT,
    });
    assert.ok(mcps['base']);
    assert.ok(mcps['agent-mcp']);
  });

  it('project MCPs override global on collision', () => {
    const mcps = mcpServersForRole('worker', {
      globalMcps: { 'shared': { command: 'global', target: 'both' } },
      projectMcps: { 'shared': { command: 'project', target: 'both' } },
      repoRoot: PROJECT_ROOT,
    });
    assert.equal(mcps['shared'].command, 'project');
  });

  it('injects qa-desktop when port provided', () => {
    const mcps = mcpServersForRole('worker', {
      repoRoot: PROJECT_ROOT,
      qaDesktopMcpPort: 54321,
    });
    assert.ok(mcps['qa-desktop']);
    assert.ok(mcps['qa-desktop'].url.includes('54321'));
  });
});
