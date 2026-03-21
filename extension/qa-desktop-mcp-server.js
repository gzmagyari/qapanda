/**
 * HTTP MCP server for managing qa-desktop container instances.
 * Exposes snapshot, list, and status tools so agents (including those
 * running inside containers) can manage their own environment.
 */
const { exec } = require('node:child_process');
const { createMcpHttpServer } = require('./mcp-http-server');

function run(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const TOOLS = [
  {
    name: 'snapshot_container',
    description: 'Save the current container state as a Docker snapshot image for faster future startup. Call this after successfully setting up an app.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name to snapshot' },
      },
      required: ['name'],
    },
  },
  {
    name: 'snapshot_delete',
    description: 'Delete a previously saved snapshot image',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Snapshot name to delete' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_instances',
    description: 'List all running qa-desktop container instances with their ports and sync status',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_instance_status',
    description: 'Get detailed status of a specific container instance',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name' },
      },
      required: ['name'],
    },
  },
];

let _workspace = '';

async function handleToolCall(name, args) {
  const wsFlag = _workspace ? ` --workspace "${_workspace}"` : '';
  switch (name) {
    case 'snapshot_container': {
      const result = await run(`qa-desktop snapshot "${args.name}"${wsFlag} --json`);
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Snapshot failed');
      return result.stdout.trim();
    }
    case 'snapshot_delete': {
      const result = await run(`qa-desktop snapshot-delete "${args.name}"${wsFlag} --json`);
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Snapshot delete failed');
      return result.stdout.trim();
    }
    case 'list_instances': {
      const result = await run('qa-desktop ls --json');
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'List failed');
      return result.stdout.trim() || '[]';
    }
    case 'get_instance_status': {
      const result = await run('qa-desktop ls --json');
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'List failed');
      try {
        const instances = JSON.parse(result.stdout.trim());
        const match = instances.find(i => i.name === args.name);
        if (!match) throw new Error(`Instance '${args.name}' not found`);
        return JSON.stringify(match, null, 2);
      } catch (err) {
        if (err.message.includes('not found')) throw err;
        throw new Error(`Failed to parse instance list: ${err.message}`);
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Server lifecycle ---

let _server = null;

async function startQaDesktopMcpServer(workspace) {
  if (_server) return { port: _server.port, close: _server.close };
  _workspace = workspace || '';

  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall,
    serverName: 'qa-desktop',
  });

  _server = result;
  console.log(`[qa-desktop-mcp] Started on port ${result.port}`);
  return { port: result.port, close: result.close };
}

async function stopQaDesktopMcpServer() {
  if (!_server) return;
  await _server.close();
  _server = null;
}

module.exports = { startQaDesktopMcpServer, stopQaDesktopMcpServer };
