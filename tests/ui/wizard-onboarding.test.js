const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;
afterEach(() => { if (wv) wv.cleanup(); });

// Helper: enriched detection data matching the new format from onboarding.js
function fullDetected(overrides = {}) {
  return {
    platform: 'win32',
    clis: {
      claude: { available: true, version: '4.6.0' },
      codex: { available: true, version: 'codex-cli 0.111.0', parsed: { major: 0, minor: 111, patch: 0, raw: '0.111.0' }, versionOk: true, loggedIn: true, loginMethod: 'ChatGPT' },
      ...overrides.clis,
    },
    tools: {
      chrome: { available: true, path: '/usr/bin/chrome', version: '130.0.6723.58', major: 130, versionOk: true },
      node: { available: true, version: 'v22.0.0', major: 22, versionOk: true },
      docker: { available: true, running: true },
      qaDesktop: { available: true },
      ...overrides.tools,
    },
  };
}

describe('Onboarding wizard', () => {
  it('shows onboarding when not complete', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    assert.ok(wv.isVisible('#init-wizard'), 'wizard container should be visible');
    assert.ok(wv.isVisible('#wizard-step-onboard'), 'onboarding step should be visible');
  });

  it('skips to chat when onboarding complete', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });

  it('renders detection results', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({ type: 'onboardingDetected', detected: fullDetected() });
    const statusEl = wv.document.getElementById('onboard-status');
    assert.ok(statusEl, 'status element should exist');
    assert.ok(statusEl.innerHTML.includes('Codex CLI'), 'should show Codex status');
    assert.ok(statusEl.innerHTML.includes('Google Chrome'), 'should show Chrome status');
    assert.ok(statusEl.innerHTML.includes('Node.js'), 'should show Node status');
  });

  it('shows CLI preference cards when CLIs detected', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({ type: 'onboardingDetected', detected: fullDetected() });
    const prefEl = wv.document.getElementById('onboard-cli-preference');
    assert.ok(prefEl, 'preference element should exist');
    // With enableClaudeCli: true (from sampleInitConfig), both + claude-only + codex-only = 3 cards
    const cards = prefEl.querySelectorAll('.wizard-card');
    assert.ok(cards.length >= 2, 'should have at least 2 preference cards');
  });

  it('Continue button enabled after detection', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: fullDetected({
        clis: {
          claude: { available: false },
          codex: { available: true, version: 'codex-cli 0.111.0', parsed: { major: 0, minor: 111, patch: 0, raw: '0.111.0' }, versionOk: true, loggedIn: true, loginMethod: 'ChatGPT' },
        },
        tools: {
          chrome: { available: false, path: null, version: null, major: null, versionOk: false },
          node: { available: true, version: 'v22.0.0', major: 22, versionOk: true },
          docker: { available: false, running: false },
          qaDesktop: { available: false },
        },
      }),
    });
    const nextBtn = wv.document.getElementById('onboard-next');
    assert.ok(nextBtn, 'continue button should exist');
    assert.ok(!nextBtn.disabled, 'continue button should be enabled (codex found)');
  });

  it('Continue button disabled when no CLIs found', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: fullDetected({
        clis: {
          claude: { available: false },
          codex: { available: false, version: null, parsed: null, versionOk: false, loggedIn: false, loginMethod: null },
        },
      }),
    });
    const nextBtn = wv.document.getElementById('onboard-next');
    assert.ok(nextBtn.disabled, 'continue button should be disabled when no CLIs');
  });

  it('Skip Setup posts onboardingSave and goes to chat', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({ type: 'onboardingDetected', detected: fullDetected() });
    wv.click('#onboard-skip');
    const saveMsg = wv.messagesOfType('onboardingSave');
    assert.ok(saveMsg.length > 0, 'should post onboardingSave');
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden after skip');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible after skip');
  });

  it('Continue shows summary, Get Started goes to chat', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({ type: 'onboardingDetected', detected: fullDetected() });
    wv.click('#onboard-next');
    assert.ok(wv.isVisible('#wizard-step-onboard-summary'), 'summary should be visible');
    assert.ok(!wv.isVisible('#wizard-step-onboard'), 'onboarding step should be hidden');

    wv.click('#onboard-complete');
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden after complete');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible after complete');
    const saveMsg = wv.messagesOfType('onboardingSave');
    assert.ok(saveMsg.length > 0, 'should post onboardingSave');
  });

  it('shows impact summary with warnings', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: fullDetected({
        tools: {
          chrome: { available: false, path: null, version: null, major: null, versionOk: false },
          node: { available: true, version: 'v22.0.0', major: 22, versionOk: true },
          docker: { available: false, running: false },
          qaDesktop: { available: false },
        },
      }),
    });
    const statusEl = wv.document.getElementById('onboard-status');
    assert.ok(statusEl.innerHTML.includes('Browser testing unavailable'), 'should show chrome impact warning');
    assert.ok(statusEl.innerHTML.includes('AI Chat'), 'should show chat ready status');
  });

  it('shows codex login warning', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: fullDetected({
        clis: {
          claude: { available: false },
          codex: { available: true, version: 'codex-cli 0.111.0', parsed: { major: 0, minor: 111, patch: 0, raw: '0.111.0' }, versionOk: true, loggedIn: false, loginMethod: null },
        },
      }),
    });
    const statusEl = wv.document.getElementById('onboard-status');
    assert.ok(statusEl.innerHTML.includes('not logged in'), 'should show login warning');
    assert.ok(statusEl.innerHTML.includes('codex login'), 'should show login instruction');
  });
});
