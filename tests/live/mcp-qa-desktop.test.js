const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { skipIfMissing, httpPost, PROJECT_ROOT } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

let remoteDesktop;
try { remoteDesktop = require('../../src/remote-desktop'); } catch { remoteDesktop = null; }

let mcpServer = null;
let startedInstance = null;
let tmp = null;

beforeEach(() => { tmp = createTempDir(); });
afterEach(async () => {
  if (mcpServer) { try { mcpServer.close(); } catch {} mcpServer = null; }
  if (startedInstance && remoteDesktop) {
    try { await remoteDesktop.stopInstance(startedInstance); } catch {}
    startedInstance = null;
  }
  if (tmp) { tmp.cleanup(); tmp = null; }
});

describe('QA Desktop MCP server (HTTP)', { timeout: 300000 }, () => {
  it('starts the qa-desktop MCP server and lists tools', async (t) => {
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const { startQaDesktopMcpServer, stopQaDesktopMcpServer } = require('../../extension/qa-desktop-mcp-server');
    mcpServer = await startQaDesktopMcpServer(tmp.root);
    assert.ok(mcpServer.port, 'should return a port');

    const baseUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;

    // Initialize
    const initRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });
    assert.ok(initRes.result, 'should initialize');

    // List tools
    const toolsRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '2', method: 'tools/list', params: {} });
    const toolNames = toolsRes.result.tools.map(t => t.name);
    assert.ok(toolNames.includes('list_instances'), 'should have list_instances');
    assert.ok(toolNames.includes('get_instance_status'), 'should have get_instance_status');
    assert.ok(toolNames.includes('snapshot_container'), 'should have snapshot_container');

    stopQaDesktopMcpServer();
    mcpServer = null;
  });

  it('list_instances returns data', async (t) => {
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const { startQaDesktopMcpServer, stopQaDesktopMcpServer } = require('../../extension/qa-desktop-mcp-server');
    mcpServer = await startQaDesktopMcpServer(tmp.root);
    const baseUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;

    await httpPost(baseUrl, { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });

    const listRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'list_instances', arguments: {} } });
    assert.ok(listRes.result, 'should return result');
    const text = listRes.result.content[0].text;
    assert.ok(typeof text === 'string', 'should return text');

    stopQaDesktopMcpServer();
    mcpServer = null;
  });

  it('get_instance_status for running container', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    // Start a container first
    const panelId = 'test-mcp-qa-' + Date.now();
    const desktop = await remoteDesktop.ensureDesktop(tmp.root, panelId);
    if (!desktop) { t.skip('Could not start container'); return; }
    startedInstance = desktop.name;

    const { startQaDesktopMcpServer, stopQaDesktopMcpServer } = require('../../extension/qa-desktop-mcp-server');
    mcpServer = await startQaDesktopMcpServer(tmp.root);
    const baseUrl = `http://127.0.0.1:${mcpServer.port}/mcp`;

    await httpPost(baseUrl, { jsonrpc: '2.0', id: '1', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } });

    const statusRes = await httpPost(baseUrl, { jsonrpc: '2.0', id: '2', method: 'tools/call', params: { name: 'get_instance_status', arguments: { name: desktop.name } } });
    assert.ok(statusRes.result, 'should return result');
    const text = statusRes.result.content[0].text;
    assert.ok(text.length > 0, 'should have status text');

    stopQaDesktopMcpServer();
    mcpServer = null;
  });
});
