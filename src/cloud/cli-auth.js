const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildDeviceMetadata } = require('./repository-sync');

const CLOUD_COMMAND_USAGE = `qapanda cloud

Commands:
  qapanda cloud login [--auth-mode pkce|device_code] [--json]
  qapanda cloud status [--json]
  qapanda cloud whoami [--json]
  qapanda cloud logout [--json]
  qapanda cloud open [app|runs|run <run-id>|notifications] [--print-url]`;

function normalizeCloudAuthMode(value) {
  const normalized = String(value || '').trim();
  if (normalized === 'pkce' || normalized === 'device_code') return normalized;
  return null;
}

function parseCloudArgs(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'json' || name === 'print-url') {
      options[name] = true;
      continue;
    }
    if (name !== 'repo' && name !== 'auth-mode') {
      throw new Error(`Unknown option: --${name}`);
    }
    const value = argv[index + 1];
    if (value == null) throw new Error(`Option --${name} requires a value.`);
    index += 1;
    options[name] = value;
  }

  return { options, positionals };
}

function resolveCloudSessionFilePath(env = process.env) {
  const configured = env.QAPANDA_CLOUD_SESSION_FILE;
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), '.qpanda', 'cloud', 'session.json');
}

function resolveCloudEncryptionKey(env = process.env, filePath = resolveCloudSessionFilePath(env)) {
  if (env.QAPANDA_CLOUD_SESSION_KEY) return env.QAPANDA_CLOUD_SESSION_KEY;
  let username = 'unknown';
  try {
    username = os.userInfo().username || username;
  } catch {}
  return [
    'qapanda-cloud-session',
    process.platform,
    process.arch,
    os.hostname(),
    username,
    filePath,
  ].join('|');
}

function defaultDeviceName() {
  return buildDeviceMetadata({ target: 'cli' }).deviceName;
}

function defaultMachineFingerprint() {
  return buildDeviceMetadata({ target: 'cli' }).machineFingerprint;
}

function defaultPlatformLabel() {
  return buildDeviceMetadata({ target: 'cli' }).platformLabel;
}

