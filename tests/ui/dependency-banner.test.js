const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});
afterEach(() => { wv.cleanup(); });

describe('Dependency banner', () => {
  it('dependencyMissing creates banner in DOM', () => {
    wv.postMessage({ type: 'dependencyMissing', tool: 'chrome', message: 'Chrome not found. Install it for browser testing.' });
    const banners = wv.document.querySelectorAll('.dependency-banner');
    assert.ok(banners.length > 0, 'should create a dependency banner');
    assert.ok(banners[0].textContent.includes('Chrome not found'), 'banner should contain message');
  });

  it('banner uses tool name as fallback', () => {
    wv.postMessage({ type: 'dependencyMissing', tool: 'docker' });
    const banners = wv.document.querySelectorAll('.dependency-banner');
    assert.ok(banners.length > 0);
    assert.ok(banners[0].textContent.includes('docker'), 'should show tool name');
  });
});
