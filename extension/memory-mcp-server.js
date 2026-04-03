#!/usr/bin/env node
/**
 * QA Panda Memory MCP Server — exposes project memory as MCP tools.
 *
 * Protocol: JSON-RPC 2.0 over stdio (one JSON message per line).
 *
 * Env vars:
 *   MEMORY_FILE — absolute path to MEMORY.md
 */

const readline = require('node:readline');
const { TOOLS, handleToolCall } = require('./memory-mcp-core');

const MEMORY_FILE = process.env.MEMORY_FILE || '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = request;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cc-memory', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized' || (method && method.startsWith('notifications/'))) {
    return;
  }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    try {
      const text = handleToolCall(params.name, params.arguments || {}, MEMORY_FILE);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }] },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        },
      });
    }
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});
