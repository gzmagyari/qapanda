#!/usr/bin/env node
/**
 * QA Panda — Standalone Web Server
 *
 * Serves the same webview UI as the VS Code extension over HTTP + WebSocket.
 * Browser reconnects should reuse the same SessionManager instead of tearing it
 * down immediately on socket close.
 *
 * Usage:
 *   node web/server.js [repoRoot]
 *   npm run web -- /path/to/repo
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const EXTENSION_DIR = path.resolve(__dirname, '..', 'extension');

const WebviewRenderer = require(path.join(EXTENSION_DIR, 'webview-renderer')).WebviewRenderer
  || require(path.join(EXTENSION_DIR, 'webview-renderer'));
const SessionManager = require(path.join(EXTENSION_DIR, 'session-manager')).SessionManager
  || require(path.join(EXTENSION_DIR, 'session-manager'));
const { loadMergedAgents, loadAgentsFile } = require(path.join(EXTENSION_DIR, 'agents-store'));
const { loadMergedModes } = require(path.join(EXTENSION_DIR, 'modes-store'));
const {
  loadOnboarding,
  isOnboardingComplete,
  runFullDetection,
  completeOnboarding,
  runAutoFix,
} = require(path.join(EXTENSION_DIR, 'onboarding'));
const handlers = require(path.join(EXTENSION_DIR, 'message-handlers'));
const { loadSettings, saveSettings } = require(path.join(EXTENSION_DIR, 'settings-store'));
const { buildSelfTestingPrompt } = require(path.join(__dirname, '..', 'src', 'prompts'));
const { loadFeatureFlags } = require(path.join(__dirname, '..', 'src', 'feature-flags'));
const { buildApiCatalogPayload } = require(path.join(__dirname, '..', 'src', 'model-catalog'));
const { createCloudBoundary } = require(path.join(__dirname, '..', 'src', 'cloud'));
const { findExistingDesktop } = require(path.join(__dirname, '..', 'src', 'remote-desktop'));
const { startTasksMcpServer } = require(path.join(EXTENSION_DIR, 'tasks-mcp-http'));
const { startTestsMcpServer } = require(path.join(EXTENSION_DIR, 'tests-mcp-http'));
const { startMemoryMcpServer } = require(path.join(EXTENSION_DIR, 'memory-mcp-http'));
const { startQaDesktopMcpServer } = require(path.join(EXTENSION_DIR, 'qa-desktop-mcp-server'));
const {
  defaultQaReportPdfFileName,
  writeQaReportPdf,
} = require(path.join(EXTENSION_DIR, 'qa-report-export'));
const { SessionRegistry } = require(path.join(__dirname, 'session-registry'));

const PORT = parseInt(process.env.PORT || '3000', 10);
const repoRoot = process.argv[2] || process.cwd();
const extensionPath = EXTENSION_DIR;
const cloudBoundary = createCloudBoundary({ target: 'web', repoRoot });
const cloudBootstrapPromise = cloudBoundary.preload().catch((error) => cloudBoundary.summarize(error));
const SESSION_RECONNECT_GRACE_MS = parseInt(process.env.WS_RECONNECT_GRACE_MS || '15000', 10);
const WEB_EXPORTS_DIR = path.join(repoRoot, '.qpanda', 'exports');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

let _tasksMcpPort = null;
let _testsMcpPort = null;
let _memoryMcpPort = null;
let _qaDesktopMcpPort = null;

async function startMcpServers() {
  const tasksFile = path.join(repoRoot, '.qpanda', 'tasks.json');
  const testsFile = path.join(repoRoot, '.qpanda', 'tests.json');
  try {
    const r = await startTasksMcpServer(tasksFile);
    _tasksMcpPort = r.port;
    console.log(`  Tasks MCP on port ${r.port}`);
  } catch (e) { console.error('Failed to start tasks MCP:', e.message); }
  try {
    const r = await startTestsMcpServer(testsFile, tasksFile);
    _testsMcpPort = r.port;
    console.log(`  Tests MCP on port ${r.port}`);
  } catch (e) { console.error('Failed to start tests MCP:', e.message); }
  try {
    const r = await startMemoryMcpServer(path.join(repoRoot, '.qpanda', 'MEMORY.md'));
    _memoryMcpPort = r.port;
    console.log(`  Memory MCP on port ${r.port}`);
  } catch (e) { console.error('Failed to start memory MCP:', e.message); }
  try {
    const r = await startQaDesktopMcpServer(repoRoot);
    _qaDesktopMcpPort = r.port;
    console.log(`  QA Desktop MCP on port ${r.port}`);
  } catch (e) { console.error('Failed to start qa-desktop MCP:', e.message); }
}

function safeExportName(fileName) {
  const base = String(fileName || '').trim();
  if (!base) return null;
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return null;
  return base;
}

function uniqueExportPath(fileName) {
  const ext = path.extname(fileName) || '.pdf';
  const stem = path.basename(fileName, ext);
  let candidate = fileName;
  let index = 1;
  while (fs.existsSync(path.join(WEB_EXPORTS_DIR, candidate))) {
    candidate = `${stem} (${index})${ext}`;
    index += 1;
  }
  return path.join(WEB_EXPORTS_DIR, candidate);
}

async function exportQaReportPdfForWeb(msg) {
  const baseName = defaultQaReportPdfFileName({
    label: msg.label,
    scope: msg.scope,
    updatedAt: msg.updatedAt,
  });
  const filePath = uniqueExportPath(baseName);
  await writeQaReportPdf(filePath, {
    label: msg.label || 'QA Report',
    scope: msg.scope || 'run',
    updatedAt: msg.updatedAt || '',
    section: msg.section || {},
  });
  const fileName = path.basename(filePath);
  return {
    filePath,
    fileName,
    url: `/exports/${encodeURIComponent(fileName)}`,
  };
}

const server = http.createServer((req, res) => {
  const url = String(req.url || '').split('?')[0];

  if (url === '/' || url === '/index.html') {
    delete require.cache[require.resolve('../extension/webview-html')];
    const { getWebviewHtml: freshHtml } = require('../extension/webview-html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(freshHtml({ styleHref: '/style.css', scriptSrc: '/main.js' }));
    return;
  }

  if (url === '/main.js' || url === '/style.css') {
    const filePath = path.join(EXTENSION_DIR, 'webview', url === '/main.js' ? 'main.js' : 'style.css');
    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  if (url.startsWith('/exports/')) {
    let requested = null;
    try {
      requested = safeExportName(decodeURIComponent(url.slice('/exports/'.length)));
    } catch {
      requested = null;
    }
    if (!requested) {
      res.writeHead(400);
      res.end('Bad export path');
      return;
    }
    const exportsRoot = path.resolve(WEB_EXPORTS_DIR);
    const filePath = path.resolve(exportsRoot, requested);
    if (path.dirname(filePath) !== exportsRoot) {
      res.writeHead(400);
      res.end('Bad export path');
      return;
    }
    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': MIME['.pdf'],
        'Content-Disposition': `attachment; filename="${requested.replace(/"/g, '')}"`,
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  console.error('Error: "ws" package not found. Run: npm install ws');
  process.exit(1);
}

const sessionRegistry = new SessionRegistry({ graceMs: SESSION_RECONNECT_GRACE_MS });

function sendWs(ws, msg) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const tempConnectionId = crypto.randomUUID();
  console.log(`[${tempConnectionId.slice(0, 8)}] Client connected`);

  let attachedEntry = null;
  let pendingConfig = {};

  function entryPostMessage(msg) {
    const socket = attachedEntry && attachedEntry.connection ? attachedEntry.connection.ws : ws;
    sendWs(socket, msg);
  }

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || !msg.type) return;

    try {
      if (msg.type === '_debugLog') {
        const logPath = path.join(os.homedir(), '.qpanda', 'wizard-debug.log');
        try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
        try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg.text}\n`); } catch {}
        return;
      }

      if (msg.type === 'configChanged') {
        if (attachedEntry) {
          attachedEntry.session.applyConfig(msg.config);
          Object.assign(attachedEntry.panelConfig, msg.config || {});
        } else {
          Object.assign(pendingConfig, msg.config || {});
        }
        return;
      }

      if (msg.type === 'ready') {
        const restoredPanelId = typeof msg.panelId === 'string' && msg.panelId.trim()
          ? msg.panelId.trim()
          : crypto.randomUUID();
        const pendingConfigFromSocket = { ...pendingConfig };
        const attachResult = sessionRegistry.attach(restoredPanelId, {
          ws,
          createEntry(panelId, connection) {
            const fakePanel = {
              webview: {
                postMessage(outbound) {
                  sendWs(connection.ws, outbound);
                },
              },
            };
            const renderer = new WebviewRenderer(fakePanel);
            const panelConfig = { ...pendingConfig };
            const session = new SessionManager(renderer, {
              repoRoot,
              panelId,
              postMessage(outbound) {
                if (outbound && outbound.type === 'syncConfig' && outbound.config) {
                  Object.assign(panelConfig, outbound.config);
                }
                sendWs(connection.ws, outbound);
              },
              initialConfig: panelConfig,
              extensionPath,
            });
            session._tasksMcpPort = _tasksMcpPort;
            session._testsMcpPort = _testsMcpPort;
            session._memoryMcpPort = _memoryMcpPort;
            session._qaDesktopMcpPort = _qaDesktopMcpPort;
            return { session, renderer, panelConfig };
          },
        });

        attachedEntry = attachResult.entry;
        if (!attachResult.created && Object.keys(pendingConfigFromSocket).length > 0) {
          Object.assign(attachedEntry.panelConfig, pendingConfigFromSocket);
          attachedEntry.session.applyConfig(pendingConfigFromSocket);
        }

        const cloud = await cloudBootstrapPromise;
        const mcpData = handlers.loadMergedMcpServers(repoRoot);
        const agentsData = loadMergedAgents(repoRoot, extensionPath);
        const modesData = loadMergedModes(repoRoot, extensionPath);
        attachedEntry.session.setMcpServers(mcpData);
        attachedEntry.session.setAgents(agentsData);
        attachedEntry.session.setModes(modesData);

        const onboardingData = loadOnboarding();
        const requestedRunId = msg.runId || attachedEntry.session.getRunId() || null;
        const reattached = requestedRunId
          ? await attachedEntry.session.reattachRun(requestedRunId, { suppressUi: true })
          : false;

        if (attachedEntry.session.panelId !== restoredPanelId) {
          attachedEntry = sessionRegistry.rekey(restoredPanelId, attachedEntry.session.panelId) || attachedEntry;
        }
        if (reattached) {
          Object.assign(attachedEntry.panelConfig, attachedEntry.session.getConfig());
        }
        pendingConfig = attachedEntry.panelConfig;

        entryPostMessage({
          type: 'initConfig',
          config: reattached ? attachedEntry.session.getConfig() : attachedEntry.panelConfig,
          mcpServers: mcpData,
          agents: agentsData,
          modes: modesData,
          panelId: attachedEntry.session.panelId,
          runId: reattached ? attachedEntry.session.getRunId() : null,
          onboarding: { complete: isOnboardingComplete(), data: onboardingData },
          featureFlags: loadFeatureFlags(path.join(__dirname, '..')),
          apiCatalog: buildApiCatalogPayload(),
          cloud,
        });

        if (msg.panelId || reattached) {
          findExistingDesktop(repoRoot, attachedEntry.session.panelId).then((desktop) => {
            if (desktop) {
              entryPostMessage({ type: 'desktopReady', novncPort: desktop.novncPort });
            }
          }).catch(() => {});
        }

        if (reattached) {
          attachedEntry.session.syncAttachedRunState();
          await attachedEntry.session.sendTranscript();
          attachedEntry.renderer.banner(`Reattached to run ${attachedEntry.session.getRunId()}`);
          await attachedEntry.session.sendProgress();
          attachedEntry.session._restoreWaitTimer();
        } else if (requestedRunId) {
          attachedEntry.renderer.banner(`Previous run ${requestedRunId} no longer exists. Starting fresh.`);
        }

        if (attachResult.created) {
          attachedEntry.session.prestart();
        }
        return;
      }

      if (!attachedEntry) return;

      if (msg.type === 'onboardingDetect') {
        runFullDetection().then((detected) => {
          entryPostMessage({ type: 'onboardingDetected', detected });
        }).catch(() => {
          entryPostMessage({ type: 'onboardingDetected', detected: null, error: 'Detection failed' });
        });
        return;
      }

      if (msg.type === 'onboardingAutoFix') {
        runAutoFix(
          msg.step,
          (text) => entryPostMessage({ type: 'onboardingFixProgress', step: msg.step, text }),
          (success, error) => entryPostMessage({ type: 'onboardingFixDone', step: msg.step, success, error }),
        );
        return;
      }

      if (msg.type === 'onboardingSave') {
        const bundledPath = path.join(extensionPath, 'resources', 'system-agents.json');
        const bundledAgents = loadAgentsFile(bundledPath);
        const result = completeOnboarding({ preference: msg.preference, detected: msg.detected, bundledAgents });
        const agentsData = loadMergedAgents(repoRoot, extensionPath);
        attachedEntry.session.setAgents(agentsData);
        entryPostMessage({ type: 'onboardingComplete', onboarding: { complete: true, data: result } });
        entryPostMessage({ type: 'agentsData', agents: agentsData });
        return;
      }

      if (msg.type === 'mcpServersChanged') {
        const scope = msg.scope;
        const filePath = scope === 'global' ? handlers.globalMcpPath() : handlers.projectMcpPath(repoRoot);
        const previousServers = scope === 'project' ? handlers.loadMcpFile(filePath) : null;
        handlers.saveMcpFile(filePath, msg.servers);
        if (scope === 'project') {
          void handlers.queueProjectMcpSyncChanges(repoRoot, previousServers, msg.servers);
        }
        attachedEntry.session.setMcpServers(handlers.loadMergedMcpServers(repoRoot));
        return;
      }

      if (msg.type === 'settingsLoad') {
        entryPostMessage({ type: 'settingsData', settings: loadSettings(), defaults: buildSelfTestingPrompt.DEFAULTS });
        return;
      }

      if (msg.type === 'settingsSave') {
        const updated = saveSettings(msg.settings || {});
        attachedEntry.session._selfTesting = !!updated.selfTesting;
        entryPostMessage({ type: 'settingsData', settings: updated, defaults: buildSelfTestingPrompt.DEFAULTS });
        return;
      }

      const projectContextReply = handlers.handleProjectContextMessage(msg, repoRoot);
      if (projectContextReply) {
        entryPostMessage(projectContextReply);
        return;
      }
      if (msg.type === 'setPanelTitle') return;

      if (msg.type === 'qaReportExportPdf') {
        const exported = await exportQaReportPdfForWeb(msg);
        entryPostMessage({ type: 'qaReportExported', ...exported });
        attachedEntry.renderer.banner(`QA report saved to ${exported.filePath}`);
        return;
      }

      const taskReply = await handlers.handleTaskMessage(msg, repoRoot);
      if (taskReply) {
        entryPostMessage(taskReply);
        return;
      }

      const testReply = await handlers.handleTestMessage(msg, repoRoot);
      if (testReply) {
        entryPostMessage(testReply);
        return;
      }

      const agentReply = handlers.handleAgentMessage(msg, repoRoot, extensionPath);
      if (agentReply) {
        entryPostMessage(agentReply);
        attachedEntry.session.setAgents(loadMergedAgents(repoRoot, extensionPath));
        return;
      }

      const modeReply = handlers.handleModeMessage(msg, repoRoot, extensionPath);
      if (modeReply) {
        entryPostMessage(modeReply);
        attachedEntry.session.setModes(loadMergedModes(repoRoot, extensionPath));
        return;
      }

      const instanceReply = await handlers.handleInstanceMessage(
        msg,
        repoRoot,
        attachedEntry.session.panelId,
        entryPostMessage,
        extensionPath,
      );
      if (instanceReply) {
        entryPostMessage(instanceReply);
        return;
      }

      await attachedEntry.session.handleMessage(msg);
    } catch (error) {
      console.error('[web] handler error:', error);
      entryPostMessage({
        type: 'banner',
        text: `Error: ${error && error.message ? error.message : String(error)}`,
      });
    }
  });

  ws.on('close', () => {
    const panelId = attachedEntry && attachedEntry.panelId;
    const label = panelId || tempConnectionId;
    console.log(`[${label.slice(0, 8)}] Client disconnected`);
    if (panelId) {
      sessionRegistry.detach(panelId);
    }
  });
});

function startFileWatcher() {
  const watchDirs = [
    path.join(EXTENSION_DIR, 'webview'),
    EXTENSION_DIR,
    path.join(__dirname, '..', 'src'),
    __dirname,
  ];
  for (const dir of watchDirs) {
    try {
      fs.watch(dir, { recursive: false }, () => {
        for (const client of wss.clients) {
          if (client.readyState === 1) {
            try { client.send(JSON.stringify({ type: '_reload' })); } catch {}
          }
        }
      });
    } catch {}
  }
}

async function main() {
  console.log('QA Panda Web Server');
  console.log(`  Repo root: ${repoRoot}`);
  console.log('  Starting MCP servers...');
  await startMcpServers();

  startFileWatcher();

  server.listen(PORT, () => {
    console.log(`\n  Ready: http://localhost:${PORT}\n`);
  });
}

process.on('SIGINT', () => {
  sessionRegistry.disposeAll();
  process.exit(130);
});

process.on('SIGTERM', () => {
  sessionRegistry.disposeAll();
  process.exit(143);
});

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
