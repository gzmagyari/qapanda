const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

// Chrome manager is in the extension directory
let chromeManager;
try {
  chromeManager = require('../../extension/chrome-manager');
} catch {
  chromeManager = null;
}

const panelId = 'test-panel-' + Date.now();
let chromeStarted = false;

afterEach(async () => {
  if (chromeStarted && chromeManager) {
    try { chromeManager.killChrome(panelId); } catch {}
    chromeStarted = false;
  }
});

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

describe('Browser testing - Chrome lifecycle', { timeout: 30000 }, () => {
  it('starts headless Chrome and gets a debug port', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }

    const result = await chromeManager.ensureChrome(panelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    chromeStarted = true;

    assert.ok(result.port, 'should return a port');
    assert.ok(typeof result.port === 'number');
    assert.ok(result.port > 0);
  });

  it('Chrome debug endpoint responds', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }

    const result = await chromeManager.ensureChrome(panelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    chromeStarted = true;

    // Check /json/version endpoint
    try {
      const version = await httpGet(`http://127.0.0.1:${result.port}/json/version`);
      assert.ok(version, 'should get version info');
      assert.ok(version.Browser || version.webSocketDebuggerUrl, 'should have browser info');
    } catch (e) {
      assert.fail('Chrome debug endpoint should be reachable: ' + e.message);
    }
  });

  it('getChromePort returns port for running instance', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }

    const result = await chromeManager.ensureChrome(panelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    chromeStarted = true;

    const port = chromeManager.getChromePort(panelId);
    assert.equal(port, result.port);
  });

  it('getChromePort returns null for unknown panel', (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }
    const port = chromeManager.getChromePort('nonexistent-panel');
    assert.equal(port, null);
  });

  it('killChrome stops the instance', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }

    const result = await chromeManager.ensureChrome(panelId);
    if (!result) { t.skip('Chrome binary not found'); return; }

    chromeManager.killChrome(panelId);
    chromeStarted = false;

    const port = chromeManager.getChromePort(panelId);
    assert.equal(port, null, 'port should be null after kill');
  });
});

describe('Chrome CDP interaction', { timeout: 30000 }, () => {
  const cdpPanelId = 'test-cdp-' + Date.now();
  let cdpStarted = false;

  afterEach(async () => {
    if (cdpStarted && chromeManager) {
      try { chromeManager.killChrome(cdpPanelId); } catch {}
      cdpStarted = false;
    }
  });

  it('can list pages via CDP /json endpoint', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }
    const result = await chromeManager.ensureChrome(cdpPanelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    cdpStarted = true;

    const pages = await httpGet(`http://127.0.0.1:${result.port}/json`);
    assert.ok(Array.isArray(pages), 'should return array of pages');
    assert.ok(pages.length > 0, 'should have at least one page');
    assert.ok(pages[0].webSocketDebuggerUrl, 'page should have WS debug URL');
  });

  it('can navigate via CDP /json endpoint', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }
    const result = await chromeManager.ensureChrome(cdpPanelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    cdpStarted = true;

    // Navigate to a data URL
    const pages = await httpGet(`http://127.0.0.1:${result.port}/json`);
    assert.ok(pages.length > 0);
    // pages[0] should be the initial tab
    assert.ok(pages[0].url, 'should have URL');
  });
});

describe('Chrome screencast', { timeout: 30000 }, () => {
  const scPanelId = 'test-screencast-' + Date.now();
  let scStarted = false;

  afterEach(async () => {
    if (scStarted && chromeManager) {
      try { chromeManager.stopScreencast(scPanelId); } catch {}
      try { chromeManager.killChrome(scPanelId); } catch {}
      scStarted = false;
    }
  });

  it('startScreencast delivers frame data', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }
    const result = await chromeManager.ensureChrome(scPanelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    scStarted = true;

    let frameCount = 0;
    let lastFrameData = null;

    await chromeManager.startScreencast(scPanelId, (data, metadata) => {
      frameCount++;
      lastFrameData = data;
    }, (url) => {
      // navigation callback
    });

    // Wait for at least one frame
    await new Promise(r => setTimeout(r, 3000));

    assert.ok(frameCount > 0, 'should receive at least one frame');
    assert.ok(lastFrameData, 'frame data should be non-null');
    assert.ok(typeof lastFrameData === 'string', 'frame data should be string (base64)');
    assert.ok(lastFrameData.length > 100, 'frame data should have substantial content');
  });

  it('capturePanelScreenshot returns a fresh data URL from the bound target', async (t) => {
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }
    const result = await chromeManager.ensureChrome(scPanelId);
    if (!result) { t.skip('Chrome binary not found'); return; }
    scStarted = true;

    await chromeManager.startScreencast(scPanelId, () => {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const capture = await chromeManager.capturePanelScreenshot(scPanelId);
    assert.ok(capture, 'should return capture metadata');
    assert.ok(typeof capture.dataUrl === 'string' && capture.dataUrl.startsWith('data:image/'), 'should return a screenshot data URL');
    assert.ok(capture.dataUrl.length > 100, 'screenshot payload should have substantial content');
  });
});