function defaultOpenExternal(url) {
  return new Promise((resolve, reject) => {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { stdio: 'ignore' });
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function createCliTokenStore(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const env = options.env || process.env;
  const filePath = options.filePath || resolveCloudSessionFilePath(env);
  const encryptionKey = options.encryptionKey || resolveCloudEncryptionKey(env, filePath);
  const tokenStore = packages.clientCloud.createPreferredTokenStore({
    filePath,
    encryptionKey,
  });
  return {
    tokenStore,
    filePath,
    storageMode: packages.clientCloud.inspectStoredTokenEnvelope(filePath),
  };
}

async function loadStoredCloudSession(boundary, options = {}) {
  const { tokenStore, filePath, storageMode } = await createCliTokenStore(boundary, options);
  const session = await tokenStore.load();
  return { tokenStore, filePath, storageMode, session };
}

async function loginCliCloud(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const stdout = options.stdout || process.stdout;
  const openExternal = options.openExternal || defaultOpenExternal;
  const authMode = normalizeCloudAuthMode(options.authMode)
    || (boundary.config.authMode === 'disabled' ? 'pkce' : boundary.config.authMode);
  const { tokenStore, filePath } = await createCliTokenStore(boundary, { ...options, packages });
  const api = await boundary.createApiClient();
  const device = buildDeviceMetadata({
    target: 'cli',
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

  if (authMode === 'device_code') {
    let announced = false;
    const result = await packages.clientCloud.startDeviceCodeLogin({
      ...loginInput,
      onPending(payload) {
        if (announced) return;
        announced = true;
        stdout.write(`Open this URL to approve the device:\n${payload.verificationUri}\n`);
        if (payload.userCode) stdout.write(`User code: ${payload.userCode}\n`);
      },
    });
    return {
      method: 'device_code',
      session: result.session,
      verificationUri: result.verificationUri,
      userCode: result.userCode,
      filePath,
      storageMode: packages.clientCloud.inspectStoredTokenEnvelope(filePath),
    };
  }

  const result = await packages.clientCloud.startBrowserPkceLogin(loginInput);
  return {
    method: 'pkce',
    session: result.session,
    callbackUrl: result.callbackUrl,
    filePath,
    storageMode: packages.clientCloud.inspectStoredTokenEnvelope(filePath),
  };
}

async function fetchCurrentActor(boundary, session) {
  const api = await boundary.createApiClient();
  return api.sdk.withHeaders({
    authorization: `Bearer ${session.tokens.accessToken}`,
  }).getCurrentActor();
}

async function whoamiCliCloud(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const { tokenStore, filePath, storageMode, session } = await loadStoredCloudSession(boundary, { ...options, packages });
  if (!session) {
    throw new Error(`No stored QA Panda Cloud session found at ${filePath}. Run "qapanda cloud login" first.`);
  }
  try {
    const currentActor = await fetchCurrentActor(boundary, session);
    return { session, currentActor, filePath, storageMode, refreshed: false };
  } catch (error) {
    if (!session.tokens || !session.tokens.refreshToken) throw error;
    const refreshed = await packages.clientCloud.refreshCloudSession({ tokenStore });
    const currentActor = await fetchCurrentActor(boundary, refreshed);
    return { session: refreshed, currentActor, filePath, storageMode, refreshed: true };
  }
}

async function logoutCliCloud(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const { tokenStore, filePath, storageMode, session } = await loadStoredCloudSession(boundary, { ...options, packages });
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
  return { hadSession: Boolean(session), revokedRemotely, filePath, storageModeBeforeClear: storageMode };
}

async function statusCliCloud(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const { filePath, storageMode, session } = await loadStoredCloudSession(boundary, { ...options, packages });
  const runtime = await boundary.createRepositorySyncRuntime({
    disableTimers: true,
    ...options.runtimeOptions,
  });
  let syncStatus;
  try {
    syncStatus = await runtime.start();
  } finally {
    await runtime.stop();
  }
  return {
    loggedIn: Boolean(session),
    filePath,
    storageMode,
    sync: syncStatus,
    repository: syncStatus.repository || null,
    notificationSummary: syncStatus.notificationSummary || null,
  };
}

function resolveHostedCloudUrl(boundary, target, id = null) {
  const targetName = target || 'app';
  const apiBase = boundary.config.appBaseUrl;
  const trim = apiBase.replace(/\/$/, '');
  if (targetName === 'app') return `${trim}/app`;
  if (targetName === 'runs') return `${trim}/app/runs`;
  if (targetName === 'notifications') return `${trim}/app/notifications`;
  if (targetName === 'run') {
    if (!id) throw new Error('Usage: qapanda cloud open run <run-id>');
    return `${trim}/app/runs/${encodeURIComponent(id)}`;
  }
  throw new Error(`Unknown cloud open target: ${targetName}`);
}

function printCloudResult(value, json, stdout = process.stdout) {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

async function runCloudCommand(argv, options = {}) {
  const { createCloudBoundary } = options.cloudModule || require('./index');
  const stdout = options.stdout || process.stdout;
  const repoRoot = options.repoRoot || process.cwd();
  const parsed = parseCloudArgs(argv);
  const subcommand = parsed.positionals[0];
  const boundary = createCloudBoundary({
    target: 'cli',
    repoRoot: parsed.options.repo ? path.resolve(parsed.options.repo) : repoRoot,
    env: options.env,
  });

  if (!subcommand || subcommand === 'help') {
    stdout.write(`${CLOUD_COMMAND_USAGE}\n`);
    return;
  }

  if (subcommand === 'login') {
    const result = await loginCliCloud(boundary, {
      env: options.env,
      authMode: parsed.options['auth-mode'],
      openExternal: options.openExternal,
      stdout,
    });
    if (parsed.options.json) {
      printCloudResult(result, true, stdout);
      return;
    }
    stdout.write(`Logged into QA Panda Cloud via ${result.method}.\n`);
    stdout.write(`Session file: ${result.filePath}\n`);
    stdout.write(`Storage mode: ${result.storageMode}\n`);
    stdout.write(`Email: ${result.session.email}\n`);
    stdout.write(`Workspace: ${result.session.workspaceId}\n`);
    return;
  }

  if (subcommand === 'whoami') {
    const result = await whoamiCliCloud(boundary, { env: options.env });
    if (parsed.options.json) {
      printCloudResult(result, true, stdout);
      return;
    }
    const actor = result.currentActor.actor;
    const workspace = result.currentActor.currentWorkspace;
    stdout.write(`Signed in as ${actor.email}${actor.displayName ? ` (${actor.displayName})` : ''}\n`);
    stdout.write(`Workspace: ${workspace.name} (${workspace.slug})\n`);
    stdout.write(`Role: ${workspace.roleKey}\n`);
    stdout.write(`Plan: ${workspace.planTier}\n`);
    stdout.write(`Session file: ${result.filePath}\n`);
    stdout.write(`Storage mode: ${result.storageMode}\n`);
    if (result.refreshed) stdout.write('Session was refreshed before reading identity.\n');
    return;
  }

  if (subcommand === 'status') {
    const packages = await boundary.loadPackages();
    const result = await statusCliCloud(boundary, { env: options.env, packages });
    if (parsed.options.json) {
      printCloudResult(result, true, stdout);
      return;
    }
    if (!result.loggedIn) {
      stdout.write('QA Panda Cloud is signed out.\n');
      stdout.write(`Session file: ${result.filePath}\n`);
      return;
    }
    stdout.write(`${packages.clientCloud.renderCliSyncStatus(result.sync.indicator, result.sync.conflicts || [])}\n`);
    if (result.repository && result.repository.projectConfig) {
      const projectConfig = result.repository.projectConfig;
      stdout.write(`Context mode: ${projectConfig.contextMode}\n`);
      if (projectConfig.contextLabel) {
        stdout.write(`Context label: ${projectConfig.contextLabel}\n`);
      }
    }
    stdout.write(`Pending mutations: ${result.sync.pendingMutationCount}\n`);
    if (result.sync.lastSyncedAt) {
      stdout.write(`Last synced: ${result.sync.lastSyncedAt}\n`);
    }
    if (result.notificationSummary) {
      stdout.write(`${packages.clientCloud.renderCliNotificationSummary(result.notificationSummary)}\n`);
    }
    stdout.write(`Session file: ${result.filePath}\n`);
    stdout.write(`Storage mode: ${result.storageMode}\n`);
    return;
  }

  if (subcommand === 'logout') {
    const result = await logoutCliCloud(boundary, { env: options.env });
    if (parsed.options.json) {
      printCloudResult(result, true, stdout);
      return;
    }
    if (!result.hadSession) {
      stdout.write('No stored QA Panda Cloud session was present.\n');
      return;
    }
    stdout.write('Logged out of QA Panda Cloud.\n');
    stdout.write(`Remote revoke: ${result.revokedRemotely ? 'ok' : 'best-effort only'}\n`);
    return;
  }

  if (subcommand === 'open') {
    const target = parsed.positionals[1] || 'app';
    const id = target === 'run' ? parsed.positionals[2] : null;
    const url = resolveHostedCloudUrl(boundary, target, id);
    if (parsed.options['print-url']) {
      stdout.write(`${url}\n`);
      return;
    }
    const openExternal = options.openExternal || defaultOpenExternal;
    await openExternal(url);
    stdout.write(`Opened ${url}\n`);
    return;
  }

  throw new Error(`Unknown cloud command: ${subcommand}\n\n${CLOUD_COMMAND_USAGE}`);
}

module.exports = {
  CLOUD_COMMAND_USAGE,
  createCliTokenStore,
  defaultMachineFingerprint,
  defaultOpenExternal,
  defaultPlatformLabel,
  defaultDeviceName,
  loadStoredCloudSession,
  loginCliCloud,
  logoutCliCloud,
  parseCloudArgs,
  resolveCloudEncryptionKey,
  resolveCloudSessionFilePath,
  resolveHostedCloudUrl,
  runCloudCommand,
  statusCliCloud,
  whoamiCliCloud,
};
