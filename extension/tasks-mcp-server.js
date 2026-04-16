#!/usr/bin/env node
/**
 * QA Panda Tasks MCP Server.
 */

const readline = require('node:readline');
const { TOOLS, handleToolCall } = require('./qa-tasks-mcp');

const TASKS_FILE = process.env.TASKS_FILE || '';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send(makeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cc-tasks', version: '1.0.0' },
      }));
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      send(makeResult(id, { tools: TOOLS }));
      break;

    case 'tools/call': {
      try {
        const text = handleToolCall(TASKS_FILE, params.name, params.arguments || {});
        send(makeResult(id, { content: [{ type: 'text', text }] }));
      } catch (error) {
        send(makeResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
          isError: true,
        }));
      }
      break;
    }

    default:
      send(makeError(id, -32601, `Unknown method: ${method}`));
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try {
    handleMessage(JSON.parse(line));
  } catch {}
});
