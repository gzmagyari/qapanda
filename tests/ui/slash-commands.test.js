const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});

afterEach(() => {
  wv.cleanup();
});

describe('Slash command suggestions', () => {
  it('shows /import-chat in autocomplete and executes it on click', async () => {
    const textarea = wv.document.getElementById('user-input');
    textarea.value = '/im';
    textarea.dispatchEvent(new wv.window.Event('input', { bubbles: true }));
    await wv.flush();

    const suggestions = wv.document.getElementById('suggestions');
    assert.ok(suggestions.textContent.includes('/import-chat'));

    const chip = Array.from(suggestions.querySelectorAll('.suggestion-chip'))
      .find((node) => node.textContent.includes('/import-chat'));
    assert.ok(chip, 'should render /import-chat suggestion chip');

    chip.click();
    await wv.flush();

    const sent = wv.messages.filter((msg) => msg.type === 'userInput');
    assert.ok(sent.length > 0, 'should post a userInput message');
    assert.equal(sent.at(-1).type, 'userInput');
    assert.equal(sent.at(-1).text, '/import-chat');
  });
});
