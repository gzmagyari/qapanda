const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CLOUD_CONFIG,
  buildCloudEnvironment,
  loadCloudConfig,
  summarizeCloudConfig,
} = require('../../src/cloud');

describe('loadCloudConfig', () => {
  it('defaults to the local hosted platform URLs', () => {
    const config = loadCloudConfig({});
    assert.deepEqual(config, DEFAULT_CLOUD_CONFIG);
  });

  it('normalizes overrides from environment variables', () => {
    const config = loadCloudConfig({
      QAPANDA_CLOUD_API_BASE_URL: 'https://api.qapanda.example/',
      QAPANDA_CLOUD_APP_BASE_URL: 'https://app.qapanda.example/',
      QAPANDA_CLOUD_AUTH_MODE: 'pkce',
      QAPANDA_CLOUD_SYNC_INTERVAL_MS: '5000',
    });

    assert.deepEqual(config, {
      apiBaseUrl: 'https://api.qapanda.example',
      appBaseUrl: 'https://app.qapanda.example',
      authMode: 'pkce',
      syncIntervalMs: 5000,
    });
  });

  it('falls back to safe defaults for invalid values', () => {
    const config = loadCloudConfig({
      QAPANDA_CLOUD_AUTH_MODE: 'invalid',
      QAPANDA_CLOUD_SYNC_INTERVAL_MS: '-1',
    });

    assert.equal(config.authMode, 'disabled');
    assert.equal(config.syncIntervalMs, 15000);
  });
});

describe('buildCloudEnvironment', () => {
  it('converts config back into the package env contract', () => {
    const env = buildCloudEnvironment({
      apiBaseUrl: 'https://api.qapanda.example',
      appBaseUrl: 'https://app.qapanda.example',
      authMode: 'device_code',
      syncIntervalMs: 25000,
    });

    assert.deepEqual(env, {
      QAPANDA_CLOUD_API_BASE_URL: 'https://api.qapanda.example',
      QAPANDA_CLOUD_APP_BASE_URL: 'https://app.qapanda.example',
      QAPANDA_CLOUD_AUTH_MODE: 'device_code',
      QAPANDA_CLOUD_SYNC_INTERVAL_MS: '25000',
    });
  });
});

describe('summarizeCloudConfig', () => {
  it('returns the safe config summary used by client bootstraps', () => {
    const summary = summarizeCloudConfig(DEFAULT_CLOUD_CONFIG);
    assert.deepEqual(summary, {
      apiBaseUrl: 'https://api.qapanda.localhost',
      appBaseUrl: 'https://app.qapanda.localhost',
      authMode: 'disabled',
      syncIntervalMs: 15000,
    });
  });
});
