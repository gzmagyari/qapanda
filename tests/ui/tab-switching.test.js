const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom();
  // Send initConfig with onboarding complete so wizard is hidden and chat is shown
  wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
});
afterEach(() => { wv.cleanup(); });

describe('Tab switching', () => {
  it('Agent tab is visible by default', () => {
    assert.ok(wv.isVisible('#tab-agent'), 'Agent tab should be visible');
  });

  it('other tabs are hidden by default', () => {
    assert.ok(!wv.isVisible('#tab-tasks'), 'Issues should be hidden');
    assert.ok(!wv.isVisible('#tab-agents'), 'Agents should be hidden');
    assert.ok(!wv.isVisible('#tab-mcp'), 'MCP should be hidden');
    assert.ok(!wv.isVisible('#tab-instances'), 'Instances should be hidden');
    assert.ok(!wv.isVisible('#tab-computer'), 'Computer should be hidden');
    assert.ok(!wv.isVisible('#tab-browser'), 'Browser should be hidden');
  });

  it('clicking Issues tab shows Issues, hides Agent', () => {
    wv.click('[data-tab="tasks"]');
    assert.ok(wv.isVisible('#tab-tasks'), 'Issues should be visible');
    assert.ok(!wv.isVisible('#tab-agent'), 'Agent should be hidden');
    assert.equal(wv.document.querySelector('[data-tab="tasks"]').textContent.trim(), 'Issues');
  });

  it('clicking Agents tab shows Agents', () => {
    wv.click('[data-tab="agents"]');
    assert.ok(wv.isVisible('#tab-agents'), 'Agents should be visible');
    assert.ok(!wv.isVisible('#tab-agent'), 'Agent should be hidden');
    assert.ok(!wv.isVisible('#tab-tasks'), 'Issues should be hidden');
  });

  it('clicking MCP Servers tab shows MCP', () => {
    wv.click('[data-tab="mcp"]');
    assert.ok(wv.isVisible('#tab-mcp'));
  });

  it('clicking Instances tab shows Instances', () => {
    wv.click('[data-tab="instances"]');
    assert.ok(wv.isVisible('#tab-instances'));
  });

  it('clicking Computer tab shows Computer', () => {
    wv.click('[data-tab="computer"]');
    assert.ok(wv.isVisible('#tab-computer'));
  });

  it('clicking Browser tab shows Browser', () => {
    wv.click('[data-tab="browser"]');
    assert.ok(wv.isVisible('#tab-browser'));
  });

  it('active tab button gets .active class', () => {
    const agentBtn = wv.document.querySelector('[data-tab="agent"]');
    assert.ok(agentBtn.classList.contains('active'), 'Agent button should be active initially');

    wv.click('[data-tab="tasks"]');
    const tasksBtn = wv.document.querySelector('[data-tab="tasks"]');
    assert.ok(tasksBtn.classList.contains('active'), 'Issues button should be active after click');
    assert.ok(!agentBtn.classList.contains('active'), 'Agent button should not be active');
  });

  it('switching back to Agent tab works', () => {
    wv.click('[data-tab="tasks"]');
    assert.ok(!wv.isVisible('#tab-agent'));
    wv.click('[data-tab="agent"]');
    assert.ok(wv.isVisible('#tab-agent'));
  });
});
