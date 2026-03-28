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
    // Should not override the saved target with QA-Browser since 'agent-dev' is already an agent target
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });
});
