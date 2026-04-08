const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureRootMcpPorts } = require('../../extension/root-mcp-ports');

test('ensureRootMcpPorts does not let qa-desktop failure break core MCP ports when disabled', async () => {
  const ports = await ensureRootMcpPorts('/tmp/repo', {
    startTasksMcpServer: async () => ({ port: 1101 }),
    startTestsMcpServer: async () => ({ port: 1102 }),
    startMemoryMcpServer: async () => ({ port: 1103 }),
    startQaDesktopMcpServer: async () => {
      throw new Error('qa-desktop missing');
    },
    enableQaDesktop: false,
  });

  assert.deepEqual(ports, {
    tasksPort: 1101,
    testsPort: 1102,
    memoryPort: 1103,
    qaDesktopPort: null,
  });
});

test('ensureRootMcpPorts treats qa-desktop as best-effort when enabled', async () => {
  let qaDesktopError = null;
  const ports = await ensureRootMcpPorts('/tmp/repo', {
    startTasksMcpServer: async () => ({ port: 2101 }),
    startTestsMcpServer: async () => ({ port: 2102 }),
    startMemoryMcpServer: async () => ({ port: 2103 }),
    startQaDesktopMcpServer: async () => {
      throw new Error('qa-desktop missing');
    },
    enableQaDesktop: true,
    onQaDesktopError: (error) => {
      qaDesktopError = error;
    },
  });

  assert.equal(qaDesktopError && qaDesktopError.message, 'qa-desktop missing');
  assert.deepEqual(ports, {
    tasksPort: 2101,
    testsPort: 2102,
    memoryPort: 2103,
    qaDesktopPort: null,
  });
});
