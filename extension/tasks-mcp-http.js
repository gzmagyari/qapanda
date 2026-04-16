/**
 * HTTP version of the QA Panda Tasks MCP Server.
 */
const path = require('node:path');
const { createMcpHttpServer } = require('./mcp-http-server');
const { TOOLS, handleToolCall } = require('./qa-tasks-mcp');

const _servers = new Map();

async function startTasksMcpServer(tasksFile) {
  const key = path.resolve(tasksFile);
  if (_servers.has(key)) {
    const existing = _servers.get(key);
    return { port: existing.port, close: existing.close };
  }

  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: (name, args) => handleToolCall(tasksFile, name, args),
    serverName: 'cc-tasks',
  });

  _servers.set(key, result);
  console.log(`[cc-tasks-http] Started on port ${result.port}, tasks file: ${tasksFile}`);
  return { port: result.port, close: result.close };
}

async function stopTasksMcpServer(tasksFile = null) {
  if (tasksFile) {
    const key = path.resolve(tasksFile);
    const existing = _servers.get(key);
    if (!existing) return;
    await existing.close();
    _servers.delete(key);
    return;
  }
  const servers = Array.from(_servers.values());
  _servers.clear();
  for (const server of servers) {
    await server.close();
  }
}

module.exports = { startTasksMcpServer, stopTasksMcpServer };
