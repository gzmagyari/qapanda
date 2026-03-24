const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'quick-dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
  wv.click('[data-tab="agents"]');
});
afterEach(() => { wv.cleanup(); });

describe('Agents tab', () => {
  it('system agents are listed', () => {
    const systemList = wv.document.getElementById('agent-list-system');
    assert.ok(systemList, 'system agent list should exist');
    assert.ok(systemList.innerHTML.includes('Developer'), 'should show Developer agent');
    assert.ok(systemList.innerHTML.includes('QA Engineer'), 'should show QA agent');
  });

  it('agent cards show name and CLI', () => {
    const systemList = wv.document.getElementById('agent-list-system');
    assert.ok(systemList.innerHTML.includes('claude') || systemList.innerHTML.includes('codex'), 'should show CLI info');
  });

  it('agent cards have toggle checkbox', () => {
    const toggles = wv.document.querySelectorAll('#agent-list-system .mcp-toggle');
    assert.ok(toggles.length > 0, 'should have toggle checkboxes');
  });

  it('agent cards have Edit button', () => {
    const editBtns = wv.document.querySelectorAll('#agent-list-system .mcp-btn');
    const hasEdit = Array.from(editBtns).some(btn => btn.textContent === 'Edit');
    assert.ok(hasEdit, 'should have Edit button');
  });

  it('agentsData message refreshes the list', () => {
    wv.postMessage({
      type: 'agentsData',
      agents: {
        system: {
          'custom-agent': { name: 'Custom Agent', description: 'A custom one', cli: 'claude', enabled: true },
        },
        systemMeta: { 'custom-agent': { hasUserOverride: false, removed: false } },
        global: {},
        project: {},
      },
    });
    const systemList = wv.document.getElementById('agent-list-system');
    assert.ok(systemList.innerHTML.includes('Custom Agent'), 'should show new agent');
  });
});
