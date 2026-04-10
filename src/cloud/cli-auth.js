const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildDeviceMetadata } = require('./repository-sync');

const VALID_CONTEXT_MODES = new Set(['shared', 'branch', 'worktree', 'custom']);

const CLOUD_COMMAND_USAGE = `qapanda cloud

Commands:
  qapanda cloud login [--auth-mode pkce|device_code] [--json]
  qapanda cloud status [--json]
  qapanda cloud notifications [--state unread|all] [--json]
  qapanda cloud whoami [--json]
  qapanda cloud logout [--json]
  qapanda cloud workspace list [--json]
  qapanda cloud workspace use <workspace-id-or-slug> [--json]
  qapanda cloud context show [--json]
  qapanda cloud context use <shared|branch|worktree|custom> [context-key] [--label <label>] [--json]
  qapanda cloud context create <context-key> [--label <label>] [--json]
  qapanda cloud context open [--print-url]
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
    if (name !== 'repo' && name !== 'auth-mode' && name !== 'label' && name !== 'state') {
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

  async function runDeviceCodeLogin(fallbackFrom = null) {
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
      fallbackFrom,
    };
  }

  if (authMode === 'device_code') {
    return runDeviceCodeLogin();
  }

  try {
    const result = await packages.clientCloud.startBrowserPkceLogin(loginInput);
    return {
      method: 'pkce',
      session: result.session,
      callbackUrl: result.callbackUrl,
      filePath,
      storageMode: packages.clientCloud.inspectStoredTokenEnvelope(filePath),
      fallbackFrom: null,
    };
  } catch (error) {
    stdout.write(`Browser login unavailable. Falling back to device approval.\n`);
    return runDeviceCodeLogin('pkce');
  }
}

async function fetchCurrentActor(boundary, session) {
  const api = await boundary.createApiClient();
  return api.sdk.withHeaders({
    authorization: `Bearer ${session.tokens.accessToken}`,
  }).getCurrentActor();
}

async function resolveCliCurrentActor(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const loaded = await loadStoredCloudSession(boundary, { ...options, packages });
  const { tokenStore, filePath, storageMode, session } = loaded;
  if (!session) {
    throw new Error(`No stored QA Panda Cloud session found at ${filePath}. Run "qapanda cloud login" first.`);
  }
  try {
    const currentActor = await fetchCurrentActor(boundary, session);
    return { session, currentActor, filePath, storageMode, refreshed: false };
  } catch (error) {
    if (!session.tokens || !session.tokens.refreshToken) throw error;
    try {
      const refreshedSession = await packages.clientCloud.refreshCloudSession({
        tokenStore,
        env: boundary.env,
      });
      const currentActor = await fetchCurrentActor(boundary, refreshedSession);
      return { session: refreshedSession, currentActor, filePath, storageMode, refreshed: true };
    } catch (refreshError) {
      await packages.clientCloud.clearCloudSession(tokenStore);
      throw new Error(`Stored QA Panda Cloud session expired: ${refreshError.message || String(refreshError)}`);
    }
  }
}

async function whoamiCliCloud(boundary, options = {}) {
  return resolveCliCurrentActor(boundary, options);
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
  if (session) {
    try {
      await resolveCliCurrentActor(boundary, { ...options, packages });
    } catch (error) {
      return {
        loggedIn: false,
        filePath,
        storageMode,
        sync: null,
        repository: null,
        notificationSummary: null,
        error: error.message || String(error),
      };
    }
  }
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
    error: null,
  };
}

async function listCliCloudNotifications(boundary, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const state = options.state === 'all' ? 'all' : 'unread';
  const status = await statusCliCloud(boundary, { ...options, packages });
  if (!status.loggedIn) {
    return {
      ...status,
      state,
      notifications: {
        items: [],
        unreadCount: 0,
      },
    };
  }
  const { api } = await boundary.readCurrentActorSessionInfo();
  const notifications = await api.sdk.getNotifications(state);
  return {
    ...status,
    state,
    notifications,
  };
}

function resolveWorkspaceMembership(currentActor, selector) {
  const normalized = String(selector || '').trim();
  if (!normalized) {
    throw new Error('Usage: qapanda cloud workspace use <workspace-id-or-slug>');
  }
  const memberships = Array.isArray(currentActor && currentActor.memberships) ? currentActor.memberships : [];
  const membership = memberships.find((item) => item.workspaceId === normalized || item.slug === normalized);
  if (!membership) {
    throw new Error(`Workspace "${normalized}" is not available in the current QA Panda memberships.`);
  }
  return membership;
}

function normalizeContextMode(value) {
  const normalized = String(value || '').trim();
  if (!VALID_CONTEXT_MODES.has(normalized)) {
    throw new Error('Usage: qapanda cloud context use <shared|branch|worktree|custom> [context-key] [--label <label>]');
  }
  return normalized;
}

function resolveContextConfigInput(mode, explicitContextKey = null, contextLabel = null) {
  const contextMode = normalizeContextMode(mode);
  const contextKey = explicitContextKey == null ? null : String(explicitContextKey).trim() || null;
  const label = contextLabel == null ? null : String(contextLabel).trim() || null;
  if (contextMode === 'custom' && !contextKey) {
    throw new Error('Custom connected-project contexts require a context key.');
  }
  return {
    contextMode,
    explicitContextKey: contextMode === 'custom' ? contextKey : null,
    contextLabel: label,
  };
}

async function showCliCloudContext(boundary) {
  const repository = await boundary.getRepositoryIdentity();
  return {
    repoRoot: repository.repoRoot,
    projectConfig: repository.projectConfig,
    repository: repository.identity,
    git: repository.git,
  };
}

async function saveCliCloudContext(boundary, updates = {}, options = {}) {
  const projectConfig = await boundary.saveCloudSyncProjectConfig(updates);
  const repository = await boundary.getRepositoryIdentity();
  return {
    repoRoot: repository.repoRoot,
    projectConfig,
    repository: repository.identity,
    git: repository.git,
    created: Boolean(options.created),
  };
}

async function openCliCloudContext(boundary, options = {}) {
  const status = await statusCliCloud(boundary, options);
  const binding = status && status.sync ? status.sync.binding : null;
  if (!binding || !binding.repositoryId) {
    throw new Error('This checkout is not registered in hosted sync yet. Wait for the next sync heartbeat, then try again.');
  }
  return {
    ...status,
    url: resolveHostedRepositoryContextUrl(boundary, binding.repositoryId, binding.repositoryContextId || null),
  };
}

async function listCliCloudWorkspaces(boundary, options = {}) {
  const result = await resolveCliCurrentActor(boundary, options);
  return {
    ...result,
    memberships: Array.isArray(result.currentActor.memberships) ? result.currentActor.memberships : [],
  };
}

async function switchCliCloudWorkspace(boundary, selector, options = {}) {
  const packages = options.packages || await boundary.loadPackages();
  const identity = await resolveCliCurrentActor(boundary, { ...options, packages });
  const membership = resolveWorkspaceMembership(identity.currentActor, selector);
  const api = await boundary.createApiClient();
  const { tokenStore } = await loadStoredCloudSession(boundary, { ...options, packages });
  let activeSession = identity.session;
  try {
    await api.sdk.withHeaders({
      authorization: `Bearer ${activeSession.tokens.accessToken}`,
    }).switchWorkspace(membership.workspaceId);
  } catch (error) {
    if (!activeSession.tokens || !activeSession.tokens.refreshToken) {
      await packages.clientCloud.clearCloudSession(tokenStore);
      throw new Error('Stored QA Panda Cloud session is no longer valid. Sign in again.');
    }
    try {
      activeSession = await packages.clientCloud.refreshCloudSession({
        tokenStore,
        env: boundary.env,
      });
      await api.sdk.withHeaders({
        authorization: `Bearer ${activeSession.tokens.accessToken}`,
      }).switchWorkspace(membership.workspaceId);
    } catch (refreshError) {
      await packages.clientCloud.clearCloudSession(tokenStore);
      throw new Error(`Stored QA Panda Cloud session expired: ${refreshError.message || String(refreshError)}`);
    }
  }
  await tokenStore.save({
    ...activeSession,
    workspaceId: membership.workspaceId,
    updatedAt: new Date().toISOString(),
  });
  const next = await resolveCliCurrentActor(boundary, { ...options, packages });
  return {
    ...next,
    selectedWorkspace: membership,
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

function resolveHostedRepositoryContextUrl(boundary, repositoryId, repositoryContextId = null) {
  if (!repositoryId) throw new Error('Hosted project page requires a project id.');
  const trim = boundary.config.appBaseUrl.replace(/\/$/, '');
  const query = repositoryContextId
    ? `?contextId=${encodeURIComponent(repositoryContextId)}`
    : '';
  return `${trim}/app/projects/${encodeURIComponent(repositoryId)}${query}`;
}

function printCloudResult(value, json, stdout = process.stdout) {
  if (json) {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

function printRepositoryIdentityStatus(repository, stdout = process.stdout) {
  if (!repository) return;
  const label = repository.displayName || repository.repositorySlug || 'connected project';
  stdout.write(`Connected project identity: ${label}\n`);
  if (repository.canonicalRemoteUrl) {
    stdout.write(`Canonical remote: ${repository.canonicalRemoteUrl}\n`);
  } else if (repository.kind === 'path_fallback') {
    stdout.write('Canonical remote: local path fallback\n');
    stdout.write('Connected-project identity uses a local path fallback until this checkout has a shared remote.\n');
  }
  if (repository.repositoryKey) stdout.write(`Project key: ${repository.repositoryKey}\n`);
  if (repository.contextKey) stdout.write(`Context key: ${repository.contextKey}\n`);
  if (repository.instanceKey) stdout.write(`Instance key: ${repository.instanceKey}\n`);
}

function printRepositoryContextStatus(result, stdout = process.stdout) {
  const projectConfig = result && result.projectConfig ? result.projectConfig : null;
  const repository = result && result.repository ? result.repository : null;
  stdout.write(`Context mode: ${(projectConfig && projectConfig.contextMode) || 'shared'}\n`);
  if (projectConfig && projectConfig.contextLabel) stdout.write(`Context label: ${projectConfig.contextLabel}\n`);
  if (projectConfig && projectConfig.explicitContextKey) stdout.write(`Explicit context key: ${projectConfig.explicitContextKey}\n`);
  if (repository && repository.contextKey) stdout.write(`Resolved context key: ${repository.contextKey}\n`);
  if (result && result.git && result.git.branchName) stdout.write(`Branch: ${result.git.branchName}\n`);
  if (result && result.created) stdout.write('Saved this checkout to a named override context.\n');
}

function formatObjectCount(label, count) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function printSyncedObjectStatus(sync, stdout = process.stdout) {
  if (!sync) return;
  const counts = sync.objectCounts || { tests: 0, issues: 0, recipes: 0 };
  const total = Number(counts.tests || 0) + Number(counts.issues || 0) + Number(counts.recipes || 0);
  if (total === 0) {
    stdout.write('Synced objects: no synced tests, issues, or recipes yet.\n');
  } else {
    stdout.write(`Synced objects: ${formatObjectCount('test', Number(counts.tests || 0))}, ${formatObjectCount('issue', Number(counts.issues || 0))}, ${formatObjectCount('recipe', Number(counts.recipes || 0))}\n`);
  }
  const recentObjects = Array.isArray(sync.recentObjects) ? sync.recentObjects : [];
  if (recentObjects.length) {
    stdout.write('Recent synced objects:\n');
    recentObjects.forEach((object) => {
      const label = object && object.title ? `${object.objectType}:${object.objectId} - ${object.title}` : `${object.objectType}:${object.objectId}`;
      const updated = object && object.updatedAt ? ` (${object.updatedAt})` : '';
      stdout.write(`- ${label}${updated}\n`);
    });
  }
}

function printConflictStatus(sync, stdout = process.stdout) {
  if (!sync || !Array.isArray(sync.conflicts)) return;
  const openConflicts = sync.conflicts.filter((conflict) => conflict && conflict.status === 'open');
  if (!openConflicts.length) return;
  stdout.write('Open conflicts:\n');
  openConflicts.forEach((conflict) => {
    const summary = conflict.conflictCode ? ` - ${conflict.conflictCode}` : '';
    stdout.write(`- ${conflict.objectType || 'object'}:${conflict.objectId || 'unknown'}${summary}\n`);
  });
}

function printCliNotificationList(result, stdout = process.stdout) {
  const notifications = result && result.notifications ? result.notifications : null;
  const items = notifications && Array.isArray(notifications.items) ? notifications.items : [];
  const unreadCount = notifications ? Number(notifications.unreadCount || 0) : 0;
  const state = result && result.state === 'all' ? 'all' : 'unread';
  const scopeLabel = state === 'all' ? 'all notifications' : 'unread notifications';
  stdout.write(`Cloud notifications: ${unreadCount} unread (${scopeLabel})\n`);
  if (!items.length) {
    stdout.write(`- No ${scopeLabel}.\n`);
    return;
  }
  items.forEach((item) => {
    const parts = [`- [${item.eventKey}] ${item.title}`];
    if (item.body) parts.push(item.body);
    if (item.actionUrl) parts.push(`Open: ${item.actionUrl}`);
    stdout.write(`${parts.join(' - ')}\n`);
  });
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
    if (result.fallbackFrom === 'pkce') {
      stdout.write('Used device approval because browser login was unavailable.\n');
    }
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
    if (Array.isArray(result.currentActor.memberships) && result.currentActor.memberships.length > 0) {
      stdout.write(`Memberships: ${result.currentActor.memberships.map((item) => `${item.name} (${item.slug})`).join(', ')}\n`);
    }
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
      if (result.error) stdout.write(`${result.error}\n`);
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
      printRepositoryIdentityStatus(result.repository, stdout);
      stdout.write(`Pending mutations: ${result.sync.pendingMutationCount}\n`);
      printSyncedObjectStatus(result.sync, stdout);
      printConflictStatus(result.sync, stdout);
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

  if (subcommand === 'notifications') {
    const state = parsed.options.state === 'all' ? 'all' : 'unread';
    const result = await listCliCloudNotifications(boundary, {
      env: options.env,
      state,
    });
    if (parsed.options.json) {
      printCloudResult(result, true, stdout);
      return;
    }
    if (!result.loggedIn) {
      stdout.write('QA Panda Cloud is signed out.\n');
      stdout.write(`Session file: ${result.filePath}\n`);
      if (result.error) stdout.write(`${result.error}\n`);
      return;
    }
    printCliNotificationList(result, stdout);
    const inboxUrl = (result.notificationSummary && result.notificationSummary.inboxUrl)
      || resolveHostedCloudUrl(boundary, 'notifications');
    stdout.write(`Inbox: ${inboxUrl}\n`);
    return;
  }

  if (subcommand === 'workspace') {
    const workspaceCommand = parsed.positionals[1];
    if (!workspaceCommand || workspaceCommand === 'help') {
      stdout.write('Usage:\n  qapanda cloud workspace list [--json]\n  qapanda cloud workspace use <workspace-id-or-slug> [--json]\n');
      return;
    }
    if (workspaceCommand === 'list') {
      const result = await listCliCloudWorkspaces(boundary, { env: options.env });
      if (parsed.options.json) {
        printCloudResult(result, true, stdout);
        return;
      }
      stdout.write(`Current workspace: ${result.currentActor.currentWorkspace.name} (${result.currentActor.currentWorkspace.slug})\n`);
      result.memberships.forEach((membership) => {
        const marker = membership.workspaceId === result.currentActor.currentWorkspace.workspaceId ? '*' : '-';
        stdout.write(`${marker} ${membership.name} (${membership.slug}) [${membership.roleKey}]\n`);
      });
      return;
    }
    if (workspaceCommand === 'use') {
      const selector = parsed.positionals[2];
      const result = await switchCliCloudWorkspace(boundary, selector, { env: options.env });
      if (parsed.options.json) {
        printCloudResult(result, true, stdout);
        return;
      }
      const workspace = result.currentActor.currentWorkspace;
      stdout.write(`Switched QA Panda Cloud workspace to ${workspace.name} (${workspace.slug}).\n`);
      if (result.refreshed) stdout.write('Session was refreshed before switching workspaces.\n');
      return;
    }
    throw new Error(`Unknown workspace command: ${workspaceCommand}`);
  }

  if (subcommand === 'context') {
    const contextCommand = parsed.positionals[1];
    if (!contextCommand || contextCommand === 'help') {
      stdout.write('Usage:\n  qapanda cloud context show [--json]\n  qapanda cloud context use <shared|branch|worktree|custom> [context-key] [--label <label>] [--json]\n  qapanda cloud context create <context-key> [--label <label>] [--json]\n  qapanda cloud context open [--print-url]\n');
      return;
    }
    if (contextCommand === 'show') {
      const result = await showCliCloudContext(boundary);
      if (parsed.options.json) {
        printCloudResult(result, true, stdout);
        return;
      }
      printRepositoryContextStatus(result, stdout);
      printRepositoryIdentityStatus(result.repository, stdout);
      return;
    }
    if (contextCommand === 'use') {
      const mode = parsed.positionals[2];
      const contextKey = parsed.positionals[3] || null;
      const result = await saveCliCloudContext(
        boundary,
        resolveContextConfigInput(mode, contextKey, parsed.options.label || null),
      );
      if (parsed.options.json) {
        printCloudResult(result, true, stdout);
        return;
      }
      stdout.write('Saved connected-project context for this checkout.\n');
      printRepositoryContextStatus(result, stdout);
      printRepositoryIdentityStatus(result.repository, stdout);
      return;
    }
    if (contextCommand === 'create') {
      const contextKey = String(parsed.positionals[2] || '').trim();
      if (!contextKey) {
        throw new Error('Usage: qapanda cloud context create <context-key> [--label <label>] [--json]');
      }
      const result = await saveCliCloudContext(
        boundary,
        resolveContextConfigInput('custom', contextKey, parsed.options.label || null),
        { created: true },
      );
      if (parsed.options.json) {
        printCloudResult(result, true, stdout);
        return;
      }
      stdout.write(`Created named connected-project context ${contextKey} for this checkout.\n`);
      printRepositoryContextStatus(result, stdout);
      printRepositoryIdentityStatus(result.repository, stdout);
      return;
    }
    if (contextCommand === 'open') {
      const result = await openCliCloudContext(boundary, { env: options.env });
      if (parsed.options['print-url']) {
        stdout.write(`${result.url}\n`);
        return;
      }
      const openExternal = options.openExternal || defaultOpenExternal;
      await openExternal(result.url);
      stdout.write(`Opened ${result.url}\n`);
      return;
    }
    throw new Error(`Unknown context command: ${contextCommand}`);
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
  listCliCloudNotifications,
  listCliCloudWorkspaces,
  logoutCliCloud,
  openCliCloudContext,
  parseCloudArgs,
  resolveCloudEncryptionKey,
  resolveContextConfigInput,
  resolveCloudSessionFilePath,
  resolveHostedCloudUrl,
  resolveHostedRepositoryContextUrl,
  runCloudCommand,
  saveCliCloudContext,
  showCliCloudContext,
  statusCliCloud,
  switchCliCloudWorkspace,
  whoamiCliCloud,
};
