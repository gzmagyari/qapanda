#!/usr/bin/env node
/**
 * QA Panda Tests MCP Server.
 */

const readline = require('node:readline');
const { TOOLS, handleToolCall } = require('./qa-tests-mcp');

const TESTS_FILE = process.env.TESTS_FILE || '';
const TASKS_FILE = process.env.TASKS_FILE || '';

function handleRequest(msg) {
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'cc-tests', version: '1.0.0' } } };
  }
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  }
  if (msg.method === 'tools/call') {
    try {
      const text = handleToolCall(msg.params.name, msg.params.arguments || {}, {
        testsFile: TESTS_FILE,
        tasksFile: TASKS_FILE,
      });
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true } };
    }
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method: ${msg.method}` } };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const response = handleRequest(msg);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
});

process.stderr.write(`[cc-tests-mcp] Server started, tests file: ${TESTS_FILE}\n`);
