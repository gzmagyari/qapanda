const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCloudBoundary,
  listCloudPackageSpecifiers,
  loadCloudPackages,
} = require('../../src/cloud');

describe('loadCloudPackages', () => {
  it('dynamically imports the client-safe hosted packages from CommonJS', async () => {
    const packages = await loadCloudPackages();

    assert.equal(typeof packages.clientCloud.createCloudApiClient, 'function');
    assert.equal(typeof packages.clientCloud.getCloudAuthStatus, 'function');
    assert.equal(typeof packages.cloudSdk.CloudSdkClient, 'function');
    assert.equal(typeof packages.syncCore.computeRepositoryIdentity, 'function');
    assert.equal(typeof packages.security.redactObject, 'function');
    assert.equal(typeof packages.ui.buildAppNav, 'function');
  });
});

describe('createCloudBoundary', () => {
  it('preloads packages and resolves auth/config summary for local defaults', async () => {
    const boundary = createCloudBoundary({ target: 'cli', env: {} });
    const summary = await boundary.preload();

    assert.equal(summary.target, 'cli');
    assert.equal(summary.ready, true);
    assert.equal(summary.error, null);
    assert.deepEqual(summary.packages, listCloudPackageSpecifiers());
    assert.equal(summary.config.apiBaseUrl, 'https://api.qapanda.localhost');
    assert.equal(summary.config.appBaseUrl, 'https://app.qapanda.localhost');
    assert.deepEqual(summary.auth, {
      enabled: false,
      authMode: 'disabled',
    });
  });

  it('creates an API client from overridden cloud config', async () => {
    const boundary = createCloudBoundary({
      target: 'extension',
      env: {
        QAPANDA_CLOUD_API_BASE_URL: 'https://api.qapanda.example',
        QAPANDA_CLOUD_APP_BASE_URL: 'https://app.qapanda.example',
        QAPANDA_CLOUD_AUTH_MODE: 'device_code',
        QAPANDA_CLOUD_SYNC_INTERVAL_MS: '9000',
      },
    });

    const api = await boundary.createApiClient();
    const auth = await boundary.getAuthStatus();

    assert.equal(api.baseUrls.apiBaseUrl, 'https://api.qapanda.example');
    assert.equal(auth.enabled, true);
    assert.equal(auth.authMode, 'device_code');
  });

  it('returns a safe fallback summary when preload fails', () => {
    const boundary = createCloudBoundary({ target: 'web', env: {} });
    const summary = boundary.summarize(new Error('boom'));

    assert.equal(summary.ready, false);
    assert.equal(summary.error, 'boom');
    assert.equal(summary.auth.enabled, false);
  });
});
