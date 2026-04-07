const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

describe('webview target dropdown', () => {
  it('shows local worker agents on init and defaults to QA-Browser', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({ config: {} }));
      await wv.flush();

      const target = wv.document.getElementById('cfg-chat-target');
      const values = Array.from(target.options).map((option) => option.value);

      assert.ok(values.includes('controller'));
      assert.ok(values.includes('agent-dev'));
      assert.ok(values.includes('agent-reviewer'));
      assert.ok(values.includes('agent-QA'));
      assert.ok(values.includes('agent-QA-Browser'));
      assert.equal(target.value, 'agent-QA-Browser');
    } finally {
      wv.cleanup();
    }
  });
});
