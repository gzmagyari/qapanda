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

async function handleToolCall(name, args, workspace) {
  const wsFlag = workspace ? ` --workspace "${workspace}"` : '';
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

const _servers = new Map();

async function startQaDesktopMcpServer(workspace) {
  const resolvedWorkspace = workspace ? require('node:path').resolve(workspace) : '';
  if (_servers.has(resolvedWorkspace)) {
    const existing = _servers.get(resolvedWorkspace);
    return { port: existing.port, close: existing.close };
  }

  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: (name, args) => handleToolCall(name, args, resolvedWorkspace),
    serverName: 'qa-desktop',
  });

  _servers.set(resolvedWorkspace, result);
  console.log(`[qa-desktop-mcp] Started on port ${result.port}`);
  return { port: result.port, close: result.close };
}

async function stopQaDesktopMcpServer(workspace = null) {
  if (workspace != null) {
    const resolvedWorkspace = require('node:path').resolve(workspace);
    const existing = _servers.get(resolvedWorkspace);
    if (!existing) return;
    await existing.close();
    _servers.delete(resolvedWorkspace);
    return;
  }
  const servers = Array.from(_servers.values());
  _servers.clear();
  for (const server of servers) {
    await server.close();
  }
}

module.exports = { startQaDesktopMcpServer, stopQaDesktopMcpServer };
