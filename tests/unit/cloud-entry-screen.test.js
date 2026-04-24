const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

describe('cloud entry screen', () => {
  it('shows a signed-out entry gate until the user continues as guest', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: false, authMode: 'pkce' },
      }));
      await wv.flush();

      const entry = wv.document.getElementById('cloud-entry-screen');
      assert.ok(entry.classList.contains('visible'));
      assert.match(entry.textContent, /connected-project sync/i);
      assert.doesNotMatch(entry.textContent, /this repository/i);

      wv.click('#cloud-entry-guest');
      await wv.flush();

      assert.equal(entry.classList.contains('visible'), false);
      assert.equal(Boolean(wv.getState() && wv.getState().guestModeDismissed), false);
    } finally {
      wv.cleanup();
    }
  });

  it('uses the existing login message when sign in is clicked', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: false, authMode: 'pkce' },
      }));
      await wv.flush();

      wv.click('#cloud-entry-login');
      await wv.flush();

      const loginMessages = wv.messagesOfType('cloudSessionLogin');
      assert.equal(loginMessages.length, 1);
    } finally {
      wv.cleanup();
    }
  });

  it('stays hidden when the extension already has a hosted session', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: true, authMode: 'pkce', actor: { email: 'dev@example.com' } },
      }));
      await wv.flush();

      const entry = wv.document.getElementById('cloud-entry-screen');
      assert.equal(entry.classList.contains('visible'), false);
    } finally {
      wv.cleanup();
    }
  });

  it('shows again on a later signed-out open even if guest mode was dismissed before', async () => {
    const wv = createWebviewDom({
      savedState: {
        guestModeDismissed: true,
        config: {},
      },
    });
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: false, authMode: 'pkce' },
      }));
      await wv.flush();

      const entry = wv.document.getElementById('cloud-entry-screen');
      assert.equal(entry.classList.contains('visible'), true);
    } finally {
      wv.cleanup();
    }
  });

  it('only shows the signed-out entry gate on the Agent tab', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: false, authMode: 'pkce' },
      }));
      await wv.flush();

      const entry = wv.document.getElementById('cloud-entry-screen');
      assert.equal(entry.classList.contains('visible'), true);

      wv.click('[data-tab="settings"]');
      await wv.flush();
      assert.equal(entry.classList.contains('visible'), false);

      wv.click('[data-tab="agent"]');
      await wv.flush();
      assert.equal(entry.classList.contains('visible'), true);
    } finally {
      wv.cleanup();
    }
  });

  it('stays hidden when extension cloud is disabled by feature flag', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        featureFlags: { enableRemoteDesktop: true, enableClaudeCli: true, enableExtensionCloud: false },
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: false, authMode: 'pkce' },
      }));
      await wv.flush();

      const entry = wv.document.getElementById('cloud-entry-screen');
      const section = wv.document.getElementById('cloud-account-section');
      assert.equal(entry.classList.contains('visible'), false);
      assert.equal(section.style.display, 'none');
    } finally {
      wv.cleanup();
    }
  });
});
