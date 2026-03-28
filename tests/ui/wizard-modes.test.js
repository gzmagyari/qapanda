const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;
afterEach(() => { if (wv) wv.cleanup(); });

describe('Wizard simplified flow', () => {
  it('goes straight to chat when onboarding complete', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    // Wizard should be hidden, chat visible
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });

  it('shows onboarding when not complete', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    assert.ok(wv.isVisible('#init-wizard'), 'wizard should be visible');
    assert.ok(wv.isVisible('#wizard-step-onboard'), 'onboarding step should be visible');
  });

  it('sets QA-Browser as default target after onboarding', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    const configMsgs = wv.messagesOfType('configChanged');
    const hasBrowserTarget = configMsgs.some(m => m.config && m.config.chatTarget === 'agent-QA-Browser');
    assert.ok(hasBrowserTarget, 'should set QA-Browser as default target');
  });

  it('shows welcome splash on fresh start', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    const splash = wv.document.querySelector('.welcome-splash');
    assert.ok(splash, 'welcome splash should be shown');
    assert.ok(splash.innerHTML.includes('QA Panda'), 'splash should say QA Panda');
  });
});
