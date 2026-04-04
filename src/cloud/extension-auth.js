const { resolveHostedCloudUrl } = require('./cli-auth');
const { buildDeviceMetadata } = require('./repository-sync');

const DEFAULT_SECRET_KEY = 'qapanda.cloud.session';

function normalizeCloudAuthMode(value) {
  const normalized = String(value || '').trim();
  if (normalized === 'pkce' || normalized === 'device_code') return normalized;
  return null;
}

function createSecretValueStore(secretStorage) {
  if (!secretStorage) {
    throw new Error('VS Code SecretStorage is required for extension cloud auth.');
  }
  return {
    async get(key) {
      return secretStorage.get(key);
    },
    async set(key, value) {
      await secretStorage.store(key, value);
    },
    async delete(key) {
      await secretStorage.delete(key);
    },
  };
}

function defaultExtensionDeviceName(options = {}) {
  return buildDeviceMetadata({ target: 'extension', ...options }).deviceName;
}

function defaultMachineFingerprint(options = {}) {
  return buildDeviceMetadata({ target: 'extension', ...options }).machineFingerprint;
}

function defaultPlatformLabel(options = {}) {
  return buildDeviceMetadata({ target: 'extension', ...options }).platformLabel;
}

async function createExtensionTokenStore(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const secretKey = options.secretKey || DEFAULT_SECRET_KEY;
  const tokenStore = packages.clientCloud.createPreferredTokenStore({
    secretStore: createSecretValueStore(options.secretStorage),
    secretKey,
  });
  return {
    tokenStore,
    secretKey,
    storageMode: 'vscode-secret-storage',
  };
}

async function loadStoredExtensionSession(boundary, options = {}) {
  const { tokenStore, secretKey, storageMode } = await createExtensionTokenStore(boundary, options);
  const session = await tokenStore.load();
  return { tokenStore, secretKey, storageMode, session };
}

async function fetchCurrentActor(boundary, session) {
  const api = await boundary.createApiClient();
  return api.sdk.withHeaders({
    authorization: `Bearer ${session.tokens.accessToken}`,
  }).getCurrentActor();
}

function buildLoggedOutState(boundary, options = {}) {
  return {
    target: 'extension',
    loggedIn: false,
    authMode: boundary.config.authMode,
    authEnabled: boundary.config.authMode !== 'disabled',
    storageMode: 'vscode-secret-storage',
    secretKey: options.secretKey || DEFAULT_SECRET_KEY,
    appBaseUrl: boundary.config.appBaseUrl,
    apiBaseUrl: boundary.config.apiBaseUrl,
    actor: null,
    workspace: null,
    session: null,
    refreshed: false,
    error: options.error ? (options.error.message || String(options.error)) : null,
  };
}

function buildLoggedInState(boundary, session, currentActor, options = {}) {
  return {
    target: 'extension',
    loggedIn: true,
    authMode: boundary.config.authMode,
    authEnabled: boundary.config.authMode !== 'disabled',
    storageMode: options.storageMode || 'vscode-secret-storage',
    secretKey: options.secretKey || DEFAULT_SECRET_KEY,
    appBaseUrl: boundary.config.appBaseUrl,
    apiBaseUrl: boundary.config.apiBaseUrl,
    actor: currentActor.actor,
    workspace: currentActor.currentWorkspace,
    session: {
      email: session.email || currentActor.actor.email,
      updatedAt: session.updatedAt,
      accessExpiresAt: session.tokens && session.tokens.accessExpiresAt,
      refreshExpiresAt: session.tokens && session.tokens.refreshExpiresAt,
      workspaceId: session.workspaceId || currentActor.currentWorkspace.workspaceId,
    },
    refreshed: Boolean(options.refreshed),
    error: null,
  };
}

