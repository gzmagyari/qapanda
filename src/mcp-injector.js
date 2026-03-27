/**
 * System MCP auto-injection — shared by CLI and extension.
 *
 * Injects detached-command and cc-tasks MCPs into manifests,
 * filters by target (controller/worker/both/none), and handles
 * host rewriting for remote agents (host.docker.internal).
 */
const path = require('node:path');

/**
 * Find the path to detached-command-mcp dist/index.js.
 * Checks multiple locations (extension, project root).
 */
function findDetachedCommandPath(hints = []) {
  const fs = require('node:fs');
  const candidates = [
    ...hints,
    path.resolve(__dirname, '..', 'extension', 'detached-command-mcp', 'dist', 'index.js'),
    path.resolve(__dirname, '..', 'detached-command-mcp', 'dist', 'index.js'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Find the path to tasks-mcp-server.js.
 */
function findTasksMcpPath(hints = []) {
  const fs = require('node:fs');
  const candidates = [
    ...hints,
    path.resolve(__dirname, '..', 'extension', 'tasks-mcp-server.js'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Find the path to tests-mcp-server.js.
 */
function findTestsMcpPath(hints = []) {
  const fs = require('node:fs');
  const candidates = [
    ...hints,
    path.resolve(__dirname, '..', 'extension', 'tests-mcp-server.js'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Build MCP servers for a specific role (controller or worker).
 *
 * @param {'controller'|'worker'} role
 * @param {object} options
 * @param {object} options.globalMcps - Global MCP server configs
 * @param {object} options.projectMcps - Project MCP server configs
 * @param {object} [options.agentMcps] - Agent-specific MCPs to merge
 * @param {boolean} [options.isRemote] - Whether target runs in a container
 * @param {string} [options.repoRoot] - Workspace root (for tasks file path)
 * @param {string} [options.extensionPath] - Extension directory path
 * @param {string} [options.detachedCommandPath] - Explicit path to detached-command-mcp
 * @param {string} [options.tasksMcpPath] - Explicit path to tasks-mcp-server.js
 * @param {number} [options.tasksMcpPort] - HTTP port for tasks MCP (if running as HTTP)
 * @param {number} [options.qaDesktopMcpPort] - HTTP port for qa-desktop MCP
 * @returns {object} MCP server configs for this role
 */
function mcpServersForRole(role, options = {}) {
  const {
    globalMcps = {},
    projectMcps = {},
    agentMcps = {},
    isRemote = false,
    repoRoot = process.cwd(),
    extensionPath,
    detachedCommandPath: explicitDetachedPath,
    tasksMcpPath: explicitTasksPath,
    tasksMcpPort,
    qaDesktopMcpPort,
  } = options;

  const mcpHost = isRemote ? 'host.docker.internal' : '127.0.0.1';
  const result = {};

  // Merge global + project user MCPs, filter by target
  const allUser = { ...globalMcps, ...projectMcps };
  for (const [name, server] of Object.entries(allUser)) {
    if (!server) continue;
    const target = server.target || 'both';
    if (target === 'none') continue;
    if (target === 'both' || target === role) {
      result[name] = { ...server };
      // Rewrite localhost URLs for remote agents
      if (isRemote && result[name].url) {
        result[name].url = result[name].url.replace(/localhost|127\.0\.0\.1/g, mcpHost);
      }
    }
  }

  // Merge agent-specific MCPs (override base)
  for (const [name, server] of Object.entries(agentMcps)) {
    if (server) result[name] = { ...server };
  }

  // Auto-inject cc-tasks
  if (tasksMcpPort) {
    result['cc-tasks'] = { type: 'http', url: `http://${mcpHost}:${tasksMcpPort}/mcp` };
  } else {
    const tasksPath = explicitTasksPath || findTasksMcpPath(extensionPath ? [path.join(extensionPath, 'tasks-mcp-server.js')] : []);
    if (tasksPath) {
      result['cc-tasks'] = {
        command: 'node',
        args: [tasksPath],
        env: { TASKS_FILE: path.join(repoRoot, '.qpanda', 'tasks.json') },
      };
    }
  }

  // Auto-inject cc-tests
  const testsMcpPath = findTestsMcpPath(extensionPath ? [path.join(extensionPath, 'tests-mcp-server.js')] : []);
  if (testsMcpPath) {
    result['cc-tests'] = {
      command: 'node',
      args: [testsMcpPath],
      env: {
        TESTS_FILE: path.join(repoRoot, '.qpanda', 'tests.json'),
        TASKS_FILE: path.join(repoRoot, '.qpanda', 'tasks.json'),
      },
    };
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
  } else {
    const dcPath = explicitDetachedPath || findDetachedCommandPath(extensionPath ? [path.join(extensionPath, 'detached-command-mcp', 'dist', 'index.js')] : []);
    if (dcPath) {
      result['detached-command'] = {
        command: 'node',
        args: [dcPath],
        env: { DETACHED_BASH_MCP_DATA_DIR: path.join(repoRoot, '.qpanda', '.detached-jobs') },
      };
    }
  }

  return result;
}

module.exports = {
  findDetachedCommandPath,
  findTasksMcpPath,
  findTestsMcpPath,
  mcpServersForRole,
};
