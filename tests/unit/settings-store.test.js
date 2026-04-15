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
      apiKeys: {
        openai: 'openai-key',
        lmstudio: '',
      },
      customProviders: [
        { id: 'LM Studio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
      ],
    });

    assert.deepEqual(saved.customProviders, [
      { id: 'lm-studio', name: 'LM Studio', baseURL: 'http://localhost:1234/v1' },
    ]);
    assert.equal(saved.lazyMcpToolsEnabled, true);
    assert.equal(saved.apiKeys.openai, 'openai-key');
    assert.equal(saved.apiKeys.lmstudio, '');

    const loaded = loadSettings();
    assert.deepEqual(loaded.customProviders, saved.customProviders);
    assert.equal(loaded.lazyMcpToolsEnabled, true);
    assert.equal(loaded.apiKeys.openai, 'openai-key');
  });
});
