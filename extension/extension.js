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
let findExistingDesktop;
let globalMcpPath, projectMcpPath, loadMcpFile, saveMcpFile, loadMergedMcpServers, handleTaskMessage, handleTestMessage, handleAgentMessage, handleModeMessage, handleInstanceMessage;
let startTasksMcpServer, stopTasksMcpServer;
let startTestsMcpServer, stopTestsMcpServer;
let startQaDesktopMcpServer, stopQaDesktopMcpServer;
let loadOnboarding, isOnboardingComplete, runFullDetection, completeOnboarding, runAutoFix;
let loadSettings, saveSettings;
let buildSelfTestingPrompt;
let loadFeatureFlags;
let exportQaReportPdf;
let buildApiCatalogPayload;

try {
  ({ WebviewRenderer } = require('./webview-renderer'));
  _aDbg('require OK: webview-renderer');
  ({ SessionManager } = require('./session-manager'));
  _aDbg('require OK: session-manager');
  ({ globalAgentsPath, projectAgentsPath, systemAgentsOverridePath, loadAgentsFile, saveAgentsFile, loadSystemAgents, loadMergedAgents } = require('./agents-store'));
  _aDbg('require OK: agents-store');
  ({ loadMergedModes, saveModesFile, globalModesPath, projectModesPath, systemModesOverridePath, loadModesFile } = require('./modes-store'));
  _aDbg('require OK: modes-store');
  ({ findExistingDesktop } = require('./src/remote-desktop'));
  _aDbg('require OK: remote-desktop');
  ({ globalMcpPath, projectMcpPath, loadMcpFile, saveMcpFile, loadMergedMcpServers, handleTaskMessage, handleTestMessage, handleAgentMessage, handleModeMessage, handleInstanceMessage } = require('./message-handlers'));
  _aDbg('require OK: message-handlers');
  ({ startTasksMcpServer, stopTasksMcpServer } = require('./tasks-mcp-http'));
  _aDbg('require OK: tasks-mcp-http');
  ({ startTestsMcpServer, stopTestsMcpServer } = require('./tests-mcp-http'));
  _aDbg('require OK: tests-mcp-http');
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
  ({ exportQaReportPdf } = require('./qa-report-export'));
  _aDbg('All top-level requires succeeded');
} catch (e) {
  _aDbg(`TOP-LEVEL REQUIRE FAILED: ${e.message}\n${e.stack}`);
  throw e;
}

