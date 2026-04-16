/**
 * HTTP wrapper for cc-tests MCP server.
 */
const path = require('node:path');
const { createMcpHttpServer } = require('./mcp-http-server');
const { TOOLS, handleToolCall } = require('./qa-tests-mcp');

const _servers = new Map();

async function startTestsMcpServer(testsFile, tasksFile) {
  const resolvedTestsFile = path.resolve(testsFile);
  const resolvedTasksFile = path.resolve(tasksFile || testsFile.replace('tests.json', 'tasks.json'));
  const key = `${resolvedTestsFile}::${resolvedTasksFile}`;
  if (_servers.has(key)) return _servers.get(key);
  const result = await createMcpHttpServer({
    tools: TOOLS,
    handleToolCall: (name, args) => handleToolCall(name, args, {
      testsFile: resolvedTestsFile,
      tasksFile: resolvedTasksFile,
    }),
    serverName: 'cc-tests',
  });
  _servers.set(key, result);
  console.error(`[cc-tests-http] Started on port ${result.port}, tests file: ${resolvedTestsFile}`);
  return result;
}

async function stopTestsMcpServer(testsFile = null, tasksFile = null) {
  if (testsFile) {
    const key = `${path.resolve(testsFile)}::${path.resolve(tasksFile || testsFile.replace('tests.json', 'tasks.json'))}`;
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

module.exports = { startTestsMcpServer, stopTestsMcpServer };
