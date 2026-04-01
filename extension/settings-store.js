/**
 * Global persistent settings for QA Panda.
 * Stored at ~/.qpanda/settings.json — applies across all sessions and panels.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULTS = {
  selfTesting: false,
  selfTestPromptController: '',
  selfTestPromptQaBrowser: '',
  selfTestPromptAgent: '',
  apiKeys: {},  // { openai: 'sk-...', anthropic: 'sk-ant-...', openrouter: 'sk-or-...', gemini: '...', custom: '...' }
};

function settingsPath() {
  return path.join(os.homedir(), '.qpanda', 'settings.json');
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(updates) {
  const filePath = settingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = loadSettings();
  const merged = { ...existing, ...updates };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function getSetting(key) {
  return loadSettings()[key];
}

module.exports = { loadSettings, saveSettings, getSetting, DEFAULTS };
