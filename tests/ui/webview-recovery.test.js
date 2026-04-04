const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

function boot(savedState = { currentMode: 'dev', runId: 'run-1' }) {
  wv = createWebviewDom({ savedState });
  wv.postMessage(sampleInitConfig({ runId: 'run-1', onboarding: { complete: true, data: null } }));
}

beforeEach(() => {
  boot();
});

afterEach(() => {
  wv.cleanup();
});

describe('webview recovery', () => {
  it('shows the fatal recovery UI for uncaught window errors', async () => {
    const err = new Error('fatal boom');
    wv.window.onerror('fatal boom', 'main.js', 12, 4, err);
    await wv.flush();

    const overlay = wv.document.getElementById('fatal-recovery');
    const detail = wv.document.getElementById('fatal-recovery-detail');
    assert.ok(overlay.classList.contains('visible'));
    assert.ok(wv.document.getElementById('app').classList.contains('app-fatal'));
    assert.match(detail.textContent, /fatal boom/);
    assert.ok(
      wv.messagesOfType('_debugLog').some((msg) => /FATAL WEBVIEW ERROR/.test(String(msg.text))),
      'should emit a fatal debug log entry'
    );
  });

  it('shows the same recovery UI for unhandled promise rejections', async () => {
    const event = new wv.window.Event('unhandledrejection');
    Object.defineProperty(event, 'reason', {
      configurable: true,
      value: new Error('promise exploded'),
    });
    wv.window.dispatchEvent(event);
    await wv.flush();

    assert.ok(wv.document.getElementById('fatal-recovery').classList.contains('visible'));
    assert.match(wv.document.getElementById('fatal-recovery-detail').textContent, /promise exploded/);
  });

  it('replays transcript history without handler errors when a stale split browser wrapper was detached', async () => {
    wv.cleanup();
    boot({ currentMode: 'dev', runId: 'run-1', config: { chatTarget: 'agent-QA-Browser' } });

    wv.postMessage({ type: 'chromeReady', chromePort: 9222 });
    wv.postMessage({ type: 'claude', label: 'QA Engineer (Browser)', text: 'Inspecting the app' });
    wv.postMessage({ type: 'toolCall', label: 'QA Engineer (Browser)', text: 'Opening devtools', isChromeDevtools: true });

    const wrapper = wv.document.querySelector('.split-vnc-wrapper');
    assert.ok(wrapper, 'split browser wrapper should exist');
    wrapper.remove();

    assert.doesNotThrow(() => {
      wv.postMessage({
        type: 'transcriptHistory',
        messages: [{ type: 'claude', label: 'QA Engineer (Browser)', text: 'Restored transcript entry' }],
      });
    });

    assert.match(wv.text('#messages'), /Restored transcript entry/);
    assert.equal(
      wv.messagesOfType('_debugLog').some((msg) => String(msg.text).includes('MSG HANDLER ERROR')),
      false,
      'transcript replay should not trigger a handler error'
    );
  });

  it('replays transcript history without handler errors when a stale split desktop wrapper was detached', async () => {
    wv.cleanup();
    boot({ currentMode: 'dev', runId: 'run-1', config: { chatTarget: 'agent-QA' } });

    wv.postMessage({ type: 'desktopReady', novncPort: 6080 });
    wv.postMessage({ type: 'claude', label: 'QA Engineer (Computer)', text: 'Inspecting the desktop app' });
    wv.postMessage({ type: 'toolCall', label: 'QA Engineer (Computer)', text: 'Using computer', isComputerUse: true });

    const wrapper = wv.document.querySelector('.split-vnc-wrapper');
    assert.ok(wrapper, 'split desktop wrapper should exist');
    wrapper.remove();

    assert.doesNotThrow(() => {
      wv.postMessage({
        type: 'transcriptHistory',
        messages: [{ type: 'claude', label: 'QA Engineer (Computer)', text: 'Desktop transcript restored' }],
      });
    });

    assert.match(wv.text('#messages'), /Desktop transcript restored/);
    assert.equal(
      wv.messagesOfType('_debugLog').some((msg) => String(msg.text).includes('MSG HANDLER ERROR')),
      false,
      'desktop transcript replay should not trigger a handler error'
    );
  });
});
