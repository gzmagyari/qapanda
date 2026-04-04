const DEFAULT_CLOUD_CONFIG = Object.freeze({
  apiBaseUrl: 'https://api.qapanda.localhost',
  appBaseUrl: 'https://app.qapanda.localhost',
  authMode: 'disabled',
  syncIntervalMs: 15000,
});

const VALID_AUTH_MODES = new Set(['disabled', 'pkce', 'device_code']);

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeUrl(value, fallback) {
  const normalized = trimTrailingSlash(value);
  return normalized || fallback;
}

function normalizeAuthMode(value) {
  const normalized = String(value || '').trim();
  return VALID_AUTH_MODES.has(normalized) ? normalized : DEFAULT_CLOUD_CONFIG.authMode;
}

function normalizeSyncInterval(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CLOUD_CONFIG.syncIntervalMs;
}

function loadCloudConfig(env = process.env, overrides = {}) {
  const config = {
    apiBaseUrl: normalizeUrl(
      overrides.apiBaseUrl ?? env.QAPANDA_CLOUD_API_BASE_URL,
      DEFAULT_CLOUD_CONFIG.apiBaseUrl
    ),
    appBaseUrl: normalizeUrl(
      overrides.appBaseUrl ?? env.QAPANDA_CLOUD_APP_BASE_URL,
      DEFAULT_CLOUD_CONFIG.appBaseUrl
    ),
    authMode: normalizeAuthMode(overrides.authMode ?? env.QAPANDA_CLOUD_AUTH_MODE),
    syncIntervalMs: normalizeSyncInterval(
      overrides.syncIntervalMs ?? env.QAPANDA_CLOUD_SYNC_INTERVAL_MS
    ),
  };
  return Object.freeze(config);
}

function buildCloudEnvironment(config) {
  const resolved = config || DEFAULT_CLOUD_CONFIG;
  return {
    QAPANDA_CLOUD_API_BASE_URL: resolved.apiBaseUrl,
    QAPANDA_CLOUD_APP_BASE_URL: resolved.appBaseUrl,
    QAPANDA_CLOUD_AUTH_MODE: resolved.authMode,
    QAPANDA_CLOUD_SYNC_INTERVAL_MS: String(resolved.syncIntervalMs),
  };
}

function summarizeCloudConfig(config) {
  const resolved = config || DEFAULT_CLOUD_CONFIG;
  return {
    apiBaseUrl: resolved.apiBaseUrl,
    appBaseUrl: resolved.appBaseUrl,
    authMode: resolved.authMode,
    syncIntervalMs: resolved.syncIntervalMs,
  };
}

module.exports = {
  DEFAULT_CLOUD_CONFIG,
  buildCloudEnvironment,
  loadCloudConfig,
  summarizeCloudConfig,
};
