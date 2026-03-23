/**
 * Generic HTTP-based MCP server using Streamable HTTP transport.
 * Receives JSON-RPC requests via POST /mcp, returns JSON-RPC responses.
 * Binds to 127.0.0.1 only — Docker containers reach it via host.docker.internal.
 */
const http = require('node:http');
const net = require('node:net');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {number} [options.port] - Port to listen on (0 or omit for auto)
 * @param {Array} options.tools - MCP tool definitions [{name, description, inputSchema}]
 * @param {function} options.handleToolCall - async (name, args) => string
 * @param {string} options.serverName - Server name for initialize response
 * @returns {Promise<{port: number, server: http.Server, close: function}>}
 */
async function createMcpHttpServer(options) {
  const { tools, handleToolCall, serverName } = options;
  const port = options.port || await findFreePort();

  function jsonRpcResponse(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  function jsonRpcError(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function handleRequest(body) {
    let req;
    try {
      req = JSON.parse(body);
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }

    const { id, method, params } = req;

    if (method === 'initialize') {
      return jsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
      });
    }

    if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) {
      // Notifications have no id and expect no JSON-RPC response
      return null;
    }

    if (method === 'tools/list') {
      return jsonRpcResponse(id, { tools });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const resultText = await handleToolCall(toolName, toolArgs);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: resultText }],
        });
      } catch (err) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  const server = http.createServer(async (req, res) => {
    // CORS headers for container access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      try {
        const response = await handleRequest(body);
        if (response === null) {
          // Notification — no JSON-RPC response needed
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(response);
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        server,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

module.exports = { createMcpHttpServer, findFreePort };
