const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;
afterEach(() => { if (wv) wv.cleanup(); });

describe('Wizard restore behavior', () => {
  it('shows wizard when no currentMode', () => {
    wv = createWebviewDom();
    wv.postMessage(sampleInitConfig({ runId: null }));
    assert.ok(wv.isVisible('#init-wizard'), 'wizard should be visible');
  });

  it('hides wizard when currentMode + runId present', () => {
    wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
    wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
    assert.ok(!wv.isVisible('#init-wizard'), 'wizard should be hidden');
    assert.ok(wv.isVisible('#tab-agent'), 'agent tab should be visible');
  });

  it('shows wizard when currentMode set but no runId (stale state)', () => {
    wv = createWebviewDom({ savedState: { currentMode: 'dev' } });
    wv.postMessage(sampleInitConfig({ runId: null }));
    assert.ok(wv.isVisible('#init-wizard'), 'wizard should show for stale state');
  });

  it('shows wizard when currentMode references nonexistent mode', () => {
    wv = createWebviewDom({ savedState: { currentMode: 'deleted-mode', runId: 'run-1' } });
    wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
    assert.ok(wv.isVisible('#init-wizard'), 'wizard should show for invalid mode');
  });
});
