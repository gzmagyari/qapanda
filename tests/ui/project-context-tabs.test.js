const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom();
  wv.postMessage(sampleInitConfig({ onboarding: { complete: true, data: null } }));
});

afterEach(() => {
  wv.cleanup();
});

describe('Project context tabs', () => {
  it('shows App Info and Memory tabs and requests content when opened', () => {
    wv.click('[data-tab="appinfo"]');
    assert.ok(wv.isVisible('#tab-appinfo'));
    assert.equal(wv.messages.at(-1).type, 'appInfoLoad');
    assert.match(
      wv.document.querySelector('#tab-appinfo .project-doc-help').textContent,
      /user-provided facts about the app/i
    );

    wv.click('[data-tab="memory"]');
    assert.ok(wv.isVisible('#tab-memory'));
    assert.equal(wv.messages.at(-1).type, 'memoryLoad');
    assert.match(
      wv.document.querySelector('#tab-memory .project-doc-help').textContent,
      /automatically updated by agents/i
    );
  });

  it('populates app info and memory content from host messages', async () => {
    wv.postMessage({ type: 'appInfoData', content: 'App URL: http://localhost:8001', enabled: true });
    wv.postMessage({ type: 'memoryData', content: 'Known fact: enterprise account', enabled: false });
    await wv.flush();

    assert.equal(wv.document.getElementById('app-info-text').value, 'App URL: http://localhost:8001');
    assert.equal(wv.document.getElementById('app-info-enabled').checked, true);
    assert.equal(wv.document.getElementById('memory-text').value, 'Known fact: enterprise account');
    assert.equal(wv.document.getElementById('memory-enabled').checked, false);
  });

  it('sends save messages with text and enabled toggle state', () => {
    const appInfoText = wv.document.getElementById('app-info-text');
    const appInfoEnabled = wv.document.getElementById('app-info-enabled');
    appInfoText.value = 'Login: test@example.com';
    appInfoEnabled.checked = false;
    wv.click('#app-info-save');

    const appInfoSave = wv.messages.filter((msg) => msg.type === 'appInfoSave').at(-1);
    assert.equal(appInfoSave.type, 'appInfoSave');
    assert.equal(appInfoSave.content, 'Login: test@example.com');
    assert.equal(appInfoSave.enabled, false);

    const memoryText = wv.document.getElementById('memory-text');
    const memoryEnabled = wv.document.getElementById('memory-enabled');
    memoryText.value = 'Durable fact';
    memoryEnabled.checked = true;
    wv.click('#memory-save');

    const memorySave = wv.messages.filter((msg) => msg.type === 'memorySave').at(-1);
    assert.equal(memorySave.type, 'memorySave');
    assert.equal(memorySave.content, 'Durable fact');
    assert.equal(memorySave.enabled, true);
  });
});
