/**
 * HTTP wrapper for cc-memory MCP server.
 */
const { createMcpHttpServer } = require('./mcp-http-server');
const { TOOLS, handleToolCall } = require('./memory-mcp-core');

const _servers = new Map();

async function startMemoryMcpServer(memoryFile) {
  const resolvedMemoryFile = require('node:path').resolve(memoryFile);
  if (_servers.has(resolvedMemoryFile)) return _servers.get(resolvedMemoryFile);
  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: (name, args) => handleToolCall(name, args, resolvedMemoryFile),
    serverName: 'cc-memory',
  });
  _servers.set(resolvedMemoryFile, result);
  console.error(`[cc-memory-http] Started on port ${result.port}, memory file: ${resolvedMemoryFile}`);
  return result;
}

async function stopMemoryMcpServer(memoryFile = null) {
  if (memoryFile) {
    const resolvedMemoryFile = require('node:path').resolve(memoryFile);
    const existing = _servers.get(resolvedMemoryFile);
    if (!existing) return;
    await existing.close();
    _servers.delete(resolvedMemoryFile);
    return;
  }
  const servers = Array.from(_servers.values());
  _servers.clear();
  for (const server of servers) {
    await server.close();
  }
}

module.exports = { startMemoryMcpServer, stopMemoryMcpServer };
