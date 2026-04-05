const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

describe('webview empty states', () => {
  it('shows an explicit empty state for Issues and Tests tabs', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({ config: {} }));
      await wv.flush();

      wv.click('[data-tab="tasks"]');
      await wv.flush();
      wv.postMessage({ type: 'tasksData', tasks: [] });
      await wv.flush();
      assert.match(wv.text('#kanban-board'), /No issues yet/);

      wv.click('[data-tab="tests"]');
      await wv.flush();
      wv.postMessage({ type: 'testsData', tests: [] });
      await wv.flush();
      assert.match(wv.text('#test-board'), /No tests yet/);
    } finally {
      wv.cleanup();
    }
  });
});
