const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({
    runId: 'run-1',
    mcpServers: {
      global: { 'test-server': { command: 'node', args: ['server.js'], target: 'both' } },
      project: { 'project-mcp': { type: 'http', url: 'http://localhost:8080/mcp', target: 'worker' } },
    },
  }));
  wv.click('[data-tab="mcp"]');
});
afterEach(() => { wv.cleanup(); });

describe('MCP Servers tab', () => {
  it('global servers listed', () => {
    const globalList = wv.document.getElementById('mcp-list-global');
    assert.ok(globalList, 'global list should exist');
    assert.ok(globalList.innerHTML.includes('test-server'), 'should show global server');
  });

  it('project servers listed', () => {
    const projectList = wv.document.getElementById('mcp-list-project');
    assert.ok(projectList, 'project list should exist');
    assert.ok(projectList.innerHTML.includes('project-mcp'), 'should show project server');
  });

  it('server cards show target', () => {
    const globalList = wv.document.getElementById('mcp-list-global');
    const selects = globalList.querySelectorAll('select');
    assert.ok(selects.length > 0, 'should have target dropdown');
  });

  it('Add button exists for each scope', () => {
    const addBtns = wv.document.querySelectorAll('.mcp-add-btn');
    assert.ok(addBtns.length >= 2, 'should have Add buttons for global and project');
  });

  it('empty scope shows placeholder', () => {
    wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
    wv.postMessage(sampleInitConfig({ runId: 'run-1', mcpServers: { global: {}, project: {} } }));
    wv.click('[data-tab="mcp"]');
    const globalList = wv.document.getElementById('mcp-list-global');
    assert.ok(globalList.innerHTML.includes('No servers') || globalList.children.length <= 1, 'should show empty message or minimal content');
  });
});
