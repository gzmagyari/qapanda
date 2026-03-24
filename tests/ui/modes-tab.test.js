const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'quick-dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
  wv.click('[data-tab="modes"]');
});
afterEach(() => { wv.cleanup(); });

describe('Modes tab', () => {
  it('system modes are listed', () => {
    const systemList = wv.document.getElementById('mode-list-system');
    assert.ok(systemList, 'system mode list should exist');
    assert.ok(systemList.innerHTML.includes('Quick Test'), 'should show Quick Test mode');
    assert.ok(systemList.innerHTML.includes('Quick Dev'), 'should show Quick Dev mode');
  });

  it('modes show category', () => {
    const systemList = wv.document.getElementById('mode-list-system');
    assert.ok(systemList.innerHTML.includes('test') || systemList.innerHTML.includes('develop'), 'should show category');
  });

  it('modes have toggle checkbox', () => {
    const toggles = wv.document.querySelectorAll('#mode-list-system .mcp-toggle');
    assert.ok(toggles.length > 0, 'should have toggle checkboxes');
  });

  it('modesData message refreshes the list', () => {
    wv.postMessage({
      type: 'modesData',
      modes: {
        system: {
          'custom-mode': { name: 'Custom Mode', description: 'A custom mode', category: 'custom', useController: false, requiresTestEnv: false, enabled: true },
        },
        systemMeta: {},
        global: {},
        project: {},
      },
    });
    const systemList = wv.document.getElementById('mode-list-system');
    assert.ok(systemList.innerHTML.includes('Custom Mode'), 'should show new mode');
  });
});
