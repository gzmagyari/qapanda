/**
 * HTTP wrapper for cc-memory MCP server.
 */
const { createMcpHttpServer } = require('./mcp-http-server');
const { TOOLS, handleToolCall } = require('./memory-mcp-core');

let _memoryFile = '';
let _server = null;

async function startMemoryMcpServer(memoryFile) {
  if (_server) return _server;
  _memoryFile = memoryFile;
  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: (name, args) => handleToolCall(name, args, _memoryFile),
    serverName: 'cc-memory',
  });
  _server = result;
  console.error(`[cc-memory-http] Started on port ${result.port}, memory file: ${_memoryFile}`);
  return result;
}

function stopMemoryMcpServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

module.exports = { startMemoryMcpServer, stopMemoryMcpServer };
