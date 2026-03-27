const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Test the MCP auto-injection logic from session-manager
// We test the merging and filtering patterns used in _mcpServersForRole

describe('MCP injection and merging', () => {
  // Simulate _mcpServersForRole logic
  function mcpServersForRole(role, isRemote, { global: globalMcps, project: projectMcps, tasksMcpPort, qaDesktopMcpPort, extensionPath }) {
    const result = {};
    const mcpHost = isRemote ? 'host.docker.internal' : '127.0.0.1';

    // Merge global + project, filter by target
    const allUser = { ...globalMcps, ...projectMcps };
    for (const [name, server] of Object.entries(allUser)) {
      const target = server.target || 'both';
      if (target === 'none') continue;
      if (target === 'both' || target === role) {
        result[name] = { ...server };
        // Replace localhost with docker host for remote
        if (isRemote && result[name].url) {
          result[name].url = result[name].url.replace(/localhost|127\.0\.0\.1/g, mcpHost);
        }
      }
    }

    // Auto-inject cc-tasks
    if (tasksMcpPort) {
      result['cc-tasks'] = { type: 'http', url: `http://${mcpHost}:${tasksMcpPort}/mcp` };
    }

    // Auto-inject qa-desktop
    if (qaDesktopMcpPort) {
      result['qa-desktop'] = { type: 'http', url: `http://${mcpHost}:${qaDesktopMcpPort}/mcp` };
    }

    // Auto-inject detached-command
    if (isRemote) {
      result['detached-command'] = {
        command: 'node',
        args: ['/opt/detached-command-mcp/dist/index.js'],
        env: { DETACHED_BASH_MCP_DATA_DIR: '/workspace/.qpanda/.detached-jobs' },
      };
    } else if (extensionPath) {
      result['detached-command'] = {
        command: 'node',
        args: [path.join(extensionPath, 'detached-command-mcp', 'dist', 'index.js')],
        env: { DETACHED_BASH_MCP_DATA_DIR: path.join('/test/repo', '.qpanda', '.detached-jobs') },
      };
    }

    return result;
  }

  it('worker gets both and worker-only MCPs', () => {
    const result = mcpServersForRole('worker', false, {
      global: { 'both-mcp': { command: 'a', target: 'both' }, 'worker-mcp': { command: 'b', target: 'worker' } },
      project: {},
    });
    assert.ok(result['both-mcp']);
    assert.ok(result['worker-mcp']);
  });

  it('controller gets both and controller-only MCPs', () => {
    const result = mcpServersForRole('controller', false, {
      global: { 'both-mcp': { command: 'a', target: 'both' }, 'ctrl-mcp': { command: 'b', target: 'controller' } },
      project: {},
    });
    assert.ok(result['both-mcp']);
    assert.ok(result['ctrl-mcp']);
  });

  it('worker does NOT get controller-only MCPs', () => {
    const result = mcpServersForRole('worker', false, {
      global: { 'ctrl-mcp': { command: 'a', target: 'controller' } },
      project: {},
    });
    assert.ok(!result['ctrl-mcp']);
  });

  it('none target excluded from both roles', () => {
    const result = mcpServersForRole('worker', false, {
      global: { 'off-mcp': { command: 'a', target: 'none' } },
      project: {},
    });
    assert.ok(!result['off-mcp']);
  });

  it('auto-injects cc-tasks when port available', () => {
    const result = mcpServersForRole('worker', false, {
      global: {}, project: {}, tasksMcpPort: 12345,
    });
    assert.ok(result['cc-tasks']);
    assert.equal(result['cc-tasks'].url, 'http://127.0.0.1:12345/mcp');
  });

  it('auto-injects qa-desktop when port available', () => {
    const result = mcpServersForRole('worker', false, {
      global: {}, project: {}, qaDesktopMcpPort: 54321,
    });
    assert.ok(result['qa-desktop']);
    assert.equal(result['qa-desktop'].url, 'http://127.0.0.1:54321/mcp');
  });

  it('auto-injects detached-command for local agents', () => {
    const result = mcpServersForRole('worker', false, {
      global: {}, project: {}, extensionPath: '/ext/path',
    });
    assert.ok(result['detached-command']);
    assert.ok(result['detached-command'].args[0].includes('ext/path') || result['detached-command'].args[0].includes('ext\\path'));
  });

  it('auto-injects detached-command with container path for remote agents', () => {
    const result = mcpServersForRole('worker', true, {
      global: {}, project: {},
    });
    assert.ok(result['detached-command']);
    assert.ok(result['detached-command'].args[0].includes('/opt/detached-command-mcp'));
  });

  it('remote agents get host.docker.internal URLs', () => {
    const result = mcpServersForRole('worker', true, {
      global: {}, project: {}, tasksMcpPort: 12345, qaDesktopMcpPort: 54321,
    });
    assert.ok(result['cc-tasks'].url.includes('host.docker.internal'));
    assert.ok(result['qa-desktop'].url.includes('host.docker.internal'));
  });

  it('local agents get 127.0.0.1 URLs', () => {
    const result = mcpServersForRole('worker', false, {
      global: {}, project: {}, tasksMcpPort: 12345,
    });
    assert.ok(result['cc-tasks'].url.includes('127.0.0.1'));
  });

  it('project MCPs override global on name collision', () => {
    const result = mcpServersForRole('worker', false, {
      global: { 'shared': { command: 'global-cmd', target: 'both' } },
      project: { 'shared': { command: 'project-cmd', target: 'both' } },
    });
    assert.equal(result['shared'].command, 'project-cmd');
  });

  it('user-defined MCP URLs replaced for remote', () => {
    const result = mcpServersForRole('worker', true, {
      global: { 'my-api': { type: 'http', url: 'http://localhost:8080/mcp', target: 'both' } },
      project: {},
    });
    assert.ok(result['my-api'].url.includes('host.docker.internal'));
    assert.ok(!result['my-api'].url.includes('localhost'));
  });
});
