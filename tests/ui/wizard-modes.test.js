const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;
afterEach(() => { if (wv) wv.cleanup(); });

function initWithWizard() {
  wv = createWebviewDom();
  wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
}

describe('Wizard mode selection', () => {
  it('renders mode cards from initConfig', () => {
    initWithWizard();
    const cards = wv.document.querySelectorAll('#wizard-mode-cards .wizard-card');
    assert.ok(cards.length >= 4, 'should have at least 4 mode cards (test, test, dev, dev-test)');
  });

  it('mode cards show name and description', () => {
    initWithWizard();
    const cardsEl = wv.document.getElementById('wizard-mode-cards');
    assert.ok(cardsEl.innerHTML.includes('Test'), 'should show Test');
    assert.ok(cardsEl.innerHTML.includes('Dev'), 'should show Dev');
  });

  it('mode cards grouped by category', () => {
    initWithWizard();
    const cardsHtml = wv.document.getElementById('wizard-mode-cards').innerHTML;
    // Category headers should appear
    const lower = cardsHtml.toLowerCase();
    assert.ok(lower.includes('test'), 'should have test category');
    assert.ok(lower.includes('dev'), 'should have develop category');
  });

  it('clicking test mode shows step 2 (env selection)', () => {
    initWithWizard();
    // Find and click a test mode card (test has requiresTestEnv)
    const cards = wv.document.querySelectorAll('#wizard-mode-cards .wizard-card');
    let testCard = null;
    for (const card of cards) {
      if (card.dataset.modeId === 'test' || card.textContent.includes('Test')) {
        testCard = card;
        break;
      }
    }
    assert.ok(testCard, 'should find test card');
    testCard.click();
    assert.ok(wv.isVisible('#wizard-step-2'), 'step 2 should be visible');
    assert.ok(!wv.isVisible('#wizard-step-1'), 'step 1 should be hidden');
  });

  it('clicking develop mode (no requiresTestEnv) hides wizard', () => {
    initWithWizard();
    const cards = wv.document.querySelectorAll('#wizard-mode-cards .wizard-card');
    let devCard = null;
    for (const card of cards) {
      if (card.dataset.modeId === 'dev' || card.textContent.includes('Dev')) {
        devCard = card;
        break;
      }
    }
    assert.ok(devCard, 'should find dev card');
    devCard.click();
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden after selecting dev mode');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });

  it('step 2 Back button returns to step 1', () => {
    initWithWizard();
    // Click a test mode to get to step 2
    const cards = wv.document.querySelectorAll('#wizard-mode-cards .wizard-card');
    for (const card of cards) {
      if (card.textContent.includes('Test')) { card.click(); break; }
    }
    assert.ok(wv.isVisible('#wizard-step-2'));
    wv.click('#wizard-back-2');
    assert.ok(wv.isVisible('#wizard-step-1'), 'step 1 should be visible');
    assert.ok(!wv.isVisible('#wizard-step-2'), 'step 2 should be hidden');
  });

  it('step 2 Browser click shows step 3', () => {
    initWithWizard();
    const cards = wv.document.querySelectorAll('#wizard-mode-cards .wizard-card');
    for (const card of cards) {
      if (card.textContent.includes('Test')) { card.click(); break; }
    }
    wv.click('.wizard-card[data-env="browser"]');
    assert.ok(wv.isVisible('#wizard-step-3'), 'step 3 should be visible');
    assert.ok(!wv.isVisible('#wizard-step-2'), 'step 2 should be hidden');
  });

  it('step 2 Desktop click shows step 3', () => {
    initWithWizard();
    const cards = wv.document.querySelectorAll('#wizard-mode-cards .wizard-card');
    for (const card of cards) {
      if (card.textContent.includes('Test')) { card.click(); break; }
    }
    wv.click('.wizard-card[data-env="computer"]');
    assert.ok(wv.isVisible('#wizard-step-3'), 'step 3 should be visible');
  });

  it('Re-run Setup button shows onboarding', () => {
    initWithWizard();
    const rerunBtn = wv.document.getElementById('wizard-rerun-btn');
    assert.ok(rerunBtn, 'Re-run Setup button should exist');
    rerunBtn.click();
    assert.ok(wv.isVisible('#wizard-step-onboard'), 'onboarding step should be visible');
  });
});
