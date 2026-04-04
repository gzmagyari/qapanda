const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execForText } = require('../process-utils');
const {
  ensureProjectStateDir,
  loadProjectConfig,
  projectStateDir,
  saveProjectConfig,
} = require('../project-context');

const DEFAULT_REPOSITORY_CONTEXT_MODE = 'shared';
const VALID_REPOSITORY_CONTEXT_MODES = new Set(['shared', 'branch', 'worktree', 'custom']);

function trimOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeRepositoryContextMode(value) {
  const normalized = String(value || '').trim();
  return VALID_REPOSITORY_CONTEXT_MODES.has(normalized)
    ? normalized
    : DEFAULT_REPOSITORY_CONTEXT_MODE;
}

function runtimeStateDir(repoRoot) {
  return path.join(projectStateDir(repoRoot), 'runtime');
}

function cloudSyncDbPath(repoRoot) {
  return path.join(runtimeStateDir(repoRoot), 'cloud-sync.sqlite');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function hashLocalPath(localPath) {
  return hashValue(path.resolve(localPath));
}

function loadCloudSyncProjectConfig(repoRoot) {
  const config = loadProjectConfig(repoRoot);
  return {
    contextMode: normalizeRepositoryContextMode(config.cloudContextMode),
    explicitContextKey: trimOptionalString(config.cloudContextKey),
    contextLabel: trimOptionalString(config.cloudContextLabel),
  };
}

function saveCloudSyncProjectConfig(repoRoot, updates = {}) {
  const current = loadCloudSyncProjectConfig(repoRoot);
  const next = {
    cloudContextMode: normalizeRepositoryContextMode(
      updates.contextMode === undefined ? current.contextMode : updates.contextMode
    ),
    cloudContextKey: trimOptionalString(
      updates.explicitContextKey === undefined ? current.explicitContextKey : updates.explicitContextKey
    ),
    cloudContextLabel: trimOptionalString(
      updates.contextLabel === undefined ? current.contextLabel : updates.contextLabel
    ),
  };
  saveProjectConfig(repoRoot, next);
  return loadCloudSyncProjectConfig(repoRoot);
}

async function readGitValue(repoRoot, args) {
  const result = await execForText('git', args, { cwd: repoRoot });
  if (result.code !== 0) return null;
  const value = String(result.stdout || '').trim();
  return value || null;
}

async function resolveGitRepositoryMetadata(repoRoot, options = {}) {
  const localPath = path.resolve(options.localPath || repoRoot);
  const remoteUrl = trimOptionalString(options.remoteUrl) || await readGitValue(repoRoot, ['config', '--get', 'remote.origin.url']);
  let branchName = trimOptionalString(options.branchName);
  if (!branchName) {
    branchName = await readGitValue(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branchName === 'HEAD') {
      branchName = await readGitValue(repoRoot, ['branch', '--show-current']);
    }
  }
  return {
    localPath,
    remoteUrl: trimOptionalString(remoteUrl),
    branchName: trimOptionalString(branchName),
  };
}

function defaultAppNameForTarget(target) {
  if (target === 'extension') return 'VS Code';
  if (target === 'web') return 'QA Panda Web';
  return null;
}

function buildDeviceMetadata(options = {}) {
  const hostLabel = trimOptionalString(options.hostLabel) || os.hostname();
  const username = trimOptionalString(options.username) || (() => {
    try {
      return os.userInfo().username || 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  const appName = trimOptionalString(options.appName) || defaultAppNameForTarget(options.target);
  const appVersion = trimOptionalString(options.appVersion);
  const platform = trimOptionalString(options.platform) || os.platform();
  const release = trimOptionalString(options.release) || os.release();
  const arch = trimOptionalString(options.arch) || process.arch;
  const deviceName = trimOptionalString(options.deviceName)
    || `${hostLabel} (${appName || username})`;
  const machineFingerprint = trimOptionalString(options.machineFingerprint)
    || hashValue([hostLabel, username, appName || 'cli', platform, release, arch].join('|'));
  const platformLabel = trimOptionalString(options.platformLabel)
    || (appName
      ? `${appName}${appVersion ? ` ${appVersion}` : ''} on ${platform} ${release}`
      : `${platform} ${release}`);
  return {
    deviceName,
    machineFingerprint,
    platformLabel,
    hostLabel,
  };
}

function summarizeRepositoryIdentity(identity, metadata, projectConfig, dbPath) {
  return {
    kind: identity.kind,
    repositoryKey: identity.repositoryKey,
    contextKey: identity.contextKey,
    instanceKey: identity.instanceKey,
    canonicalRemoteUrl: identity.canonicalRemoteUrl,
    displayName: identity.displayName,
    repositorySlug: identity.repositorySlug,
    contextLabel: identity.contextLabel,
    contextMode: identity.contextMode,
    branchName: identity.branchName,
    localPath: metadata.localPath,
    localPathHash: hashLocalPath(metadata.localPath),
    remoteUrl: metadata.remoteUrl,
    syncDbPath: dbPath,
    syncDbExists: fs.existsSync(dbPath),
    explicitContextKey: projectConfig.explicitContextKey,
  };
}

async function resolveRepositoryIdentity(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const repoRoot = path.resolve(options.repoRoot || boundary.repoRoot || process.cwd());
  const projectConfig = loadCloudSyncProjectConfig(repoRoot);
  const metadata = options.git
    ? {
        ...options.git,
        localPath: path.resolve(options.git.localPath || repoRoot),
      }
    : await resolveGitRepositoryMetadata(repoRoot, options);
  const contextMode = normalizeRepositoryContextMode(options.contextMode || projectConfig.contextMode);
  const explicitContextKey = trimOptionalString(options.explicitContextKey ?? projectConfig.explicitContextKey);
  const contextLabel = trimOptionalString(options.contextLabel ?? projectConfig.contextLabel);
  const identityInput = {
    localPath: metadata.localPath || repoRoot,
    ...(metadata.remoteUrl ? { remoteUrl: metadata.remoteUrl } : {}),
    ...(metadata.branchName ? { branchName: metadata.branchName } : {}),
    contextMode,
    ...(explicitContextKey ? { explicitContextKey } : {}),
    ...(contextLabel ? { contextLabel } : {}),
  };
  const identity = packages.syncCore.computeRepositoryIdentity(identityInput);
  return {
    repoRoot,
    projectConfig: {
      contextMode,
      explicitContextKey,
      contextLabel,
    },
    git: metadata,
    identity,
    localPathHash: hashLocalPath(identityInput.localPath),
    syncDbPath: cloudSyncDbPath(repoRoot),
  };
}

async function createLocalSyncStore(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const repoRoot = path.resolve(options.repoRoot || boundary.repoRoot || process.cwd());
  const dbPath = path.resolve(options.dbPath || cloudSyncDbPath(repoRoot));
  ensureProjectStateDir(repoRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = packages.clientCloud.createCloudSyncStateStoreFacade({ dbPath });
  return { store, dbPath };
}

async function resolveCloudSyncBootstrap(boundary, options = {}) {
  const repoState = await resolveRepositoryIdentity(boundary, options);
  const device = buildDeviceMetadata({
    target: boundary.target,
    appName: options.appName,
    appVersion: options.appVersion,
    deviceName: options.deviceName,
    machineFingerprint: options.machineFingerprint,
    platformLabel: options.platformLabel,
    hostLabel: options.hostLabel,
    username: options.username,
    platform: options.platform,
    release: options.release,
    arch: options.arch,
  });
  return {
    repository: summarizeRepositoryIdentity(
      repoState.identity,
      repoState.git,
      repoState.projectConfig,
      repoState.syncDbPath
    ),
    device,
  };
}

module.exports = {
  DEFAULT_REPOSITORY_CONTEXT_MODE,
  VALID_REPOSITORY_CONTEXT_MODES,
  buildDeviceMetadata,
  cloudSyncDbPath,
  createLocalSyncStore,
  hashLocalPath,
  loadCloudSyncProjectConfig,
  normalizeRepositoryContextMode,
  resolveCloudSyncBootstrap,
  resolveGitRepositoryMetadata,
  resolveRepositoryIdentity,
  runtimeStateDir,
  saveCloudSyncProjectConfig,
};
