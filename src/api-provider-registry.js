const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILTIN_PROVIDER_DEFS = Object.freeze({
  openai: Object.freeze({
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseURL: undefined,
    envKey: 'OPENAI_API_KEY',
    catalogKey: 'openai',
    builtIn: true,
    custom: false,
    legacy: false,
    apiKeyOptional: false,
    transportProvider: 'openai',
  }),
  anthropic: Object.freeze({
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1/',
    envKey: 'ANTHROPIC_API_KEY',
    catalogKey: 'anthropic',
    builtIn: true,
    custom: false,
    legacy: false,
    apiKeyOptional: false,
    transportProvider: 'anthropic',
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    catalogKey: 'openrouter',
    builtIn: true,
    custom: false,
    legacy: false,
    apiKeyOptional: false,
    transportProvider: 'openrouter',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envKey: 'GEMINI_API_KEY',
    catalogKey: 'gemini',
    builtIn: true,
    custom: false,
    legacy: false,
    apiKeyOptional: false,
    transportProvider: 'gemini',
  }),
});

const LEGACY_CUSTOM_PROVIDER = Object.freeze({
  id: 'custom',
  name: 'Custom',
  kind: 'openai-compatible',
  baseURL: undefined,
  envKey: null,
  catalogKey: 'custom',
  builtIn: true,
  custom: false,
  legacy: true,
  apiKeyOptional: true,
  transportProvider: 'custom',
});

const BUILTIN_PROVIDER_IDS = Object.freeze(Object.keys(BUILTIN_PROVIDER_DEFS));

function cloneProvider(provider) {
  return provider ? { ...provider } : null;
}

function settingsPath() {
  return path.join(os.homedir(), '.qpanda', 'settings.json');
}

function loadProviderSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function sanitizeCustomProviderId(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text;
}

function normalizeCustomProvider(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = sanitizeCustomProviderId(entry.id || entry.name);
  if (!id || BUILTIN_PROVIDER_DEFS[id] || id === LEGACY_CUSTOM_PROVIDER.id) return null;
  const baseURL = String(entry.baseURL || '').trim();
  if (!baseURL) return null;
  const name = String(entry.name || '').trim() || id;
  return {
    id,
    name,
    kind: 'openai-compatible',
    baseURL,
    envKey: null,
    catalogKey: 'custom',
    builtIn: false,
    custom: true,
    legacy: false,
    apiKeyOptional: true,
    transportProvider: 'custom',
  };
}

function normalizeCustomProviders(entries) {
  const normalized = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const provider = normalizeCustomProvider(entry);
    if (!provider || seen.has(provider.id)) continue;
    seen.add(provider.id);
    normalized.push(provider);
  }
  return normalized;
}

function normalizeLearnedToolIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeLearnedApiTools(data) {
  const source = data && typeof data === 'object' ? data : {};
  const normalized = {};
  for (const [agentId, tools] of Object.entries(source)) {
    const normalizedAgentId = String(agentId || '').trim();
    if (!normalizedAgentId || !tools || typeof tools !== 'object') continue;
    const normalizedTools = {};
    for (const [toolName, record] of Object.entries(tools)) {
      const normalizedToolName = String(toolName || '').trim();
      if (!normalizedToolName || !record || typeof record !== 'object') continue;
      const useCount = Number(record.useCount);
      const lastUsedAt = normalizeLearnedToolIso(record.lastUsedAt);
      const pinned = !!record.pinned;
      const expiresAt = pinned ? null : normalizeLearnedToolIso(record.expiresAt);
      normalizedTools[normalizedToolName] = {
        toolName: normalizedToolName,
        useCount: Number.isFinite(useCount) && useCount > 0 ? Math.floor(useCount) : 1,
        lastUsedAt,
        expiresAt,
        pinned,
      };
    }
    if (Object.keys(normalizedTools).length > 0) {
      normalized[normalizedAgentId] = normalizedTools;
    }
  }
  return normalized;
}

function listApiProviders(settings = null) {
  const source = settings || {};
  return [
    ...BUILTIN_PROVIDER_IDS.map((id) => cloneProvider(BUILTIN_PROVIDER_DEFS[id])),
    ...normalizeCustomProviders(source.customProviders),
  ];
}

function resolveApiProvider(providerId, settings = null) {
  const id = String(providerId || '').trim();
  if (!id) return null;
  if (BUILTIN_PROVIDER_DEFS[id]) return cloneProvider(BUILTIN_PROVIDER_DEFS[id]);
  if (id === LEGACY_CUSTOM_PROVIDER.id) return cloneProvider(LEGACY_CUSTOM_PROVIDER);
  const source = settings || loadProviderSettings();
  const customProvider = normalizeCustomProviders(source.customProviders).find((entry) => entry.id === id);
  return customProvider ? cloneProvider(customProvider) : null;
}

function providerCatalogKey(providerId, settings = null) {
  const resolved = resolveApiProvider(providerId, settings);
  if (resolved && resolved.catalogKey) return resolved.catalogKey;
  if (BUILTIN_PROVIDER_DEFS[providerId]) return providerId;
  return 'openrouter';
}

function isKnownApiProvider(providerId, settings = null) {
  return !!resolveApiProvider(providerId, settings);
}

function resolveRuntimeApiProvider(providerId, settings = null) {
  const provider = resolveApiProvider(providerId, settings);
  if (!provider) return null;
  return {
    ...provider,
    clientProvider: provider.transportProvider || provider.id,
  };
}

function normalizeSettingsData(data = {}) {
  const settings = data && typeof data === 'object' ? data : {};
  const apiKeys = settings.apiKeys && typeof settings.apiKeys === 'object' ? { ...settings.apiKeys } : {};
  return {
    ...settings,
    lazyMcpToolsEnabled: Boolean(settings.lazyMcpToolsEnabled),
    learnedApiToolsEnabled: Boolean(settings.learnedApiToolsEnabled),
    learnedApiTools: normalizeLearnedApiTools(settings.learnedApiTools),
    apiKeys,
    customProviders: normalizeCustomProviders(settings.customProviders).map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseURL: provider.baseURL,
    })),
  };
}

module.exports = {
  BUILTIN_PROVIDER_DEFS,
  BUILTIN_PROVIDER_IDS,
  LEGACY_CUSTOM_PROVIDER,
  isKnownApiProvider,
  listApiProviders,
  loadProviderSettings,
  normalizeCustomProvider,
  normalizeCustomProviders,
  normalizeLearnedApiTools,
  normalizeSettingsData,
  providerCatalogKey,
  resolveApiProvider,
  resolveRuntimeApiProvider,
  sanitizeCustomProviderId,
  settingsPath,
};
