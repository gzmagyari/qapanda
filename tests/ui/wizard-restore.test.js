const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;
afterEach(() => { if (wv) wv.cleanup(); });

describe('Wizard restore behavior', () => {
  it('goes to chat when onboarding complete', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });

  it('shows onboarding when not complete', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    assert.ok(wv.isVisible('#init-wizard'), 'wizard should be visible');
    assert.ok(wv.isVisible('#wizard-step-onboard'), 'onboarding step should show');
  });

  it('restores saved chatTarget from state', () => {
    wv = createWebviewDom({ savedState: { config: { chatTarget: 'agent-dev' } } });
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
    const target = wv.document.getElementById('cfg-chat-target');
    assert.equal(target.value, 'agent-dev', 'should preserve the saved agent target');
  });

  it('preserves an explicit controller target instead of forcing QA-Browser', () => {
    wv = createWebviewDom({ savedState: { config: { chatTarget: 'controller' } } });
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    const target = wv.document.getElementById('cfg-chat-target');
    assert.equal(target.value, 'controller', 'should keep an explicit controller target');
  });

  it('persists the host-provided panelId immediately on initConfig', () => {
    wv = createWebviewDom({ savedState: { panelId: 'stale-panel-001' } });
    wv.postMessage(sampleInitConfig({ panelId: 'run-panel-123', onboarding: { complete: true, data: null } }));
    assert.equal(wv.getState().panelId, 'run-panel-123', 'should replace stale panel state with the host-provided panelId');
  });
});