async function resolveExtensionCloudState(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const loaded = await loadStoredExtensionSession(boundary, { ...options, packages });
  const { tokenStore, secretKey, storageMode, session } = loaded;
  if (!session) {
    return buildLoggedOutState(boundary, { secretKey });
  }

  try {
    const currentActor = await fetchCurrentActor(boundary, session);
    return buildLoggedInState(boundary, session, currentActor, { storageMode, secretKey, refreshed: false });
  } catch (error) {
    if (!session.tokens || !session.tokens.refreshToken) {
      await packages.clientCloud.clearCloudSession(tokenStore);
      return buildLoggedOutState(boundary, {
        secretKey,
        error: new Error('Stored QA Panda Cloud session is no longer valid. Sign in again.'),
      });
    }

    try {
      const refreshedSession = await packages.clientCloud.refreshCloudSession({ tokenStore });
      const currentActor = await fetchCurrentActor(boundary, refreshedSession);
      return buildLoggedInState(boundary, refreshedSession, currentActor, {
        storageMode,
        secretKey,
        refreshed: true,
      });
    } catch (refreshError) {
      await packages.clientCloud.clearCloudSession(tokenStore);
      return buildLoggedOutState(boundary, {
        secretKey,
        error: new Error(`Stored QA Panda Cloud session expired: ${refreshError.message || String(refreshError)}`),
      });
    }
  }
}

async function loginExtensionCloud(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const openExternal = options.openExternal;
  if (typeof openExternal !== 'function') {
    throw new Error('An openExternal function is required for extension cloud login.');
  }
  const authMode = normalizeCloudAuthMode(options.authMode)
    || (boundary.config.authMode === 'disabled' ? 'pkce' : boundary.config.authMode);
  const { tokenStore, secretKey } = await createExtensionTokenStore(boundary, { ...options, packages });
  const api = await boundary.createApiClient();
  const device = buildDeviceMetadata({
    target: 'extension',
    appName: options.appName,
    appVersion: options.appVersion,
    deviceName: options.deviceName,
    machineFingerprint: options.machineFingerprint,
    platformLabel: options.platformLabel,
  });
  const loginInput = {
    sdk: api.sdk,
    tokenStore,
    openExternal,
    deviceName: device.deviceName,
    machineFingerprint: device.machineFingerprint,
    platformLabel: device.platformLabel,
  };
  if (authMode !== 'pkce') {
    throw new Error('The VS Code extension currently supports browser PKCE login only.');
  }
  const result = await packages.clientCloud.startBrowserPkceLogin(loginInput);
  const state = await resolveExtensionCloudState(boundary, { ...options, packages, secretKey });
  return {
    method: 'pkce',
    callbackUrl: result.callbackUrl,
    session: result.session,
    state,
  };
}

async function logoutExtensionCloud(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const { tokenStore, secretKey, storageMode, session } = await loadStoredExtensionSession(boundary, { ...options, packages });
  let revokedRemotely = false;
  if (session && session.tokens && session.tokens.refreshToken) {
    try {
      const api = await boundary.createApiClient();
      await api.sdk.logout(session.tokens.refreshToken);
      revokedRemotely = true;
    } catch {
      revokedRemotely = false;
    }
  }
  await packages.clientCloud.clearCloudSession(tokenStore);
  return {
    hadSession: Boolean(session),
    revokedRemotely,
    state: buildLoggedOutState(boundary, { secretKey }),
    storageModeBeforeClear: storageMode,
  };
}

async function openExtensionCloudTarget(boundary, options = {}) {
  const openExternal = options.openExternal;
  if (typeof openExternal !== 'function') {
    throw new Error('An openExternal function is required for extension cloud links.');
  }
  const url = resolveHostedCloudUrl(boundary, options.target || 'app', options.id || null);
  await openExternal(url);
  return { url };
}

module.exports = {
  DEFAULT_SECRET_KEY,
  createExtensionTokenStore,
  defaultExtensionDeviceName,
  defaultMachineFingerprint,
  defaultPlatformLabel,
  loadStoredExtensionSession,
  loginExtensionCloud,
  logoutExtensionCloud,
  openExtensionCloudTarget,
  resolveExtensionCloudState,
};
