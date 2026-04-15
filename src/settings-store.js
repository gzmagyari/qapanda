const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { normalizeSettingsData } = require('./api-provider-registry');

const DEFAULTS = {
  selfTesting: false,
  lazyMcpToolsEnabled: false,
  selfTestPromptController: '',
  selfTestPromptQaBrowser: '',
  selfTestPromptAgent: '',
  apiKeys: {},
  customProviders: [],
};

function settingsPath() {
  return path.join(os.homedir(), '.qpanda', 'settings.json');
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return normalizeSettingsData({ ...DEFAULTS, ...data });
  } catch {
    return normalizeSettingsData({ ...DEFAULTS });
  }
}

function saveSettings(updates) {
  const filePath = settingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadSettings();
  const merged = normalizeSettingsData({ ...existing, ...(updates || {}) });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function getSetting(key) {
  return loadSettings()[key];
}

module.exports = {
  DEFAULTS,
  getSetting,
  loadSettings,
  saveSettings,
  settingsPath,
};