const activePanels = new Set();
let _tasksMcpPort = null;
let _testsMcpPort = null;
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
  const defaultTasksFile = path.join(getRepoRoot(context.extensionUri), '.qpanda', 'tasks.json');
  startTasksMcpServer(defaultTasksFile).then(r => { _tasksMcpPort = r.port; }).catch(e => console.error('[ext] Failed to start tasks MCP:', e));
  const defaultTestsFile = path.join(getRepoRoot(context.extensionUri), '.qpanda', 'tests.json');
  startTestsMcpServer(defaultTestsFile, defaultTasksFile).then(r => { _testsMcpPort = r.port; }).catch(e => console.error('[ext] Failed to start tests MCP:', e));
  const defaultRepoRoot = getRepoRoot(context.extensionUri);
  _aDbg('checkpoint: calling loadFeatureFlags');
  if (loadFeatureFlags(context.extensionUri.fsPath).enableRemoteDesktop) {
    startQaDesktopMcpServer(defaultRepoRoot).then(r => { _qaDesktopMcpPort = r.port; }).catch(e => console.error('[ext] Failed to start qa-desktop MCP:', e));
  }

  _aDbg('checkpoint: registering qapanda.open command');
  const openCommand = vscode.commands.registerCommand('qapanda.open', () => {
    _aDbg('qapanda.open invoked');
    const title = activePanels.size === 0 ? 'QA Panda' : `QA Panda (${activePanels.size + 1})`;
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
    panel.webview.html = getWebviewHtml(panel, context.extensionUri);

    const renderer = new WebviewRenderer(panel);
    const repoRoot = getRepoRoot(context.extensionUri);

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
      postMessage,
      initialConfig: panelConfig,
      extensionPath: context.extensionUri.fsPath,
    });
    // Pass HTTP MCP server ports so agents can reach them
    session._tasksMcpPort = _tasksMcpPort;
    session._testsMcpPort = _testsMcpPort;
    session._qaDesktopMcpPort = _qaDesktopMcpPort;
    // Initialize MCP servers and agents from disk
    const extensionPath1 = context.extensionUri.fsPath;
    session.setMcpServers(loadMergedMcpServers(repoRoot));
    session.setAgents(loadMergedAgents(repoRoot, extensionPath1));
    // prestart() is called in the 'ready' handler below, after panelId is stabilized

    const _extDbg = (msg) => { try { fs.appendFileSync(path.join(os.tmpdir(), 'cc-chrome-debug.log'), `[${new Date().toISOString()}] [ext] ${msg}\n`); } catch {} };

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.type === 'configChanged') {
          session.applyConfig(msg.config);
          Object.assign(panelConfig, msg.config);
          return;
        }
        if (msg.type === '_debugLog') {
          const logPath = path.join(os.homedir(), '.qpanda', 'wizard-debug.log');
          try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
          try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg.text}\n`); } catch {}
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
          // Debug: log that we got ready message
          const _dlog = path.join(os.homedir(), '.qpanda', 'wizard-debug.log');
          try { fs.mkdirSync(path.dirname(_dlog), { recursive: true }); } catch {}
          try { fs.appendFileSync(_dlog, `[${new Date().toISOString()}] EXT-HOST: ready received, repoRoot=${repoRoot}, msg.runId=${msg.runId}, msg.panelId=${msg.panelId}\n`); } catch {}
          // Restore panelId from webview persisted state if available
          _extDbg(`ready: msg.panelId=${msg.panelId} current _panelId=${session._panelId}`);
          if (msg.panelId) session._panelId = msg.panelId;
          _extDbg(`ready: after restore _panelId=${session._panelId}`);
          const mcpData = loadMergedMcpServers(repoRoot);
          const agentsData = loadMergedAgents(repoRoot, extensionPath1);
          const modesData = loadMergedModes(repoRoot, extensionPath1);
          const onboardingData = loadOnboarding();
          panel.webview.postMessage({ type: 'initConfig', config: panelConfig, mcpServers: mcpData, agents: agentsData, modes: modesData, panelId: session.panelId, runId: msg.runId || null, onboarding: { complete: isOnboardingComplete(), data: onboardingData }, featureFlags: loadFeatureFlags(context.extensionUri.fsPath), apiCatalog: buildApiCatalogPayload() });
          // Re-link to existing container if still running (don't create a new one)
          if (msg.panelId) {
            findExistingDesktop(repoRoot, session.panelId).then(desktop => {
              if (desktop) {
                try { panel.webview.postMessage({ type: 'desktopReady', novncPort: desktop.novncPort }); } catch {}
              }
            }).catch(() => {});
          }
          // Pre-start Chrome + Codex app-server now that panelId is stable
          _extDbg(`ready: calling prestart() with stable panelId=${session._panelId}`);
          session.prestart();
          return;
        }
        if (msg.type === 'mcpServersChanged') {
          const scope = msg.scope;
          const servers = msg.servers;
          const filePath = scope === 'global' ? globalMcpPath() : projectMcpPath(repoRoot);
          saveMcpFile(filePath, servers);
          const mcpData = loadMergedMcpServers(repoRoot);
          session.setMcpServers(mcpData);
          return;
        }
        if (msg.type === 'settingsLoad') {
          try { panel.webview.postMessage({ type: 'settingsData', settings: loadSettings(), defaults: buildSelfTestingPrompt.DEFAULTS }); } catch {}
          return;
        }
        if (msg.type === 'settingsSave') {
          const updated = saveSettings(msg.settings || {});
          session._selfTesting = !!updated.selfTesting;
          try { panel.webview.postMessage({ type: 'settingsData', settings: updated, defaults: buildSelfTestingPrompt.DEFAULTS }); } catch {}
          return;
        }
        if (await handleQaReportExportMessage(msg, repoRoot)) {
          return;
        }
        // Task CRUD messages
        const taskReply = handleTaskMessage(msg, repoRoot);
        if (taskReply) { try { panel.webview.postMessage(taskReply); } catch {} return; }
        // Test CRUD messages
        const testReply = handleTestMessage(msg, repoRoot);
        if (testReply) { try { panel.webview.postMessage(testReply); } catch {} return; }
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
          instanceReply = await _instancesData(repoRoot, session.panelId, {}, msg._actionId).catch(() => ({ type: 'instancesData', instances: [], panelId: session.panelId, _actionId: msg._actionId }));
        }
        if (instanceReply) {
          try { panel.webview.postMessage(instanceReply); } catch {}
          if (instanceReply.novncPort) {
            try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
          }
          return;
        }
        session.handleMessage(msg);
      },
      undefined,
      context.subscriptions
    );

    activePanels.add(panel);

    panel.onDidDispose(
      () => {
        activePanels.delete(panel);
        // Stop the Docker container linked to this panel
        const name = instanceName(repoRoot, session.panelId);
        stopInstance(name).catch(() => {});
        // Kill headless Chrome for this panel
        try { require('./chrome-manager').killChrome(session.panelId); } catch {}
        // Clean up any app-server connections for this session
        try { require('./src/codex-app-server').closeAllConnections(); } catch {}
        session.dispose();
      },
      null,
      context.subscriptions
    );

    renderer.banner('\uD83D\uDC3C QA Panda interactive session');
    renderer.banner(`Repo root: ${repoRoot}`);
    renderer.banner('Type /help for commands, or type a message to start.');
  });

  _aDbg('checkpoint: command registered, pushing to subscriptions');
  context.subscriptions.push(openCommand);

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
      panel.webview.html = getWebviewHtml(panel, context.extensionUri);

      const renderer = new WebviewRenderer(panel);
      const repoRoot = getRepoRoot(context.extensionUri);
      // Per-panel config restored from webview state (per-panel, not shared)
      const panelConfig = (state && state.config) || {};
      const savedRunId = (state && state.runId) || null;

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
        postMessage,
        initialConfig: panelConfig,
        extensionPath: context.extensionUri.fsPath,
      });
      session._tasksMcpPort = _tasksMcpPort;
      session._qaDesktopMcpPort = _qaDesktopMcpPort;
      const extensionPath2 = context.extensionUri.fsPath;
      session.setMcpServers(loadMergedMcpServers(repoRoot));
      session.setAgents(loadMergedAgents(repoRoot, extensionPath2));
      // prestart() is called in the 'ready' handler below, after panelId is stabilized

      const _extDbg2 = (msg) => { try { fs.appendFileSync(path.join(os.tmpdir(), 'cc-chrome-debug.log'), `[${new Date().toISOString()}] [ext-deser] ${msg}\n`); } catch {} };

      panel.webview.onDidReceiveMessage(
        async (msg) => {
          if (msg.type === '_debugLog') {
            const logPath = path.join(repoRoot, '.qpanda', 'wizard-debug.log');
            try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
            try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg.text}\n`); } catch {}
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
            saveMcpFile(filePath, servers);
            const mcpData = loadMergedMcpServers(repoRoot);
            session.setMcpServers(mcpData);
            return;
          }
          if (msg.type === 'settingsLoad') {
            try { panel.webview.postMessage({ type: 'settingsData', settings: loadSettings(), defaults: buildSelfTestingPrompt.DEFAULTS }); } catch {}
            return;
          }
          if (msg.type === 'settingsSave') {
            const updated = saveSettings(msg.settings || {});
            session._selfTesting = !!updated.selfTesting;
            try { panel.webview.postMessage({ type: 'settingsData', settings: updated, defaults: buildSelfTestingPrompt.DEFAULTS }); } catch {}
            return;
          }
          if (await handleQaReportExportMessage(msg, repoRoot)) {
            return;
          }
          // Task CRUD messages
          const taskReply = handleTaskMessage(msg, repoRoot);
          if (taskReply) { try { panel.webview.postMessage(taskReply); } catch {} return; }
          // Test CRUD messages
          const testReply = handleTestMessage(msg, repoRoot);
          if (testReply) { try { panel.webview.postMessage(testReply); } catch {} return; }
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
            instanceReply = await _instancesData(repoRoot, session.panelId, {}, msg._actionId).catch(() => ({ type: 'instancesData', instances: [], panelId: session.panelId, _actionId: msg._actionId }));
          }
          if (instanceReply) {
            try { panel.webview.postMessage(instanceReply); } catch {}
            if (instanceReply.novncPort) {
              try { panel.webview.postMessage({ type: 'desktopReady', novncPort: instanceReply.novncPort }); } catch {}
            }
            return;
          }
          if (msg.type === 'ready') {
            // Debug: log that we got ready message (deserialized)
            const _dlog2 = path.join(os.homedir(), '.qpanda', 'wizard-debug.log');
            try { fs.mkdirSync(path.dirname(_dlog2), { recursive: true }); } catch {}
            try { fs.appendFileSync(_dlog2, `[${new Date().toISOString()}] EXT-HOST(deserialized): ready received, repoRoot=${repoRoot}, msg.runId=${msg.runId}, savedRunId=${savedRunId}, msg.panelId=${msg.panelId}\n`); } catch {}
            // Restore panelId from webview persisted state if available
            _extDbg2(`ready: msg.panelId=${msg.panelId} current _panelId=${session._panelId}`);
            if (msg.panelId) session._panelId = msg.panelId;
            _extDbg2(`ready: after restore _panelId=${session._panelId}`);
            const mcpData = loadMergedMcpServers(repoRoot);
            const agentsData = loadMergedAgents(repoRoot, extensionPath2);
            const modesData = loadMergedModes(repoRoot, extensionPath2);
            const onboardingData2 = loadOnboarding();
            panel.webview.postMessage({ type: 'initConfig', config: panelConfig, mcpServers: mcpData, agents: agentsData, modes: modesData, panelId: session.panelId, runId: msg.runId || savedRunId || null, onboarding: { complete: isOnboardingComplete(), data: onboardingData2 }, featureFlags: loadFeatureFlags(context.extensionUri.fsPath), apiCatalog: buildApiCatalogPayload() });
            // Re-link to existing container if still running (don't create a new one)
            if (msg.panelId) {
              findExistingDesktop(repoRoot, session.panelId).then(desktop => {
                if (desktop) {
                  try { panel.webview.postMessage({ type: 'desktopReady', novncPort: desktop.novncPort }); } catch {}
                }
              }).catch(() => {});
            }
            // Pre-start Chrome + Codex app-server now that panelId is stable
            _extDbg2(`ready: calling prestart() with stable panelId=${session._panelId}`);
            session.prestart();
            // Reattach to saved run if the webview had one before reload
            const runId = msg.runId || savedRunId;
            if (runId) {
              const ok = await session.reattachRun(runId);
              if (ok) {
                await session.sendTranscript();
                renderer.banner(`Reattached to run ${session.getRunId()}`);
                await session.sendProgress();
                session._restoreWaitTimer();
              } else {
                renderer.banner(`Previous run ${runId} no longer exists. Starting fresh.`);
              }
            }
            return;
          }
          session.handleMessage(msg);
        },
        undefined,
        context.subscriptions
      );

      activePanels.add(panel);

      panel.onDidDispose(
        () => {
          activePanels.delete(panel);
          const name = instanceName(repoRoot, session.panelId);
          stopInstance(name).catch(() => {});
          try { require('./chrome-manager').killChrome(session.panelId); } catch {}
          try { require('./src/codex-app-server').closeAllConnections(); } catch {}
          session.dispose();
        },
        null,
        context.subscriptions
      );
}

function deactivate() {
  stopTasksMcpServer().catch(() => {});
  stopQaDesktopMcpServer().catch(() => {});
  try { require('./chrome-manager').killAll(); } catch {}
  // Clean up any persistent Codex app-server connections
  try { require('./src/codex-app-server').closeAllConnections(); } catch {}
}

module.exports = { activate, deactivate };
