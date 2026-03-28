const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;
afterEach(() => { if (wv) wv.cleanup(); });

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
    // Should go straight to chat, not show wizard
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });

  it('renders detection results', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    // Simulate detection results
    wv.postMessage({
      type: 'onboardingDetected',
      detected: {
        clis: {
          claude: { available: true, version: '4.6.0' },
          codex: { available: true, version: '1.0.0' },
        },
        tools: {
          chrome: { available: true, path: '/usr/bin/chrome' },
          docker: { available: true, running: true },
          qaDesktop: { available: true },
        },
      },
    });
    const statusEl = wv.document.getElementById('onboard-status');
    assert.ok(statusEl, 'status element should exist');
    assert.ok(statusEl.innerHTML.includes('Claude Code CLI'), 'should show Claude status');
    assert.ok(statusEl.innerHTML.includes('Codex CLI'), 'should show Codex status');
    assert.ok(statusEl.innerHTML.includes('Google Chrome'), 'should show Chrome status');
  });

  it('shows CLI preference cards when CLIs detected', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: {
        clis: { claude: { available: true, version: '4.6' }, codex: { available: true, version: '1.0' } },
        tools: { chrome: { available: true }, docker: { available: true, running: true }, qaDesktop: { available: true } },
      },
    });
    const prefEl = wv.document.getElementById('onboard-cli-preference');
    assert.ok(prefEl, 'preference element should exist');
    assert.ok(!prefEl.classList.contains('wizard-hidden'), 'preference should be visible');
    const cards = prefEl.querySelectorAll('.wizard-card');
    assert.ok(cards.length >= 2, 'should have at least 2 preference cards');
  });

  it('Continue button enabled after detection', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: {
        clis: { claude: { available: true, version: '4.6' }, codex: { available: false } },
        tools: { chrome: { available: false }, docker: { available: false, running: false }, qaDesktop: { available: false } },
      },
    });
    const nextBtn = wv.document.getElementById('onboard-next');
    assert.ok(nextBtn, 'continue button should exist');
    assert.ok(!nextBtn.disabled, 'continue button should be enabled (at least one CLI found)');
  });

  it('Continue button disabled when no CLIs found', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: {
        clis: { claude: { available: false }, codex: { available: false } },
        tools: { chrome: { available: false }, docker: { available: false, running: false }, qaDesktop: { available: false } },
      },
    });
    const nextBtn = wv.document.getElementById('onboard-next');
    assert.ok(nextBtn.disabled, 'continue button should be disabled when no CLIs');
  });

  it('Skip Setup posts onboardingSave and goes to chat', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: {
        clis: { claude: { available: true, version: '4.6' }, codex: { available: true, version: '1.0' } },
        tools: { chrome: { available: true }, docker: { available: true, running: true }, qaDesktop: { available: true } },
      },
    });
    wv.click('#onboard-skip');
    const saveMsg = wv.messagesOfType('onboardingSave');
    assert.ok(saveMsg.length > 0, 'should post onboardingSave');
    // Should go to chat, not wizard step 1
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden after skip');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible after skip');
  });

  it('Continue shows summary, Get Started goes to chat', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ onboarding: { complete: false, data: null } }));
    wv.postMessage({
      type: 'onboardingDetected',
      detected: {
        clis: { claude: { available: true, version: '4.6' }, codex: { available: true, version: '1.0' } },
        tools: { chrome: { available: true }, docker: { available: true, running: true }, qaDesktop: { available: true } },
      },
    });
    wv.click('#onboard-next');
    assert.ok(wv.isVisible('#wizard-step-onboard-summary'), 'summary should be visible');
    assert.ok(!wv.isVisible('#wizard-step-onboard'), 'onboarding step should be hidden');

    wv.click('#onboard-complete');
    // Should go to chat, not wizard step 1
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden after complete');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible after complete');
    const saveMsg = wv.messagesOfType('onboardingSave');
    assert.ok(saveMsg.length > 0, 'should post onboardingSave');
  });
});
