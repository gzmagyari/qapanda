const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settingsStorePath = path.resolve(__dirname, '../../extension/settings-store.js');

let tempHome = null;
let originalHomedir = null;

function loadFreshSettingsStore() {
  delete require.cache[settingsStorePath];
  return require(settingsStorePath);
}

describe('settings-store custom providers', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-settings-'));
    originalHomedir = os.homedir;
    os.homedir = () => tempHome;
  });

  afterEach(() => {
    delete require.cache[settingsStorePath];
    if (originalHomedir) os.homedir = originalHomedir;
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
    originalHomedir = null;
  });

  it('round-trips named custom providers and keyed apiKeys', () => {
    const { saveSettings, loadSettings } = loadFreshSettingsStore();
    const saved = saveSettings({
      lazyMcpToolsEnabled: true,
      learnedApiToolsEnabled: true,
      apiKeys: {
        openai: 'openai-key',
        lmstudio: '',
      },
      customProviders: [
        { id: 'LM Studio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
      ],
      learnedApiTools: {
        'QA-Browser': {
          'chrome_devtools__take_snapshot': {
            toolName: 'chrome_devtools__take_snapshot',
            useCount: 2,
            lastUsedAt: '2026-04-14T12:00:00.000Z',
            expiresAt: '2026-05-14T12:00:00.000Z',
            pinned: false,
          },
        },
      },
    });

    assert.deepEqual(saved.customProviders, [
      { id: 'lm-studio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
    ]);
    assert.equal(saved.lazyMcpToolsEnabled, true);
    assert.equal(saved.learnedApiToolsEnabled, true);
    assert.equal(saved.apiKeys.openai, 'openai-key');
    assert.equal(saved.apiKeys.lmstudio, '');
    assert.equal(saved.learnedApiTools['QA-Browser']['chrome_devtools__take_snapshot'].useCount, 2);

    const loaded = loadSettings();
    assert.deepEqual(loaded.customProviders, saved.customProviders);
    assert.equal(loaded.lazyMcpToolsEnabled, true);
    assert.equal(loaded.learnedApiToolsEnabled, true);
    assert.equal(loaded.apiKeys.openai, 'openai-key');
    assert.equal(loaded.learnedApiTools['QA-Browser']['chrome_devtools__take_snapshot'].toolName, 'chrome_devtools__take_snapshot');
  });

  it('records, pins, filters, and clears learned API tools', () => {
    const {
      clearExpiredLearnedApiTools,
      getLearnedApiToolNamesForAgent,
      loadSettings,
      recordLearnedApiToolUsage,
      removeLearnedApiTool,
      updateLearnedApiToolPin,
    } = loadFreshSettingsStore();
    const now = Date.parse('2026-04-14T12:00:00.000Z');

    recordLearnedApiToolUsage('QA-Browser', 'chrome_devtools__take_snapshot', { now });
    recordLearnedApiToolUsage('QA-Browser', 'chrome_devtools__take_snapshot', { now: now + 1_000 });
    recordLearnedApiToolUsage('QA-Browser', 'cc_tests__run_test', { now });
    updateLearnedApiToolPin('QA-Browser', 'cc_tests__run_test', true, { now });

    let settings = loadSettings();
    assert.equal(settings.learnedApiTools['QA-Browser']['chrome_devtools__take_snapshot'].useCount, 2);
    assert.equal(settings.learnedApiTools['QA-Browser']['cc_tests__run_test'].pinned, true);

    let eligible = getLearnedApiToolNamesForAgent('QA-Browser', {
      settings,
      catalogNames: new Set(['chrome_devtools__take_snapshot', 'cc_tests__run_test']),
      now: now + 2_000,
    });
    assert.deepEqual(eligible, ['cc_tests__run_test', 'chrome_devtools__take_snapshot']);

    settings = updateLearnedApiToolPin('QA-Browser', 'cc_tests__run_test', false, { now: now + 3_000 });
    settings.learnedApiTools['QA-Browser']['chrome_devtools__take_snapshot'].expiresAt = '2026-04-10T00:00:00.000Z';
    settings.learnedApiTools['QA-Browser']['cc_tests__run_test'].expiresAt = '2026-04-20T00:00:00.000Z';
    const { saveSettings } = loadFreshSettingsStore();
    saveSettings({ learnedApiTools: settings.learnedApiTools });

    clearExpiredLearnedApiTools({ now });
    settings = loadSettings();
    assert.equal(settings.learnedApiTools['QA-Browser']['chrome_devtools__take_snapshot'], undefined);
    assert.ok(settings.learnedApiTools['QA-Browser']['cc_tests__run_test']);

    removeLearnedApiTool('QA-Browser', 'cc_tests__run_test');
    settings = loadSettings();
    assert.equal(settings.learnedApiTools['QA-Browser'], undefined);
  });
});
