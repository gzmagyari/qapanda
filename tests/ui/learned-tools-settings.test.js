const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});

afterEach(() => {
  wv.cleanup();
});

describe('Learned tools settings modal', () => {
  it('loads the toggle, renders learned tools, and posts management actions', async () => {
    wv.postMessage({
      type: 'settingsData',
      settings: {
        selfTesting: false,
        lazyMcpToolsEnabled: true,
        learnedApiToolsEnabled: true,
        selfTestPromptController: '',
        selfTestPromptQaBrowser: '',
        selfTestPromptAgent: '',
        apiKeys: {},
        customProviders: [],
        learnedApiTools: {},
      },
      learnedApiTools: [
        {
          agentId: 'QA-Browser',
          toolName: 'chrome_devtools__take_snapshot',
          useCount: 3,
          lastUsedAt: '2026-04-14T12:00:00.000Z',
          expiresAt: '2026-05-14T12:00:00.000Z',
          pinned: false,
        },
        {
          agentId: 'QA-Browser',
          toolName: 'cc_tests__run_test',
          useCount: 1,
          lastUsedAt: '2026-04-13T12:00:00.000Z',
          expiresAt: null,
          pinned: true,
        },
      ],
      defaults: {},
      apiCatalog: sampleInitConfig().apiCatalog,
    });
    await wv.flush();

    const learnedToggle = wv.document.getElementById('setting-learned-api-tools');
    assert.equal(learnedToggle.checked, true);

    wv.click('#settings-learned-tools-manage');
    await wv.flush();

    const modal = wv.document.getElementById('learned-tools-modal');
    assert.equal(modal.classList.contains('visible'), true);
    assert.match(wv.text('#learned-tools-list'), /chrome_devtools__take_snapshot/);
    assert.match(wv.text('#learned-tools-list'), /cc_tests__run_test/);

    const pinButton = Array.from(wv.document.querySelectorAll('#learned-tools-list button'))
      .find((button) => button.textContent.trim() === 'Pin');
    assert.ok(pinButton, 'should render a pin button for unpinned tools');
    pinButton.click();

    const removeButton = Array.from(wv.document.querySelectorAll('#learned-tools-list button'))
      .find((button) => button.textContent.trim() === 'Remove');
    assert.ok(removeButton, 'should render a remove button');
    removeButton.click();

    wv.click('#learned-tools-clear-expired');

    const pinMsg = wv.messages.find((msg) => msg.type === 'settingsLearnedToolPin');
    const removeMsg = wv.messages.find((msg) => msg.type === 'settingsLearnedToolRemove');
    const clearMsg = wv.messages.find((msg) => msg.type === 'settingsLearnedToolsClearExpired');
    assert.ok(pinMsg, 'should post pin/unpin action');
    assert.equal(pinMsg.agentId, 'QA-Browser');
    assert.equal(pinMsg.toolName, 'chrome_devtools__take_snapshot');
    assert.equal(pinMsg.pinned, true);
    assert.ok(removeMsg, 'should post remove action');
    assert.ok(clearMsg, 'should post clear-expired action');
  });
});
