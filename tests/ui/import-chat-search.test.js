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

describe('Import chat search', () => {
  it('renders a search field and posts debounced search requests', async () => {
    wv.postMessage({
      type: 'importChatHistory',
      provider: 'codex',
      query: '',
      sessions: [
        {
          provider: 'codex',
          sessionId: '11111111-1111-1111-1111-111111111111',
          updatedAt: '2026-04-09T12:00:00.000Z',
          title: 'Codex session',
          preview: 'Initial preview',
        },
      ],
    });
    await wv.flush();

    const input = wv.document.querySelector('.run-history-search-input');
    assert.ok(input, 'search input should render');

    const startCount = wv.messages.length;
    input.value = 'critical files';
    input.dispatchEvent(new wv.window.Event('input', { bubbles: true }));
    const status = wv.document.querySelector('.run-history-search-status');
    assert.ok(status, 'search status should render');
    assert.match(status.textContent, /Searching chat messages/i);
    await new Promise((resolve) => wv.window.setTimeout(resolve, 220));
    await wv.flush();

    const searchMsgs = wv.messages.filter((msg, index) => index >= startCount && msg.type === 'searchImportChats');
    assert.equal(searchMsgs.length, 1);
    assert.equal(searchMsgs[0].provider, 'codex');
    assert.equal(searchMsgs[0].query, 'critical files');

    wv.postMessage({
      type: 'importChatHistory',
      provider: 'codex',
      query: 'critical files',
      requestId: searchMsgs[0].requestId,
      sessions: [
        {
          provider: 'codex',
          sessionId: '11111111-1111-1111-1111-111111111111',
          updatedAt: '2026-04-09T12:00:00.000Z',
          title: 'Codex session',
          preview: 'Initial preview',
          matchPreview: '...Critical files for implementation live under server/src...',
        },
      ],
    });
    await wv.flush();

    const match = wv.document.querySelector('.run-history-match');
    assert.ok(match, 'match preview should render');
    assert.match(match.textContent, /critical files/i);
  });

  it('shows a search-specific empty state when no messages match', async () => {
    wv.postMessage({
      type: 'importChatHistory',
      provider: 'claude',
      query: '',
      sessions: [],
    });
    await wv.flush();

    wv.postMessage({
      type: 'importChatHistory',
      provider: 'claude',
      query: 'missing phrase',
      requestId: 'req-1',
      sessions: [],
    });
    await wv.flush();

    const empty = wv.document.querySelector('.run-history-empty');
    assert.ok(empty, 'empty state should render');
    assert.match(empty.textContent, /No chat messages matched "missing phrase"\./);
  });
});
