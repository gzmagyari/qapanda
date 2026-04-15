const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { normalizeSettingsData } = require('./api-provider-registry');

const LEARNED_API_TOOL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULTS = {
  selfTesting: false,
  lazyMcpToolsEnabled: false,
  learnedApiToolsEnabled: false,
  selfTestPromptController: '',
  selfTestPromptQaBrowser: '',
  selfTestPromptAgent: '',
  learnedApiTools: {},
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

function normalizeAgentToolKey(value) {
  return String(value || '').trim();
}

function learnedToolExpiryIso(now = Date.now()) {
  return new Date(Number(now) + LEARNED_API_TOOL_TTL_MS).toISOString();
}

function sortLearnedApiToolEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((left, right) => {
    if (!!right.pinned !== !!left.pinned) return Number(right.pinned) - Number(left.pinned);
    if (String(left.agentId || '') !== String(right.agentId || '')) {
      return String(left.agentId || '').localeCompare(String(right.agentId || ''));
    }
    const leftLastUsed = left.lastUsedAt ? Date.parse(left.lastUsedAt) || 0 : 0;
    const rightLastUsed = right.lastUsedAt ? Date.parse(right.lastUsedAt) || 0 : 0;
    if (rightLastUsed !== leftLastUsed) return rightLastUsed - leftLastUsed;
    const leftUseCount = Number(left.useCount) || 0;
    const rightUseCount = Number(right.useCount) || 0;
    if (rightUseCount !== leftUseCount) return rightUseCount - leftUseCount;
    return String(left.toolName || '').localeCompare(String(right.toolName || ''));
  });
}

function listLearnedApiTools(settings = null) {
  const source = settings || loadSettings();
  const learned = source && source.learnedApiTools && typeof source.learnedApiTools === 'object'
    ? source.learnedApiTools
    : {};
  const entries = [];
  for (const [agentId, tools] of Object.entries(learned)) {
    if (!tools || typeof tools !== 'object') continue;
    for (const [toolName, record] of Object.entries(tools)) {
      if (!record || typeof record !== 'object') continue;
      entries.push({
        agentId,
        toolName,
        useCount: Number(record.useCount) || 0,
        lastUsedAt: record.lastUsedAt || null,
        expiresAt: record.expiresAt || null,
        pinned: !!record.pinned,
      });
    }
  }
  return sortLearnedApiToolEntries(entries);
}

function getLearnedApiToolNamesForAgent(agentId, options = {}) {
  const normalizedAgentId = normalizeAgentToolKey(agentId);
  if (!normalizedAgentId) return [];
  const settings = options.settings || loadSettings();
  const tools = settings.learnedApiTools && settings.learnedApiTools[normalizedAgentId];
  if (!tools || typeof tools !== 'object') return [];
  const catalogNames = options.catalogNames instanceof Set ? options.catalogNames : null;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  return sortLearnedApiToolEntries(Object.entries(tools).map(([toolName, record]) => ({
    agentId: normalizedAgentId,
    toolName,
    useCount: Number(record && record.useCount) || 0,
    lastUsedAt: record && record.lastUsedAt ? record.lastUsedAt : null,
    expiresAt: record && record.expiresAt ? record.expiresAt : null,
    pinned: !!(record && record.pinned),
  })))
    .filter((entry) => {
      if (catalogNames && !catalogNames.has(entry.toolName)) return false;
      if (entry.pinned) return true;
      const expiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : NaN;
      return Number.isFinite(expiresAtMs) && expiresAtMs > now;
    })
    .map((entry) => entry.toolName);
}

function recordLearnedApiToolUsage(agentId, toolName, options = {}) {
  const normalizedAgentId = normalizeAgentToolKey(agentId);
  const normalizedToolName = normalizeAgentToolKey(toolName);
  if (!normalizedAgentId || !normalizedToolName) {
    return loadSettings();
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const existing = loadSettings();
  const learned = {
    ...(existing.learnedApiTools || {}),
  };
  const agentTools = {
    ...(learned[normalizedAgentId] || {}),
  };
  const previous = agentTools[normalizedToolName] || null;
  agentTools[normalizedToolName] = {
    toolName: normalizedToolName,
    useCount: previous ? (Math.max(1, Number(previous.useCount) || 1) + 1) : 1,
    lastUsedAt: new Date(now).toISOString(),
    expiresAt: previous && previous.pinned ? null : learnedToolExpiryIso(now),
    pinned: !!(previous && previous.pinned),
  };
  learned[normalizedAgentId] = agentTools;
  return saveSettings({ learnedApiTools: learned });
}

function updateLearnedApiToolPin(agentId, toolName, pinned, options = {}) {
  const normalizedAgentId = normalizeAgentToolKey(agentId);
  const normalizedToolName = normalizeAgentToolKey(toolName);
  if (!normalizedAgentId || !normalizedToolName) return loadSettings();
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const existing = loadSettings();
  const learned = { ...(existing.learnedApiTools || {}) };
  const agentTools = { ...(learned[normalizedAgentId] || {}) };
  const current = agentTools[normalizedToolName];
  if (!current) return existing;
  agentTools[normalizedToolName] = {
    toolName: normalizedToolName,
    useCount: Math.max(1, Number(current.useCount) || 1),
    lastUsedAt: current.lastUsedAt || new Date(now).toISOString(),
    expiresAt: pinned ? null : learnedToolExpiryIso(now),
    pinned: !!pinned,
  };
  learned[normalizedAgentId] = agentTools;
  return saveSettings({ learnedApiTools: learned });
}

function removeLearnedApiTool(agentId, toolName) {
  const normalizedAgentId = normalizeAgentToolKey(agentId);
  const normalizedToolName = normalizeAgentToolKey(toolName);
  if (!normalizedAgentId || !normalizedToolName) return loadSettings();
  const existing = loadSettings();
  const learned = { ...(existing.learnedApiTools || {}) };
  const agentTools = { ...(learned[normalizedAgentId] || {}) };
  if (!agentTools[normalizedToolName]) return existing;
  delete agentTools[normalizedToolName];
  if (Object.keys(agentTools).length > 0) learned[normalizedAgentId] = agentTools;
  else delete learned[normalizedAgentId];
  return saveSettings({ learnedApiTools: learned });
}

function clearExpiredLearnedApiTools(options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const existing = loadSettings();
  const learned = existing.learnedApiTools && typeof existing.learnedApiTools === 'object'
    ? existing.learnedApiTools
    : {};
  const next = {};
  for (const [agentId, tools] of Object.entries(learned)) {
    const nextTools = {};
    for (const [toolName, record] of Object.entries(tools || {})) {
      if (!record || typeof record !== 'object') continue;
      if (record.pinned) {
        nextTools[toolName] = record;
        continue;
      }
      const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : NaN;
      if (Number.isFinite(expiresAtMs) && expiresAtMs > now) {
        nextTools[toolName] = record;
      }
    }
    if (Object.keys(nextTools).length > 0) next[agentId] = nextTools;
  }
  return saveSettings({ learnedApiTools: next });
}

module.exports = {
  DEFAULTS,
  LEARNED_API_TOOL_TTL_MS,
  clearExpiredLearnedApiTools,
  getSetting,
  getLearnedApiToolNamesForAgent,
  learnedToolExpiryIso,
  listLearnedApiTools,
  loadSettings,
  recordLearnedApiToolUsage,
  removeLearnedApiTool,
  saveSettings,
  settingsPath,
  sortLearnedApiToolEntries,
  updateLearnedApiToolPin,
};
