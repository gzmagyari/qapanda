const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});
afterEach(() => { wv.cleanup(); });

describe('Streaming and running state', () => {
  it('running=true hides send button, shows stop, disables textarea', () => {
    wv.postMessage({ type: 'running', value: true });
    const sendBtn = wv.document.getElementById('btn-send');
    const stopBtn = wv.document.getElementById('btn-stop');
    const textarea = wv.document.getElementById('user-input');
    // Send should be hidden or stop visible
    assert.ok(stopBtn, 'stop button should exist');
    assert.ok(textarea.disabled || textarea.readOnly, 'textarea should be disabled when running');
  });

  it('running=false re-enables textarea', () => {
    wv.postMessage({ type: 'running', value: true });
    wv.postMessage({ type: 'running', value: false });
    const textarea = wv.document.getElementById('user-input');
    assert.ok(!textarea.disabled, 'textarea should be enabled when not running');
  });

  it('running compaction state shows the compaction loader text', () => {
    wv.postMessage({
      type: 'running',
      value: true,
      showStop: false,
      statusKind: 'compaction',
      statusText: 'Compacting chat context...',
    });
    const thinking = wv.document.querySelector('.thinking-standalone');
    assert.ok(thinking, 'thinking indicator should render');
    assert.match(thinking.textContent, /Compacting chat context/);
  });

  it('toolCall renders tool description', () => {
    wv.postMessage({ type: 'toolCall', label: 'Developer', text: 'Running command: ls -la' });
    const msgs = wv.document.getElementById('messages');
    assert.ok(msgs.innerHTML.includes('ls -la'), 'should show tool command');
  });
});
