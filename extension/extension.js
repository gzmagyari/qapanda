// ── Activation debug logger (writes to %TEMP%/cc-ext-activate-debug.log) ──
const _activateLog = require('path').join(require('os').tmpdir(), 'cc-ext-activate-debug.log');
function _aDbg(msg) {
  try { require('fs').appendFileSync(_activateLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let WebviewRenderer, SessionManager;
let globalAgentsPath, projectAgentsPath, systemAgentsOverridePath, loadAgentsFile, saveAgentsFile, loadSystemAgents, loadMergedAgents;
let loadMergedModes, saveModesFile, globalModesPath, projectModesPath, systemModesOverridePath, loadModesFile;
let findExistingDesktop, instanceName, stopInstance, clearPanel;
let globalMcpPath, projectMcpPath, loadMcpFile, saveMcpFile, queueProjectMcpSyncChanges, loadMergedMcpServers, handleProjectContextMessage, handleTaskMessage, handleTestMessage, handleAgentMessage, handleModeMessage, handleInstanceMessage;
let startTasksMcpServer, stopTasksMcpServer;
let startTestsMcpServer, stopTestsMcpServer;
let startMemoryMcpServer, stopMemoryMcpServer;
let startQaDesktopMcpServer, stopQaDesktopMcpServer;
let loadOnboarding, isOnboardingComplete, runFullDetection, completeOnboarding, runAutoFix;
let loadSettings, saveSettings;
let buildSelfTestingPrompt;
let loadFeatureFlags;
let exportQaReportPdf;
let buildApiCatalogPayload;
let createCloudBoundary;
let loginExtensionCloud, logoutExtensionCloud, openExtensionCloudTarget, resolveExtensionCloudState, switchExtensionCloudWorkspace;
let killChrome, killAllChrome;
let closeAllCodexConnections;
let cleanupPanelSession, shutdownExtensionResources;
let createReadyGate;
let ensureRootMcpPorts;
let ensureNamedWorkspace, listNamedWorkspaces, createRepoRootDescriptor, normalizeWorkspaceName;
let _cloudSyncRuntime = null;
let _cloudSyncStartPromise = null;
let _cloudStatusBarItem = null;

function appendPanelDebugLog(repoRoot, text) {
  const candidates = [];
  if (repoRoot) {
    candidates.push(path.join(repoRoot, '.qpanda', 'wizard-debug.log'));
  }
  candidates.push(path.join(os.homedir(), '.qpanda', 'wizard-debug.log'));
  for (const logPath of candidates) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${text}\n`);
      return;
    } catch {}
  }
}

function remoteDesktopEnabled(context, repoRoot) {
  try {
    return !!loadFeatureFlags(context.extensionUri.fsPath, repoRoot).enableRemoteDesktop;
  } catch {
    return false;
  }
}

try {
  ({ WebviewRenderer } = require('./webview-renderer'));
  _aDbg('require OK: webview-renderer');
  ({ SessionManager } = require('./session-manager'));
  _aDbg('require OK: session-manager');
  ({ globalAgentsPath, projectAgentsPath, systemAgentsOverridePath, loadAgentsFile, saveAgentsFile, loadSystemAgents, loadMergedAgents } = require('./agents-store'));
  _aDbg('require OK: agents-store');
  ({ loadMergedModes, saveModesFile, globalModesPath, projectModesPath, systemModesOverridePath, loadModesFile } = require('./modes-store'));
  _aDbg('require OK: modes-store');
  ({ findExistingDesktop, instanceName, stopInstance, clearPanel } = require('./src/remote-desktop'));
  _aDbg('require OK: remote-desktop');
  ({ globalMcpPath, projectMcpPath, loadMcpFile, saveMcpFile, queueProjectMcpSyncChanges, loadMergedMcpServers, handleProjectContextMessage, handleTaskMessage, handleTestMessage, handleAgentMessage, handleModeMessage, handleInstanceMessage } = require('./message-handlers'));
  _aDbg('require OK: message-handlers');
  ({ startTasksMcpServer, stopTasksMcpServer } = require('./tasks-mcp-http'));
  _aDbg('require OK: tasks-mcp-http');
  ({ startTestsMcpServer, stopTestsMcpServer } = require('./tests-mcp-http'));
  _aDbg('require OK: tests-mcp-http');
  ({ startMemoryMcpServer, stopMemoryMcpServer } = require('./memory-mcp-http'));
  _aDbg('require OK: memory-mcp-http');
  ({ startQaDesktopMcpServer, stopQaDesktopMcpServer } = require('./qa-desktop-mcp-server'));
  _aDbg('require OK: qa-desktop-mcp-server');
  ({ loadOnboarding, isOnboardingComplete, runFullDetection, completeOnboarding, runAutoFix } = require('./onboarding'));
  _aDbg('require OK: onboarding');
  ({ loadSettings, saveSettings } = require('./settings-store'));
  _aDbg('require OK: settings-store');
  ({ buildSelfTestingPrompt } = require('./src/prompts'));
  _aDbg('require OK: prompts');
  ({ buildApiCatalogPayload } = require('./src/model-catalog'));
  _aDbg('require OK: model-catalog');
  ({ loadFeatureFlags } = require('./src/feature-flags'));
  ({ createCloudBoundary, loginExtensionCloud, logoutExtensionCloud, openExtensionCloudTarget, resolveExtensionCloudState, switchExtensionCloudWorkspace } = require('./src/cloud'));
  ({ exportQaReportPdf } = require('./qa-report-export'));
  ({ killChrome, killAll: killAllChrome } = require('./chrome-manager'));
  ({ closeAllConnections: closeAllCodexConnections } = require('./src/codex-app-server'));
  ({ cleanupPanelSession, shutdownExtensionResources } = require('./lifecycle-utils'));
  ({ createReadyGate } = require('./ready-gate'));
  ({ ensureRootMcpPorts } = require('./root-mcp-ports'));
  ({ ensureNamedWorkspace, listNamedWorkspaces, createRepoRootDescriptor, normalizeWorkspaceName } = require('./src/named-workspaces'));
  _aDbg('All top-level requires succeeded');
} catch (e) {
  _aDbg(`TOP-LEVEL REQUIRE FAILED: ${e.message}\n${e.stack}`);
  throw e;
}

const activePanels = new Set();
let _tasksMcpPort = null;
let _testsMcpPort = null;
let _memoryMcpPort = null;
let _qaDesktopMcpPort = null;

async function handleQaReportExportMessage(msg, repoRoot) {
  if (!msg || msg.type !== 'qaReportExportPdf') return false;
  try {
    const result = await exportQaReportPdf({
      repoRoot,
      label: msg.label || 'QA Report',
      scope: msg.scope || 'run',
      updatedAt: msg.updatedAt || '',
      section: msg.section || {},
    });
    if (!result || result.canceled) {
      return true;
    }
    await vscode.window.showInformationMessage(`QA report saved to ${result.filePath}`);
  } catch (error) {
    await vscode.window.showErrorMessage(`Failed to export QA report PDF: ${error && error.message ? error.message : String(error)}`);
  }
  return true;
}

function createPanelReadyHandler({
  session,
  panel,
  renderer,
  repoRoot,
  stateRoot = null,
  workspaceName = null,
  rootKind = 'repo',
  rootIdentity = null,
  panelConfig,
  cloudBoundary,
  context,
  extensionPath,
  loadCloudBootstrap,
  savedRunId = null,
  savedResume = null,
  savedAgent = null,
  savedSaveResumeAs = null,
  debugLog,
  appendLogPrefix,
}) {
  return createReadyGate(async (msg, readySessionId) => {
    const initialCloudSession = buildFallbackCloudSessionPayload(cloudBoundary);
    const initialCloudStatus = buildFallbackCloudStatusPayload(cloudBoundary, initialCloudSession);
    const cloud = cloudBoundary.summarize();

    appendPanelDebugLog(
      repoRoot,
      `${appendLogPrefix}: ready message received repoRoot=${repoRoot} runId=${msg.runId || ''}` +
        `${savedRunId ? ` savedRunId=${savedRunId}` : ''} panelId=${msg.panelId || ''} readySessionId=${readySessionId}`
    );
    try {
      panel.webview.postMessage({ type: 'readyAck', readySessionId });
    } catch {}

    debugLog(`ready: msg.panelId=${msg.panelId} current _panelId=${session._panelId} readySessionId=${readySessionId}`);
    if (msg.panelId) session._panelId = msg.panelId;
    debugLog(`ready: after restore _panelId=${session._panelId} readySessionId=${readySessionId}`);

    const mcpData = loadMergedMcpServers(repoRoot);
    const agentsData = loadMergedAgents(repoRoot, extensionPath);
    const modesData = loadMergedModes(repoRoot, extensionPath);
    const onboardingData = loadOnboarding();
    const requestedResume = msg.resume || savedResume || session.getPanelContext().resume || null;
    session.applyLaunchContext({
      workspace: workspaceName,
      rootKind,
      rootIdentity,
      resume: requestedResume,
      saveResumeAs: savedSaveResumeAs || null,
    });

    const initialAgent = normalizeStartupAgent(msg.agent || savedAgent || null);
    if (initialAgent) {
      panelConfig.chatTarget = initialAgent;
      session.applyConfig({ chatTarget: initialAgent });
    }

    let requestedRunId = msg.runId || savedRunId || null;
    if (requestedResume) {
      const resolvedResume = await session._resolveResumeSpecifier(requestedResume, {
        allowPendingAlias: true,
        chatTarget: initialAgent || null,
      });
      if (resolvedResume.kind === 'alias' || resolvedResume.kind === 'run') {
        requestedRunId = resolvedResume.runId;
        session.applyLaunchContext({
          resume: resolvedResume.kind === 'alias' ? resolvedResume.alias : resolvedResume.runId,
          pendingResumeAlias: null,
          saveResumeAs: null,
        });
      } else if (resolvedResume.kind === 'pending-alias' || resolvedResume.kind === 'stale-alias') {
        session.applyLaunchContext({
          resume: resolvedResume.alias,
          pendingResumeAlias: resolvedResume.alias,
          saveResumeAs: null,
        });
        if (session.getRunId()) {
          await session._resetAttachedRunForLaunch();
        }
        requestedRunId = null;
      }
    }

    const reattached = requestedRunId ? await session.reattachRun(requestedRunId, { suppressUi: true }) : false;
    if (initialAgent) {
      panelConfig.chatTarget = initialAgent;
      session.applyConfig({ chatTarget: initialAgent });
    }
    if (reattached) Object.assign(panelConfig, session.getConfig());

    const initConfigMessage = {
      type: 'initConfig',
      config: reattached ? session.getConfig() : panelConfig,
      mcpServers: mcpData,
      agents: agentsData,
      modes: modesData,
      panelId: session.panelId,
      runId: reattached ? session.getRunId() : null,
      workspace: workspaceName || null,
      resume: session.getPanelContext().resume || null,
      rootIdentity: rootIdentity || null,
      onboarding: { complete: isOnboardingComplete(), data: onboardingData },
      featureFlags: loadFeatureFlags(context.extensionUri.fsPath, repoRoot),
      apiCatalog: buildApiCatalogPayload(loadSettings()),
      cloud,
      cloudSession: initialCloudSession,
      cloudStatus: initialCloudStatus,
    };

    const desktopReadyMessage = (msg.panelId || reattached)
      ? await findExistingDesktop(repoRoot, session.panelId)
        .then((desktop) => (desktop ? { type: 'desktopReady', novncPort: desktop.novncPort } : null))
        .catch(() => null)
      : null;

    const replayReady = async () => {
      try {
        panel.webview.postMessage({ type: 'readyAck', readySessionId });
        panel.webview.postMessage(initConfigMessage);
        if (desktopReadyMessage) {
          panel.webview.postMessage(desktopReadyMessage);
        }
      } catch {}
      await session.sendReviewState(true);
      if (reattached) {
        session.syncAttachedRunState();
        await session.sendTranscript();
        await session.sendProgress();
      }
    };

    await replayReady();
    appendPanelDebugLog(
      repoRoot,
      `${appendLogPrefix}: initConfig posted panelId=${session.panelId} runId=${reattached ? session.getRunId() || '' : ''} readySessionId=${readySessionId}`
    );

    void (async () => {
      const cloudSession = await buildCloudSessionPayload(cloudBoundary, context);
      const [latestCloud, cloudStatus] = await Promise.all([
        cloudSession && cloudSession.loggedIn ? loadCloudBootstrap() : Promise.resolve(cloudBoundary.summarize()),
        buildCloudStatusPayload(cloudBoundary, context, null, cloudSession),
      ]);
      try {
        panel.webview.postMessage({ type: 'cloudSessionData', cloud: latestCloud, cloudSession, cloudStatus });
      } catch {}
    })();

    if (reattached) {
      renderer.banner(`Reattached to run ${session.getRunId()}`);
      session._restoreWaitTimer();
    } else if (requestedRunId) {
      renderer.banner(`Previous run ${requestedRunId} no longer exists. Starting fresh.`);
    }

    debugLog(`ready: calling prestart() with stable panelId=${session._panelId} readySessionId=${readySessionId}`);
    session.prestart();
    return replayReady;
  });
}


// (Task/Test/Agent/Mode/Instance handlers moved to message-handlers.js)


function getWebviewHtml(panel, extensionUri) {
  const { getWebviewHtml: buildHtml } = require('./webview-html');
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'webview');
  return buildHtml({
    styleHref: panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'style.css')).toString(),
    scriptSrc: panel.webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js')).toString(),
    nonce: getNonce(),
    cspSource: panel.webview.cspSource,
  });
}

function getNonce() {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function getRepoRoot(extensionUri) {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  // Fallback: extension lives in <project>/extension, so go up one level
  return path.dirname(extensionUri.fsPath);
}

function namedWorkspacesEnabled(context, repoRoot = getRepoRoot(context.extensionUri)) {
  try {
    return !!loadFeatureFlags(context.extensionUri.fsPath, repoRoot).enablePersonalWorkspaces;
  } catch {
    return false;
  }
}

function buildPanelTitle(rootDescriptor) {
  if (rootDescriptor && rootDescriptor.workspaceName) {
    return `QA Panda: ${rootDescriptor.workspaceName}`;
  }
  return activePanels.size === 0 ? 'QA Panda' : `QA Panda (${activePanels.size + 1})`;
}

function normalizeStartupAgent(agent) {
  const value = String(agent || '').trim();
  if (!value) return null;
  if (value === 'controller' || value === 'claude') return value;
  return value.startsWith('agent-') ? value : `agent-${value}`;
}

async function resolvePanelRootDescriptor(context, workspaceName = null) {
  if (workspaceName) {
    return await ensureNamedWorkspace(workspaceName);
  }
  return createRepoRootDescriptor(getRepoRoot(context.extensionUri));
}

async function pickWorkspaceName() {
  const workspaces = await listNamedWorkspaces();
  const createItem = { label: '$(add) Create new workspace...', workspaceName: '__create__' };
  const items = [
    createItem,
    ...workspaces.map((workspace) => ({
      label: workspace.meta && workspace.meta.name ? workspace.meta.name : workspace.workspaceName,
      description: workspace.workspaceName,
      detail: workspace.meta && workspace.meta.defaultAgent
        ? `Default agent: ${workspace.meta.defaultAgent}`
        : 'Named workspace',
      workspaceName: workspace.workspaceName,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Open a QA Panda named workspace',
    ignoreFocusOut: true,
  });
  if (!picked) return null;
  if (picked.workspaceName !== '__create__') {
    return picked.workspaceName;
  }
  const input = await vscode.window.showInputBox({
    prompt: 'Enter a name for the new QA Panda workspace',
    placeHolder: 'journal',
    ignoreFocusOut: true,
    validateInput(value) {
      return normalizeWorkspaceName(value) ? null : 'Workspace name must contain letters or numbers.';
    },
  });
  return input ? normalizeWorkspaceName(input) : null;
}

function createVsCodeOpenExternal() {
  return async (url) => vscode.env.openExternal(vscode.Uri.parse(String(url)));
}

function createExtensionCloudOptions(context) {
  return {
    secretStorage: context.secrets,
    openExternal: createVsCodeOpenExternal(),
    appName: 'VS Code',
    appVersion: vscode.version,
  };
}

async function buildCloudSessionPayload(cloudBoundary, context) {
  try {
    return await resolveExtensionCloudState(cloudBoundary, createExtensionCloudOptions(context));
  } catch (error) {
    return buildFallbackCloudSessionPayload(cloudBoundary, error);
  }
}

function buildFallbackCloudSessionPayload(cloudBoundary, error = null) {
  return {
    target: 'extension',
    loggedIn: false,
    authMode: cloudBoundary.config.authMode,
    authEnabled: cloudBoundary.config.authMode !== 'disabled',
    storageMode: 'vscode-secret-storage',
    secretKey: 'qapanda.cloud.session',
    appBaseUrl: cloudBoundary.config.appBaseUrl,
    apiBaseUrl: cloudBoundary.config.apiBaseUrl,
    actor: null,
    workspace: null,
    session: null,
    refreshed: false,
    error: error && error.message ? error.message : (error ? String(error) : null),
  };
}

function defaultCloudRuntimeState(sessionState) {
  const loggedIn = Boolean(sessionState && sessionState.loggedIn);
  return {
    started: false,
    enabled: false,
    indicator: {
      status: loggedIn ? 'idle' : 'disabled',
      label: loggedIn ? 'Starting sync' : 'Signed out',
      detail: loggedIn
        ? 'Preparing connected-project sync for this workspace.'
        : 'Sign in to enable hosted connected-project sync.',
      tone: 'neutral',
    },
    conflicts: [],
    repository: null,
    pendingMutationCount: 0,
    lastSyncedAt: null,
    lastError: null,
      openConflictCount: 0,
      objectCounts: { tests: 0, issues: 0, recipes: 0 },
      recentObjects: [],
      notificationSummary: null,
    unreadNotificationCount: 0,
    hasUnreadNotifications: false,
    notificationError: null,
    registered: false,
  };
}

function summarizeCloudRepositoryIdentity(repository) {
  if (!repository || typeof repository !== 'object') return null;
  return {
    kind: repository.kind || null,
    displayName: repository.displayName || repository.repositorySlug || null,
    canonicalRemoteUrl: repository.canonicalRemoteUrl || null,
    repositoryKey: repository.repositoryKey || null,
    contextKey: repository.contextKey || null,
    instanceKey: repository.instanceKey || null,
    contextMode: repository.contextMode || null,
    contextLabel: repository.contextLabel || null,
    branchName: repository.branchName || null,
  };
}

function resolveHostedRepositoryContextUrl(cloudBoundary, binding) {
  if (!binding || !binding.repositoryId) return null;
  const trim = String(cloudBoundary.config.appBaseUrl || '').replace(/\/$/, '');
  const query = binding.repositoryContextId
    ? `?contextId=${encodeURIComponent(binding.repositoryContextId)}`
    : '';
  return `${trim}/app/projects/${encodeURIComponent(binding.repositoryId)}${query}`;
}

async function saveExtensionCloudContext(cloudBoundary, context, updates = {}) {
  const saved = await cloudBoundary.saveCloudSyncProjectConfig(updates);
  await stopExtensionCloudSyncRuntime();
  await ensureExtensionCloudSyncRuntime(cloudBoundary, context);
  return saved;
}

async function openExtensionCloudRepositoryContext(cloudBoundary, context) {
  const payload = await buildCloudStatusPayload(cloudBoundary, context);
  const url = resolveHostedRepositoryContextUrl(cloudBoundary, payload && payload.sync ? payload.sync.binding : null);
  if (!url) {
    throw new Error('This checkout is not registered in hosted sync yet. Wait for the next sync heartbeat, then try again.');
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
  return { url };
}

async function buildCloudStatusPayload(cloudBoundary, context, runtimeStatus = null, sessionState = null) {
  const resolvedSession = sessionState || await buildCloudSessionPayload(cloudBoundary, context);
  if (!resolvedSession || !resolvedSession.loggedIn) {
    return buildFallbackCloudStatusPayload(cloudBoundary, resolvedSession);
  }
  const packages = await cloudBoundary.loadPackages();
  const status = runtimeStatus || (_cloudSyncRuntime ? _cloudSyncRuntime.getStatus() : defaultCloudRuntimeState(resolvedSession));
  const projectConfig = status.repository && status.repository.projectConfig
    ? status.repository.projectConfig
    : cloudBoundary.getCloudSyncProjectConfig();
  const notificationSummary = status.notificationSummary || { unreadCount: 0, latest: [] };
  return {
    session: resolvedSession,
    sync: {
      started: Boolean(status.started),
      registered: Boolean(status.registered),
      badge: packages.clientCloud.createExtensionSyncBadge(status.indicator),
      indicator: status.indicator,
      contextMode: projectConfig ? projectConfig.contextMode : null,
      explicitContextKey: projectConfig ? projectConfig.explicitContextKey || null : null,
      contextLabel: projectConfig ? projectConfig.contextLabel || null : null,
      repository: summarizeCloudRepositoryIdentity(status.repository),
      binding: status.binding || null,
      pendingMutationCount: Number(status.pendingMutationCount || 0),
        openConflictCount: Number(status.openConflictCount || 0),
        objectCounts: status.objectCounts || { tests: 0, issues: 0, recipes: 0 },
        recentObjects: Array.isArray(status.recentObjects) ? status.recentObjects : [],
        lastSyncedAt: status.lastSyncedAt || null,
      lastError: status.lastError || null,
      conflicts: Array.isArray(status.conflicts) ? status.conflicts : [],
    },
    notifications: {
      summary: notificationSummary,
      badge: packages.clientCloud.createExtensionNotificationBadge(notificationSummary),
      unreadCount: Number(notificationSummary.unreadCount || 0),
      hasUnread: Number(notificationSummary.unreadCount || 0) > 0,
      error: status.notificationError || null,
    },
  };
}

function buildFallbackCloudStatusPayload(cloudBoundary, sessionState = null) {
  const state = sessionState || buildFallbackCloudSessionPayload(cloudBoundary);
  const runtime = defaultCloudRuntimeState(state);
  const notificationSummary = runtime.notificationSummary || { unreadCount: 0, latest: [] };
  return {
    session: state,
    sync: {
      started: Boolean(runtime.started),
      registered: Boolean(runtime.registered),
      badge: null,
      indicator: runtime.indicator,
      contextMode: null,
      explicitContextKey: null,
      contextLabel: null,
      repository: null,
      binding: null,
      pendingMutationCount: Number(runtime.pendingMutationCount || 0),
        openConflictCount: Number(runtime.openConflictCount || 0),
        objectCounts: runtime.objectCounts || { tests: 0, issues: 0, recipes: 0 },
        recentObjects: Array.isArray(runtime.recentObjects) ? runtime.recentObjects : [],
        lastSyncedAt: runtime.lastSyncedAt || null,
      lastError: runtime.lastError || null,
      conflicts: [],
    },
    notifications: {
      summary: notificationSummary,
      badge: null,
      unreadCount: Number(notificationSummary.unreadCount || 0),
      hasUnread: Number(notificationSummary.unreadCount || 0) > 0,
      error: runtime.notificationError || null,
    },
  };
}

function updateCloudStatusBar(payload) {
  if (!_cloudStatusBarItem) return;
  const unreadCount = payload && payload.notifications ? Number(payload.notifications.unreadCount || 0) : 0;
  const syncLabel = payload && payload.sync && payload.sync.badge ? payload.sync.badge.label : 'Signed out';
  if (!payload || !payload.session || !payload.session.loggedIn) {
    _cloudStatusBarItem.text = '$(cloud) Sign in';
    _cloudStatusBarItem.tooltip = 'QA Panda Cloud is signed out. Open QA Panda settings to sign in.';
    _cloudStatusBarItem.color = undefined;
    _cloudStatusBarItem.show();
    return;
  }

  const notificationText = unreadCount > 0 ? ` $(bell-dot) ${unreadCount}` : ' $(bell)';
  _cloudStatusBarItem.text = `$(cloud) ${syncLabel}${notificationText}`;
  _cloudStatusBarItem.tooltip = [
    `QA Panda Cloud`,
    `${payload.sync.indicator.detail}`,
    `Context: ${payload.sync.contextMode || 'shared'}${payload.sync.contextLabel ? ` (${payload.sync.contextLabel})` : ''}`,
    `Pending mutations: ${payload.sync.pendingMutationCount}`,
    `Unread notifications: ${unreadCount}`,
    payload.sync.openConflictCount > 0 ? `Open conflicts: ${payload.sync.openConflictCount}` : null,
    payload.sync.lastError ? `Last sync error: ${payload.sync.lastError}` : null,
    payload.notifications.error ? `Notification error: ${payload.notifications.error}` : null,
  ].filter(Boolean).join('\n');
  if (payload.sync.lastError) {
    _cloudStatusBarItem.color = new vscode.ThemeColor('errorForeground');
  } else if (payload.sync.openConflictCount > 0 || unreadCount > 0) {
    _cloudStatusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  } else {
    _cloudStatusBarItem.color = undefined;
  }
  _cloudStatusBarItem.show();
}

async function refreshExtensionCloudStatusSurface(cloudBoundary, context, runtimeStatus = null) {
  const payload = await buildCloudStatusPayload(cloudBoundary, context, runtimeStatus);
  updateCloudStatusBar(payload);
  for (const panel of activePanels) {
    try {
      panel.webview.postMessage({ type: 'cloudStatusData', cloudStatus: payload });
    } catch {}
  }
  return payload;
}

function resolveNotificationToastHandler(item) {
  if (item && item.severity === 'danger') return vscode.window.showErrorMessage.bind(vscode.window);
  if (item && item.severity === 'warning') return vscode.window.showWarningMessage.bind(vscode.window);
  return vscode.window.showInformationMessage.bind(vscode.window);
}

async function showExtensionCloudNotificationBatch(cloudBoundary, batch) {
  const items = Array.isArray(batch && batch.items) ? batch.items : [];
  if (!items.length) return;
  const actionable = packages.clientCloud.selectExtensionToastNotifications(items);
  if (!actionable.length) return;
  const links = packages.clientCloud.createNotificationWebLinks(cloudBoundary.config.appBaseUrl);
  for (const item of actionable) {
    const message = item && item.body
      ? `${item.title}: ${item.body}`
      : item && item.title
        ? item.title
        : 'QA Panda sent a hosted notification.';
    const primaryUrl = item && item.actionUrl ? item.actionUrl : links.inboxPath;
    const actions = [
      { title: item && item.actionUrl ? 'Open in QA Panda' : 'Open notifications', url: primaryUrl },
    ];
    if (primaryUrl !== links.inboxPath) {
      actions.push({ title: 'Open inbox', url: links.inboxPath });
    }
    const showToast = resolveNotificationToastHandler(item);
    const picked = await showToast(message, ...actions);
    if (picked && picked.url) {
      await vscode.env.openExternal(vscode.Uri.parse(picked.url));
    }
  }
}

async function handleCloudSyncConflictMessage(panel, session, cloudBoundary, context, msg) {
  if (!msg || (msg.type !== 'cloudSyncRefreshConflicts' && msg.type !== 'cloudSyncResolveConflict')) {
    return false;
  }
  const runtime = _cloudSyncRuntime || await ensureExtensionCloudSyncRuntime(cloudBoundary, context);
  if (!runtime) {
    await postSettingsData(panel, session, cloudBoundary, context);
    try {
      panel.webview.postMessage({
        type: 'cloudSessionNotice',
        level: 'warning',
        text: 'Sign in to QA Panda Cloud before refreshing or resolving sync conflicts.',
      });
    } catch {}
    return true;
  }
  if (msg.type === 'cloudSyncRefreshConflicts') {
    const conflicts = await runtime.refreshConflicts();
    await refreshExtensionCloudStatusSurface(cloudBoundary, context, runtime.getStatus());
    try {
      panel.webview.postMessage({
        type: 'cloudSessionNotice',
        level: 'info',
        text: conflicts.length > 0
          ? `Refreshed ${conflicts.length} sync conflict${conflicts.length === 1 ? '' : 's'}.`
          : 'No open sync conflicts.',
      });
    } catch {}
    return true;
  }
  if (msg.type === 'cloudSyncResolveConflict') {
    const resolution = msg.resolution === 'take_local' ? 'take_local' : 'take_remote';
    await runtime.resolveConflict(String(msg.conflictId || ''), resolution);
    await refreshExtensionCloudStatusSurface(cloudBoundary, context, runtime.getStatus());
    try {
      panel.webview.postMessage({
        type: 'cloudSessionNotice',
        level: 'info',
        text: resolution === 'take_local'
          ? 'Resolved sync conflict using the local version.'
          : 'Resolved sync conflict using the cloud version.',
      });
    } catch {}
    return true;
  }
  return false;
}

async function postSettingsData(panel, session, cloudBoundary, context) {
  const cloudSession = await buildCloudSessionPayload(cloudBoundary, context);
  const settings = loadSettings();
  const payload = {
    type: 'settingsData',
    settings,
    apiCatalog: buildApiCatalogPayload(settings),
    defaults: buildSelfTestingPrompt.DEFAULTS,
    cloudSession,
    cloudStatus: await buildCloudStatusPayload(cloudBoundary, context, null, cloudSession),
  };
  try { panel.webview.postMessage(payload); } catch {}
}

async function ensureExtensionCloudSyncRuntime(cloudBoundary, context) {
  if (_cloudSyncRuntime) return _cloudSyncRuntime;
  if (_cloudSyncStartPromise) return _cloudSyncStartPromise;
  _cloudSyncStartPromise = (async () => {
    const cloudSession = await buildCloudSessionPayload(cloudBoundary, context);
    if (!cloudSession || !cloudSession.loggedIn) {
      await refreshExtensionCloudStatusSurface(cloudBoundary, context, null);
      return null;
    }
    const runtime = await cloudBoundary.createRepositorySyncRuntime({
      secretStorage: context.secrets,
      appName: 'VS Code',
      appVersion: vscode.version,
      onError(error) {
        console.warn('[cloud-sync] runtime tick failed:', error && error.message ? error.message : error);
        void refreshExtensionCloudStatusSurface(cloudBoundary, context);
      },
      onStatus(status) {
        void refreshExtensionCloudStatusSurface(cloudBoundary, context, status);
      },
      onNotifications(batch) {
        void showExtensionCloudNotificationBatch(cloudBoundary, batch);
      },
    });
    const started = await runtime.start();
    if (!started.started) {
      await refreshExtensionCloudStatusSurface(cloudBoundary, context, started);
      return null;
    }
    _cloudSyncRuntime = runtime;
    await refreshExtensionCloudStatusSurface(cloudBoundary, context, started);
    return runtime;
  })();
  try {
    return await _cloudSyncStartPromise;
  } finally {
    _cloudSyncStartPromise = null;
  }
}

async function stopExtensionCloudSyncRuntime() {
  if (_cloudSyncStartPromise) {
    try { await _cloudSyncStartPromise; } catch {}
  }
  if (_cloudSyncRuntime) {
    await _cloudSyncRuntime.stop();
    _cloudSyncRuntime = null;
  }
}

function activate(context) {
  _aDbg('activate() called');
  try { return _activateInner(context); } catch (e) {
    _aDbg(`ACTIVATE CRASHED: ${e.message}\n${e.stack}`);
    throw e;
  }
}

function _activateInner(context) {
  // Ensure .qpanda/ is gitignored in the workspace
  try {
    const repoRoot = getRepoRoot(context.extensionUri);
    if (repoRoot) {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      let content = '';
      try { content = fs.readFileSync(gitignorePath, 'utf8'); } catch {}
      if (!content.includes('.qpanda')) {
        const line = content.endsWith('\n') || content === '' ? '.qpanda/\n' : '\n.qpanda/\n';
        fs.appendFileSync(gitignorePath, line);
      }
    }
  } catch {}

  _aDbg('checkpoint: gitignore done');

  // Start HTTP MCP servers (singletons shared across all panels)
  _aDbg('checkpoint: starting MCP servers');
  const defaultRepoRoot = getRepoRoot(context.extensionUri);
  const workspacesEnabled = namedWorkspacesEnabled(context, defaultRepoRoot);
  void vscode.commands.executeCommand('setContext', 'qapanda.namedWorkspacesEnabled', workspacesEnabled);
  const cloudBoundary = createCloudBoundary({ target: 'extension', repoRoot: defaultRepoRoot });
  const loadCloudBootstrap = () => cloudBoundary.preload().catch((error) => cloudBoundary.summarize(error));
  if (!_cloudStatusBarItem) {
    _cloudStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    _cloudStatusBarItem.name = 'QA Panda Cloud';
    _cloudStatusBarItem.command = 'qapanda.open';
    context.subscriptions.push(_cloudStatusBarItem);
  }
  void refreshExtensionCloudStatusSurface(cloudBoundary, context);
  void ensureExtensionCloudSyncRuntime(cloudBoundary, context);
  ensureRootMcpPorts(defaultRepoRoot, {
    startTasksMcpServer,
    startTestsMcpServer,
    startMemoryMcpServer,
    startQaDesktopMcpServer,
    enableQaDesktop: remoteDesktopEnabled(context, defaultRepoRoot),
    onQaDesktopError: (error) => console.error('[ext] Failed to start QA Desktop MCP server:', error),
  }).then((ports) => {
    _tasksMcpPort = ports.tasksPort;
    _testsMcpPort = ports.testsPort;
    _memoryMcpPort = ports.memoryPort;
    _qaDesktopMcpPort = ports.qaDesktopPort;
  }).catch(e => console.error('[ext] Failed to start root MCP servers:', e));

  _aDbg('checkpoint: registering qapanda.open command');
  const openCommand = vscode.commands.registerCommand('qapanda.open', async (args = {}) => {
    _aDbg('qapanda.open invoked');
    const requestedWorkspace = args && args.workspace ? normalizeWorkspaceName(args.workspace) : null;
    if (requestedWorkspace && !namedWorkspacesEnabled(context)) {
      await vscode.window.showErrorMessage('Named workspaces are disabled for this QA Panda workspace.');
      return;
    }
    const rootDescriptor = await resolvePanelRootDescriptor(context, requestedWorkspace);
    const title = buildPanelTitle(rootDescriptor);
    const panel = vscode.window.createWebviewPanel(
      'qapandaPanel',
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview'),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');

    const renderer = new WebviewRenderer(panel);
    const repoRoot = rootDescriptor.repoRoot;
    const ports = await ensureRootMcpPorts(repoRoot, {
      startTasksMcpServer,
      startTestsMcpServer,
      startMemoryMcpServer,
      startQaDesktopMcpServer,
      enableQaDesktop: remoteDesktopEnabled(context, repoRoot),
      onQaDesktopError: (error) => console.error('[ext] Failed to start QA Desktop MCP server:', error),
    });
    const cloudBoundary = createCloudBoundary({ target: 'extension', repoRoot });
    const loadCloudBootstrap = () => cloudBoundary.preload().catch((error) => cloudBoundary.summarize(error));

    // Per-panel mutable config (new panels start with defaults)
    const panelConfig = {};

    function postMessage(msg) {
      // Keep panelConfig in sync when SessionManager pushes config changes
      if (msg && msg.type === 'syncConfig' && msg.config) {
        Object.assign(panelConfig, msg.config);
      }
      try {
        panel.webview.postMessage(msg);
      } catch {
        // Panel disposed
      }
    }

    const session = new SessionManager(renderer, {
      repoRoot,
      stateRoot: rootDescriptor.stateRoot,
      workspaceName: rootDescriptor.workspaceName || null,
      rootKind: rootDescriptor.kind,
      rootIdentity: rootDescriptor.rootIdentity,
      resumeToken: args && args.resume ? String(args.resume).trim() : null,
      saveResumeAs: args && args.saveResumeAs ? String(args.saveResumeAs).trim() : null,
      postMessage,
      initialConfig: panelConfig,
      extensionPath: context.extensionUri.fsPath,
    });
    // Pass HTTP MCP server ports so agents can reach them
    session._tasksMcpPort = ports.tasksPort;
    session._testsMcpPort = ports.testsPort;
    session._memoryMcpPort = ports.memoryPort;
    session._qaDesktopMcpPort = ports.qaDesktopPort;
    // Initialize MCP servers and agents from disk
    const extensionPath1 = context.extensionUri.fsPath;
    session.setMcpServers(loadMergedMcpServers(repoRoot));
    session.setAgents(loadMergedAgents(repoRoot, extensionPath1));
    session.setModes(loadMergedModes(repoRoot, extensionPath1));
    // prestart() is called in the 'ready' handler below, after panelId is stabilized

    const _extDbg = (msg) => { try { fs.appendFileSync(path.join(os.tmpdir(), 'cc-chrome-debug.log'), `[${new Date().toISOString()}] [ext] ${msg}\n`); } catch {} };
    const handleReady = createPanelReadyHandler({
      session,
      panel,
      renderer,
      repoRoot,
      stateRoot: rootDescriptor.stateRoot,
      workspaceName: rootDescriptor.workspaceName || null,
      rootKind: rootDescriptor.kind,
      rootIdentity: rootDescriptor.rootIdentity,
      panelConfig,
      cloudBoundary,
      context,
      extensionPath: extensionPath1,
      savedResume: args && args.resume ? String(args.resume).trim() : null,
      savedAgent: args && args.agent ? String(args.agent).trim() : null,
      savedSaveResumeAs: args && args.saveResumeAs ? String(args.saveResumeAs).trim() : null,
      debugLog: _extDbg,
      appendLogPrefix: 'EXT-HOST',
      loadCloudBootstrap,
    });

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        try {
        if (msg.type === 'configChanged') {
          session.applyConfig(msg.config);
          Object.assign(panelConfig, msg.config);
          return;
        }
        if (msg.type === '_debugLog') {
          appendPanelDebugLog(repoRoot, msg.text);
          return;
        }
        if (msg.type === 'onboardingDetect') {
          runFullDetection().then(detected => {
            try { panel.webview.postMessage({ type: 'onboardingDetected', detected }); } catch {}
          }).catch(() => {
            try { panel.webview.postMessage({ type: 'onboardingDetected', detected: null, error: 'Detection failed' }); } catch {}
          });
          return;
        }
        if (msg.type === 'onboardingAutoFix') {
          runAutoFix(msg.step,
            (text) => { try { panel.webview.postMessage({ type: 'onboardingFixProgress', step: msg.step, text }); } catch {} },
            (success, error) => { try { panel.webview.postMessage({ type: 'onboardingFixDone', step: msg.step, success, error }); } catch {} }
          );
          return;
        }
        if (msg.type === 'onboardingSave') {
          const bundledPath = path.join(extensionPath1, 'resources', 'system-agents.json');
          const bundledAgents = loadAgentsFile(bundledPath);
          const result = completeOnboarding({ preference: msg.preference, detected: msg.detected, bundledAgents });
          // Reload agents after onboarding modified system-agents overrides
          const agentsData = loadMergedAgents(repoRoot, extensionPath1);
          session.setAgents(agentsData);
          try {
            panel.webview.postMessage({ type: 'onboardingComplete', onboarding: { complete: true, data: result } });
            // Send updated agents to webview so Agents tab reflects the changes immediately
            panel.webview.postMessage({ type: 'agentsData', agents: agentsData });
          } catch {}
          return;
        }
        if (msg.type === 'setPanelTitle') {
          panel.title = msg.title;
          return;
        }
        if (msg.type === 'ready') {
          await handleReady(msg);
          return;
        }
        if (msg.type === 'tasksLoad' || msg.type === 'testsLoad' || msg.type === 'userInput' || msg.type === 'continueInput' || msg.type === 'orchestrateInput' || msg.type === 'reviewRequest') {
          appendPanelDebugLog(repoRoot, `EXT-HOST: incoming ${msg.type}${msg.text ? ` text=${String(msg.text).slice(0, 120)}` : ''}`);
        }
        if (msg.type === 'cloudSessionLogin') {
          const result = await loginExtensionCloud(cloudBoundary, createExtensionCloudOptions(context));
          await ensureExtensionCloudSyncRuntime(cloudBoundary, context);
          await postSettingsData(panel, session, cloudBoundary, context);
          await refreshExtensionCloudStatusSurface(cloudBoundary, context);
          try { panel.webview.postMessage({ type: 'cloudSessionNotice', level: 'info', text: `Signed into QA Panda Cloud via ${result.method}.` }); } catch {}
          return;
        }
        if (msg.type === 'cloudSessionLogout') {
          const result = await logoutExtensionCloud(cloudBoundary, createExtensionCloudOptions(context));
          await stopExtensionCloudSyncRuntime();
          await postSettingsData(panel, session, cloudBoundary, context);
          await refreshExtensionCloudStatusSurface(cloudBoundary, context);
          try {
            panel.webview.postMessage({
              type: 'cloudSessionNotice',
              level: 'info',
              text: result.hadSession
                ? `Signed out of QA Panda Cloud.${result.revokedRemotely ? ' Remote revoke: ok.' : ''}`
                : 'No stored QA Panda Cloud session was present.',
            });
          } catch {}
          return;
        }
        if (msg.type === 'cloudSessionRefresh') {
          await postSettingsData(panel, session, cloudBoundary, context);
          await refreshExtensionCloudStatusSurface(cloudBoundary, context);
          return;
        }
        if (msg.type === 'cloudSessionSwitchWorkspace') {
          const nextState = await switchExtensionCloudWorkspace(
            cloudBoundary,
            msg.workspaceId,
            createExtensionCloudOptions(context)
          );
          await ensureExtensionCloudSyncRuntime(cloudBoundary, context);
          await postSettingsData(panel, session, cloudBoundary, context);
          await refreshExtensionCloudStatusSurface(cloudBoundary, context);
          try {
            panel.webview.postMessage({
              type: 'cloudSessionNotice',
              level: 'info',
              text: `Switched hosted workspace to ${nextState.workspace && nextState.workspace.name ? nextState.workspace.name : 'the selected workspace'}.`,
            });
          } catch {}
          return;
        }
        if (msg.type === 'cloudSessionOpen') {
          const result = await openExtensionCloudTarget(cloudBoundary, {
            ...createExtensionCloudOptions(context),
            target: msg.target || 'app',
            id: msg.id || null,
          });
          try { panel.webview.postMessage({ type: 'cloudSessionNotice', level: 'info', text: `Opened ${result.url}` }); } catch {}
          return;
        }
        if (msg.type === 'cloudContextSave') {
          await saveExtensionCloudContext(cloudBoundary, context, {
            contextMode: msg.contextMode,
            explicitContextKey: msg.explicitContextKey,
            contextLabel: msg.contextLabel,
          });
          await postSettingsData(panel, session, cloudBoundary, context);
          await refreshExtensionCloudStatusSurface(cloudBoundary, context);
          try {
              panel.webview.postMessage({
                type: 'cloudSessionNotice',
                level: 'info',
              text: 'Saved connected-project context for this checkout.',
              });
          } catch {}
          return;
        }
        if (msg.type === 'cloudContextOpen') {
          const result = await openExtensionCloudRepositoryContext(cloudBoundary, context);
          try { panel.webview.postMessage({ type: 'cloudSessionNotice', level: 'info', text: `Opened ${result.url}` }); } catch {}
          return;
        }
        if (await handleCloudSyncConflictMessage(panel, session, cloudBoundary, context, msg)) {
          return;
        }
        if (msg.type === 'mcpServersChanged') {
          const scope = msg.scope;
          const servers = msg.servers;
          const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
          const previousServers = scope === 'project' ? loadMcpFile(filePath) : null;
          saveMcpFile(filePath, servers);
          if (scope === 'project') {
            void queueProjectMcpSyncChanges(repoRoot, previousServers, servers);
          }
          const mcpData = loadMergedMcpServers(repoRoot);
          session.setMcpServers(mcpData);
          return;
        }
        if (msg.type === 'settingsLoad') {
          await postSettingsData(panel, session, cloudBoundary, context);
          return;
        }
        if (msg.type === 'settingsSave') {
          const updated = saveSettings(msg.settings || {});
          session._selfTesting = !!updated.selfTesting;
          await postSettingsData(panel, session, cloudBoundary, context);
          return;
        }
        const projectContextReply = handleProjectContextMessage(msg, repoRoot);
        if (projectContextReply) { try { panel.webview.postMessage(projectContextReply); } catch {} return; }
        if (await handleQaReportExportMessage(msg, repoRoot)) {
          return;
        }
        // Task CRUD messages
        const taskReply = await handleTaskMessage(msg, repoRoot);
        if (taskReply) {
          appendPanelDebugLog(repoRoot, `EXT-HOST: posting ${taskReply.type} count=${Array.isArray(taskReply.tasks) ? taskReply.tasks.length : 0}`);
          try { panel.webview.postMessage(taskReply); } catch {}
          return;
        }
        // Test CRUD messages
        const testReply = await handleTestMessage(msg, repoRoot);
        if (testReply) {
          appendPanelDebugLog(repoRoot, `EXT-HOST: posting ${testReply.type} count=${Array.isArray(testReply.tests) ? testReply.tests.length : 0}`);
          try { panel.webview.postMessage(testReply); } catch {}
          return;
        }
        // Agent CRUD messages
        const agentReply = handleAgentMessage(msg, repoRoot, extensionPath1);
        if (agentReply) {
          try { panel.webview.postMessage(agentReply); } catch {}
          session.setAgents(loadMergedAgents(repoRoot, extensionPath1));
          return;
        }
        // Mode CRUD messages
        const modeReply = handleModeMessage(msg, repoRoot, extensionPath1);
        if (modeReply) {
          try { panel.webview.postMessage(modeReply); } catch {}
          session.setModes(loadMergedModes(repoRoot, extensionPath1));
          return;
        }
        // Instance management messages (async)
        let instanceReply;
        try {
          instanceReply = await handleInstanceMessage(msg, repoRoot, session.panelId, (m) => { try { panel.webview.postMessage(m); } catch {} }, extensionPath1);
        } catch (err) {
          console.error('[instance] handler error:', err);
          instanceReply = { type: 'instancesData', instances: [], panelId: session.panelId, _actionId: msg._actionId };
        }
        if (instanceReply) {
          try { panel.webview.postMessage(instanceReply); } catch {}
          if (instanceReply.novncPort) {
            try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
          }
          return;
        }
        appendPanelDebugLog(repoRoot, `EXT-HOST: forwarding to session.handleMessage type=${msg.type}`);
        session.handleMessage(msg);
        } catch (error) {
          appendPanelDebugLog(repoRoot, `EXT-HOST ERROR type=${msg && msg.type ? msg.type : 'unknown'} message=${error && error.message ? error.message : String(error)} stack=${error && error.stack ? error.stack.replace(/\s+/g, ' ') : ''}`);
          throw error;
        }
      },
      undefined,
      context.subscriptions
    );

    panel.webview.html = getWebviewHtml(panel, context.extensionUri);

    activePanels.add(panel);

    panel.onDidDispose(
      () => {
        activePanels.delete(panel);
        void cleanupPanelSession({
          repoRoot,
          panelId: session.panelId,
          session,
          instanceName,
          stopInstance,
          clearPanel,
          killChrome,
          closeAllConnections: closeAllCodexConnections,
        });
      },
      null,
      context.subscriptions
    );

    renderer.banner('\uD83D\uDC3C QA Panda interactive session');
    renderer.banner(rootDescriptor.workspaceName ? `Workspace: ${rootDescriptor.workspaceName}` : `Repo root: ${repoRoot}`);
    renderer.banner('Type /help for commands, or type a message to start.');
  });

  const openWorkspaceCommand = vscode.commands.registerCommand('qapanda.openWorkspace', async (args = {}) => {
    if (!namedWorkspacesEnabled(context)) {
      await vscode.window.showErrorMessage('Named workspaces are disabled for this QA Panda workspace.');
      return;
    }
    let workspaceName = args && args.workspace ? normalizeWorkspaceName(args.workspace) : '';
    if (!workspaceName) {
      workspaceName = await pickWorkspaceName();
    }
    if (!workspaceName) {
      return;
    }
    await vscode.commands.executeCommand('qapanda.open', {
      workspace: workspaceName,
      agent: args && args.agent ? args.agent : null,
      resume: args && args.resume ? args.resume : null,
      saveResumeAs: args && args.saveResumeAs ? args.saveResumeAs : null,
    });
  });

  _aDbg('checkpoint: command registered, pushing to subscriptions');
  context.subscriptions.push(openCommand, openWorkspaceCommand);

  // Register serializer for panel restoration
  _aDbg('checkpoint: registering deserializer');
  vscode.window.registerWebviewPanelSerializer('qapandaPanel', {
    async deserializeWebviewPanel(panel, state) {
      _aDbg('deserializeWebviewPanel called');
      try { return await _deserializeInner(panel, state, context); } catch (e) {
        _aDbg(`DESERIALIZE CRASHED: ${e.message}\n${e.stack}`);
        throw e;
      }
    },
  });
  _aDbg('activate() completed successfully');
}

async function _deserializeInner(panel, state, context) {
      const renderer = new WebviewRenderer(panel);
      const savedWorkspace = state && state.workspace ? normalizeWorkspaceName(state.workspace) : null;
      const rootDescriptor = savedWorkspace
        ? await resolvePanelRootDescriptor(context, savedWorkspace)
        : createRepoRootDescriptor(getRepoRoot(context.extensionUri));
      const ignoreSavedState = Boolean(
        state &&
        state.rootIdentity &&
        rootDescriptor.rootIdentity &&
        state.rootIdentity !== rootDescriptor.rootIdentity
      );
      panel.title = buildPanelTitle(rootDescriptor);
      const repoRoot = rootDescriptor.repoRoot;
      const ports = await ensureRootMcpPorts(repoRoot, {
        startTasksMcpServer,
        startTestsMcpServer,
        startMemoryMcpServer,
        startQaDesktopMcpServer,
        enableQaDesktop: remoteDesktopEnabled(context, repoRoot),
        onQaDesktopError: (error) => console.error('[ext] Failed to start QA Desktop MCP server:', error),
      });
      const cloudBoundary = createCloudBoundary({ target: 'extension', repoRoot });
      const loadCloudBootstrap = () => cloudBoundary.preload().catch((error) => cloudBoundary.summarize(error));
      // Per-panel config restored from webview state (per-panel, not shared)
      const panelConfig = ignoreSavedState ? {} : ((state && state.config) || {});
      const savedRunId = ignoreSavedState ? null : ((state && state.runId) || null);
      const savedResume = ignoreSavedState ? null : ((state && state.resume) || null);
      const savedAgent = panelConfig && panelConfig.chatTarget ? panelConfig.chatTarget : null;

      function postMessage(msg) {
        if (msg && msg.type === 'syncConfig' && msg.config) {
          Object.assign(panelConfig, msg.config);
        }
        try {
          panel.webview.postMessage(msg);
        } catch {}
      }

      const session = new SessionManager(renderer, {
        repoRoot,
        stateRoot: rootDescriptor.stateRoot,
        workspaceName: rootDescriptor.workspaceName || null,
        rootKind: rootDescriptor.kind,
        rootIdentity: rootDescriptor.rootIdentity,
        resumeToken: savedResume,
        postMessage,
        initialConfig: panelConfig,
        extensionPath: context.extensionUri.fsPath,
      });
      session._tasksMcpPort = ports.tasksPort;
      session._testsMcpPort = ports.testsPort;
      session._memoryMcpPort = ports.memoryPort;
      session._qaDesktopMcpPort = ports.qaDesktopPort;
      const extensionPath2 = context.extensionUri.fsPath;
      session.setMcpServers(loadMergedMcpServers(repoRoot));
      session.setAgents(loadMergedAgents(repoRoot, extensionPath2));
      session.setModes(loadMergedModes(repoRoot, extensionPath2));
      // prestart() is called in the 'ready' handler below, after panelId is stabilized

      const _extDbg2 = (msg) => { try { fs.appendFileSync(path.join(os.tmpdir(), 'cc-chrome-debug.log'), `[${new Date().toISOString()}] [ext-deser] ${msg}\n`); } catch {} };
      const handleReady = createPanelReadyHandler({
        session,
        panel,
        renderer,
        repoRoot,
        stateRoot: rootDescriptor.stateRoot,
        workspaceName: rootDescriptor.workspaceName || null,
        rootKind: rootDescriptor.kind,
        rootIdentity: rootDescriptor.rootIdentity,
        panelConfig,
        cloudBoundary,
        context,
        extensionPath: extensionPath2,
        savedRunId,
        savedResume,
        savedAgent,
        debugLog: _extDbg2,
        appendLogPrefix: 'EXT-HOST(deserialized)',
        loadCloudBootstrap,
      });

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          try {
          if (msg.type === '_debugLog') {
            appendPanelDebugLog(repoRoot, msg.text);
            return;
          }
          if (msg.type === 'onboardingDetect') {
            runFullDetection().then(detected => {
              try { panel.webview.postMessage({ type: 'onboardingDetected', detected }); } catch {}
            }).catch(() => {
              try { panel.webview.postMessage({ type: 'onboardingDetected', detected: null, error: 'Detection failed' }); } catch {}
            });
            return;
          }
          if (msg.type === 'onboardingAutoFix') {
            runAutoFix(msg.step,
              (text) => { try { panel.webview.postMessage({ type: 'onboardingFixProgress', step: msg.step, text }); } catch {} },
              (success, error) => { try { panel.webview.postMessage({ type: 'onboardingFixDone', step: msg.step, success, error }); } catch {} }
            );
            return;
          }
          if (msg.type === 'onboardingSave') {
            const bundledPath = path.join(extensionPath2, 'resources', 'system-agents.json');
            const bundledAgents = loadAgentsFile(bundledPath);
            const result = completeOnboarding({ preference: msg.preference, detected: msg.detected, bundledAgents });
            const agentsData = loadMergedAgents(repoRoot, extensionPath2);
            session.setAgents(agentsData);
            try {
              panel.webview.postMessage({ type: 'onboardingComplete', onboarding: { complete: true, data: result } });
              panel.webview.postMessage({ type: 'agentsData', agents: agentsData });
            } catch {}
            return;
          }
          if (msg.type === 'configChanged') {
            session.applyConfig(msg.config);
            Object.assign(panelConfig, msg.config);
            return;
          }
          if (msg.type === 'setPanelTitle') {
            panel.title = msg.title;
            return;
          }
          if (msg.type === 'mcpServersChanged') {
            const scope = msg.scope;
            const servers = msg.servers;
            const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
            const previousServers = scope === 'project' ? loadMcpFile(filePath) : null;
            saveMcpFile(filePath, servers);
            if (scope === 'project') {
              void queueProjectMcpSyncChanges(repoRoot, previousServers, servers);
            }
            const mcpData = loadMergedMcpServers(repoRoot);
            session.setMcpServers(mcpData);
            return;
          }
          if (msg.type === 'tasksLoad' || msg.type === 'testsLoad' || msg.type === 'userInput' || msg.type === 'continueInput' || msg.type === 'orchestrateInput') {
            appendPanelDebugLog(repoRoot, `EXT-HOST(deserialized): incoming ${msg.type}${msg.text ? ` text=${String(msg.text).slice(0, 120)}` : ''}`);
          }
          if (msg.type === 'cloudSessionLogin') {
            const result = await loginExtensionCloud(cloudBoundary, createExtensionCloudOptions(context));
            await ensureExtensionCloudSyncRuntime(cloudBoundary, context);
            await postSettingsData(panel, session, cloudBoundary, context);
            try { panel.webview.postMessage({ type: 'cloudSessionNotice', level: 'info', text: `Signed into QA Panda Cloud via ${result.method}.` }); } catch {}
            return;
          }
          if (msg.type === 'cloudSessionLogout') {
            const result = await logoutExtensionCloud(cloudBoundary, createExtensionCloudOptions(context));
            await stopExtensionCloudSyncRuntime();
            await postSettingsData(panel, session, cloudBoundary, context);
            try {
              panel.webview.postMessage({
                type: 'cloudSessionNotice',
                level: 'info',
                text: result.hadSession
                  ? `Signed out of QA Panda Cloud.${result.revokedRemotely ? ' Remote revoke: ok.' : ''}`
                  : 'No stored QA Panda Cloud session was present.',
              });
            } catch {}
            return;
          }
          if (msg.type === 'cloudSessionRefresh') {
            await postSettingsData(panel, session, cloudBoundary, context);
            await refreshExtensionCloudStatusSurface(cloudBoundary, context);
            return;
          }
          if (msg.type === 'cloudSessionSwitchWorkspace') {
            const nextState = await switchExtensionCloudWorkspace(
              cloudBoundary,
              msg.workspaceId,
              createExtensionCloudOptions(context)
            );
            await ensureExtensionCloudSyncRuntime(cloudBoundary, context);
            await postSettingsData(panel, session, cloudBoundary, context);
            await refreshExtensionCloudStatusSurface(cloudBoundary, context);
            try {
              panel.webview.postMessage({
                type: 'cloudSessionNotice',
                level: 'info',
                text: `Switched hosted workspace to ${nextState.workspace && nextState.workspace.name ? nextState.workspace.name : 'the selected workspace'}.`,
              });
            } catch {}
            return;
          }
          if (msg.type === 'cloudSessionOpen') {
            const result = await openExtensionCloudTarget(cloudBoundary, {
              ...createExtensionCloudOptions(context),
              target: msg.target || 'app',
              id: msg.id || null,
            });
            try { panel.webview.postMessage({ type: 'cloudSessionNotice', level: 'info', text: `Opened ${result.url}` }); } catch {}
            return;
          }
          if (msg.type === 'cloudContextSave') {
            await saveExtensionCloudContext(cloudBoundary, context, {
              contextMode: msg.contextMode,
              explicitContextKey: msg.explicitContextKey,
              contextLabel: msg.contextLabel,
            });
            await postSettingsData(panel, session, cloudBoundary, context);
            await refreshExtensionCloudStatusSurface(cloudBoundary, context);
            try {
              panel.webview.postMessage({
                type: 'cloudSessionNotice',
                level: 'info',
                text: 'Saved connected-project context for this checkout.',
              });
            } catch {}
            return;
          }
          if (msg.type === 'cloudContextOpen') {
            const result = await openExtensionCloudRepositoryContext(cloudBoundary, context);
            try { panel.webview.postMessage({ type: 'cloudSessionNotice', level: 'info', text: `Opened ${result.url}` }); } catch {}
            return;
          }
          if (await handleCloudSyncConflictMessage(panel, session, cloudBoundary, context, msg)) {
            return;
          }
          if (msg.type === 'settingsLoad') {
            await postSettingsData(panel, session, cloudBoundary, context);
            return;
          }
          if (msg.type === 'settingsSave') {
            const updated = saveSettings(msg.settings || {});
            session._selfTesting = !!updated.selfTesting;
            await postSettingsData(panel, session, cloudBoundary, context);
            return;
          }
          const projectContextReply = handleProjectContextMessage(msg, repoRoot);
          if (projectContextReply) { try { panel.webview.postMessage(projectContextReply); } catch {} return; }
          if (await handleQaReportExportMessage(msg, repoRoot)) {
            return;
          }
          // Task CRUD messages
          const taskReply = await handleTaskMessage(msg, repoRoot);
          if (taskReply) {
            appendPanelDebugLog(repoRoot, `EXT-HOST(deserialized): posting ${taskReply.type} count=${Array.isArray(taskReply.tasks) ? taskReply.tasks.length : 0}`);
            try { panel.webview.postMessage(taskReply); } catch {}
            return;
          }
          // Test CRUD messages
          const testReply = await handleTestMessage(msg, repoRoot);
          if (testReply) {
            appendPanelDebugLog(repoRoot, `EXT-HOST(deserialized): posting ${testReply.type} count=${Array.isArray(testReply.tests) ? testReply.tests.length : 0}`);
            try { panel.webview.postMessage(testReply); } catch {}
            return;
          }
          // Agent CRUD messages
          const agentReply = handleAgentMessage(msg, repoRoot, extensionPath2);
          if (agentReply) {
            try { panel.webview.postMessage(agentReply); } catch {}
            session.setAgents(loadMergedAgents(repoRoot, extensionPath2));
            return;
          }
          // Mode CRUD messages
          const modeReply = handleModeMessage(msg, repoRoot, extensionPath2);
          if (modeReply) {
            try { panel.webview.postMessage(modeReply); } catch {}
            session.setModes(loadMergedModes(repoRoot, extensionPath2));
            return;
          }
          // Instance management messages (async)
          let instanceReply;
          try {
            instanceReply = await handleInstanceMessage(msg, repoRoot, session.panelId, (m) => { try { panel.webview.postMessage(m); } catch {} }, extensionPath2);
          } catch (err) {
            console.error('[instance] handler error:', err);
            instanceReply = { type: 'instancesData', instances: [], panelId: session.panelId, _actionId: msg._actionId };
          }
          if (instanceReply) {
            try { panel.webview.postMessage(instanceReply); } catch {}
            if (instanceReply.novncPort) {
              try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
            }
            return;
          }
          if (msg.type === 'ready') {
            await handleReady(msg);
            return;
          }
          appendPanelDebugLog(repoRoot, `EXT-HOST(deserialized): forwarding to session.handleMessage type=${msg.type}`);
          session.handleMessage(msg);
          } catch (error) {
            appendPanelDebugLog(repoRoot, `EXT-HOST(deserialized) ERROR type=${msg && msg.type ? msg.type : 'unknown'} message=${error && error.message ? error.message : String(error)} stack=${error && error.stack ? error.stack.replace(/\s+/g, ' ') : ''}`);
            throw error;
          }
        },
        undefined,
        context.subscriptions
      );

      panel.webview.html = getWebviewHtml(panel, context.extensionUri);

      activePanels.add(panel);

      panel.onDidDispose(
        () => {
          activePanels.delete(panel);
          void cleanupPanelSession({
            repoRoot,
            panelId: session.panelId,
            session,
            instanceName,
            stopInstance,
            clearPanel,
            killChrome,
            closeAllConnections: closeAllCodexConnections,
          });
        },
        null,
        context.subscriptions
      );
}

async function deactivate() {
  await stopExtensionCloudSyncRuntime();
  await shutdownExtensionResources({
    stopTasksMcpServer,
    stopTestsMcpServer,
    stopMemoryMcpServer,
    stopQaDesktopMcpServer,
    killAll: killAllChrome,
    closeAllConnections: closeAllCodexConnections,
  });
}

module.exports = { activate, deactivate };
