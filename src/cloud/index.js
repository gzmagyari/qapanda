const {
  DEFAULT_CLOUD_CONFIG,
  buildCloudEnvironment,
  loadCloudConfig,
  summarizeCloudConfig,
} = require('./config');
const {
  createExtensionTokenStore,
  loginExtensionCloud,
  logoutExtensionCloud,
  openExtensionCloudTarget,
  resolveExtensionCloudState,
} = require('./extension-auth');
const { listCloudPackageSpecifiers, loadCloudPackages } = require('./loader');
const {
  buildDeviceMetadata,
  cloudSyncDbPath,
  createLocalSyncStore,
  loadCloudSyncProjectConfig,
  resolveCloudSyncBootstrap,
  resolveRepositoryIdentity,
  saveCloudSyncProjectConfig,
} = require('./repository-sync');
const { createRepositorySyncAdapters } = require('./sync-adapters');
const { createRepositorySyncRuntime } = require('./sync-runtime');

function buildBootstrapSummary({ target, config, auth, ready, error, sync }) {
  return {
    target,
    ready,
    error: error ? (error.message || String(error)) : null,
    packages: listCloudPackageSpecifiers(),
    config: summarizeCloudConfig(config),
    auth: auth || {
      enabled: config.authMode !== 'disabled',
      authMode: config.authMode,
    },
    sync: sync || null,
  };
}

function createCloudBoundary(options = {}) {
  const target = options.target || 'cli';
  const repoRoot = options.repoRoot || process.cwd();
  const config = loadCloudConfig(options.env, options.overrides);
  const env = buildCloudEnvironment(config);
  let preloadPromise = null;

  async function getClientCloudModule() {
    const packages = await loadCloudPackages();
    return packages.clientCloud;
  }

  async function getAuthStatus() {
    const clientCloud = await getClientCloudModule();
    return clientCloud.getCloudAuthStatus(env);
  }

  async function createApiClient() {
    const clientCloud = await getClientCloudModule();
    return clientCloud.createCloudApiClient(env);
  }

  async function preload() {
    if (!preloadPromise) {
      preloadPromise = (async () => {
        await loadCloudPackages();
        const [auth, sync] = await Promise.all([
          getAuthStatus(),
          resolveCloudSyncBootstrap({ target, repoRoot, loadPackages: loadCloudPackages, config }, options.syncOptions),
        ]);
        return buildBootstrapSummary({ target, config, auth, sync, ready: true, error: null });
      })();
    }
    return preloadPromise;
  }

  const boundary = {
    target,
    repoRoot,
    config,
    env,
    summarize(error = null) {
      return buildBootstrapSummary({ target, config, auth: null, sync: null, ready: false, error });
    },
    preload,
    loadPackages: loadCloudPackages,
    async createLocalSyncStore(options = {}) {
      return createLocalSyncStore({ target, repoRoot, loadPackages: loadCloudPackages, config }, options);
    },
    async createRepositorySyncAdapters(options = {}) {
      return createRepositorySyncAdapters({
        target,
        repoRoot,
        env,
        config,
        loadPackages: loadCloudPackages,
        createLocalSyncStore: (syncOptions = {}) => createLocalSyncStore({ target, repoRoot, loadPackages: loadCloudPackages, config }, syncOptions),
        getCloudSyncDbPath: () => cloudSyncDbPath(repoRoot),
        getRepositoryIdentity: (identityOptions = {}) => resolveRepositoryIdentity({ target, repoRoot, loadPackages: loadCloudPackages, config }, identityOptions),
      }, options);
    },
    async createRepositorySyncRuntime(options = {}) {
      return createRepositorySyncRuntime({
        target,
        repoRoot,
        env,
        config,
        loadPackages: loadCloudPackages,
        createApiClient,
        createLocalSyncStore: (syncOptions = {}) => createLocalSyncStore({ target, repoRoot, loadPackages: loadCloudPackages, config }, syncOptions),
        getCloudSyncDbPath: () => cloudSyncDbPath(repoRoot),
        getRepositoryIdentity: (identityOptions = {}) => resolveRepositoryIdentity({ target, repoRoot, loadPackages: loadCloudPackages, config }, identityOptions),
        createRepositorySyncAdapters: (adapterOptions = {}) => createRepositorySyncAdapters({
          target,
          repoRoot,
          env,
          config,
          loadPackages: loadCloudPackages,
          createLocalSyncStore: (syncOptions = {}) => createLocalSyncStore({ target, repoRoot, loadPackages: loadCloudPackages, config }, syncOptions),
          getCloudSyncDbPath: () => cloudSyncDbPath(repoRoot),
          getRepositoryIdentity: (identityOptions = {}) => resolveRepositoryIdentity({ target, repoRoot, loadPackages: loadCloudPackages, config }, identityOptions),
        }, adapterOptions),
      }, options);
    },
    getCloudSyncDbPath() {
      return cloudSyncDbPath(repoRoot);
    },
    getCloudSyncProjectConfig() {
      return loadCloudSyncProjectConfig(repoRoot);
    },
    async getDeviceMetadata(options = {}) {
      return buildDeviceMetadata({ target, ...options });
    },
    async getRepositoryIdentity(options = {}) {
      return resolveRepositoryIdentity({ target, repoRoot, loadPackages: loadCloudPackages, config }, options);
    },
    async getSyncBootstrap(options = {}) {
      return resolveCloudSyncBootstrap({ target, repoRoot, loadPackages: loadCloudPackages, config }, options);
    },
    saveCloudSyncProjectConfig(updates = {}) {
      return saveCloudSyncProjectConfig(repoRoot, updates);
    },
    async getAuthStatus() {
      return getAuthStatus();
    },
    createApiClient,
  };

  return boundary;
}

module.exports = {
  DEFAULT_CLOUD_CONFIG,
  buildCloudEnvironment,
  createExtensionTokenStore,
  createCloudBoundary,
  loginExtensionCloud,
  loadCloudConfig,
  listCloudPackageSpecifiers,
  loadCloudPackages,
  logoutExtensionCloud,
  openExtensionCloudTarget,
  buildDeviceMetadata,
  cloudSyncDbPath,
  createLocalSyncStore,
  createRepositorySyncRuntime,
  createRepositorySyncAdapters,
  loadCloudSyncProjectConfig,
  resolveRepositoryIdentity,
  resolveExtensionCloudState,
  saveCloudSyncProjectConfig,
  summarizeCloudConfig,
};
