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

describe('Loop objective UI', () => {
  it('restores the loop objective and shows the field only when loop mode is enabled', async () => {
    wv.postMessage(sampleInitConfig({
      onboarding: { complete: true, data: null },
      config: {
        loopMode: true,
        loopObjective: 'Finish A-01 through A-03',
      },
    }));
    await wv.flush();

    const wrap = wv.document.getElementById('loop-objective-wrap');
    const input = wv.document.getElementById('loop-objective');
    assert.ok(wrap.classList.contains('visible'));
    assert.equal(input.value, 'Finish A-01 through A-03');
  });

  it('sends configChanged updates for loop toggle and objective edits', async () => {
    const toggle = wv.document.getElementById('loop-toggle');
    const input = wv.document.getElementById('loop-objective');

    toggle.checked = true;
    toggle.dispatchEvent(new wv.window.Event('change', { bubbles: true }));
    input.value = 'Finish A-03';
    input.dispatchEvent(new wv.window.Event('input', { bubbles: true }));
    await wv.flush();

    const configMsgs = wv.messages.filter((msg) => msg.type === 'configChanged');
    const last = configMsgs.at(-1);
    assert.ok(last, 'expected configChanged message');
    assert.equal(last.config.loopMode, true);
    assert.equal(last.config.loopObjective, 'Finish A-03');

    const wrap = wv.document.getElementById('loop-objective-wrap');
    assert.ok(wrap.classList.contains('visible'));
  });
});
