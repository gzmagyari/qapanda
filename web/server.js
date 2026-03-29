#!/usr/bin/env node
/**
 * QA Panda — Standalone Web Server
 *
 * Serves the same webview UI as the VSCode extension over HTTP + WebSocket.
 * Each browser tab gets its own SessionManager (like a VSCode panel).
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

// ── Imports from extension (all pure Node.js, no VSCode) ─────────────
// webview-html is require()'d fresh per request for hot-reload (see HTTP handler below)
const WebviewRenderer = require(path.join(EXTENSION_DIR, 'webview-renderer')).WebviewRenderer
  || require(path.join(EXTENSION_DIR, 'webview-renderer'));
const SessionManager = require(path.join(EXTENSION_DIR, 'session-manager')).SessionManager
  || require(path.join(EXTENSION_DIR, 'session-manager'));
const { loadMergedAgents, loadAgentsFile } = require(path.join(EXTENSION_DIR, 'agents-store'));
const { loadMergedModes } = require(path.join(EXTENSION_DIR, 'modes-store'));
const { loadOnboarding, isOnboardingComplete, runFullDetection, completeOnboarding, runAutoFix } = require(path.join(EXTENSION_DIR, 'onboarding'));
const handlers = require(path.join(EXTENSION_DIR, 'message-handlers'));
const { loadSettings, saveSettings } = require(path.join(EXTENSION_DIR, 'settings-store'));
const { buildSelfTestingPrompt } = require(path.join(__dirname, '..', 'src', 'prompts'));
const { startTasksMcpServer } = require(path.join(EXTENSION_DIR, 'tasks-mcp-http'));
const { startTestsMcpServer } = require(path.join(EXTENSION_DIR, 'tests-mcp-http'));
const { startQaDesktopMcpServer } = require(path.join(EXTENSION_DIR, 'qa-desktop-mcp-server'));

// ── Config ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const repoRoot = process.argv[2] || process.cwd();
const extensionPath = EXTENSION_DIR;

// ── MIME types ───────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ── MCP HTTP servers (started once, shared across sessions) ──────────
let _tasksMcpPort = null;
let _testsMcpPort = null;
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
    const r = await startQaDesktopMcpServer(repoRoot);
    _qaDesktopMcpPort = r.port;
    console.log(`  QA Desktop MCP on port ${r.port}`);
  } catch (e) { console.error('Failed to start qa-desktop MCP:', e.message); }
}

// ── HTML template (generated fresh per request for hot-reload) ──────

// ── HTTP server ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    // Re-require webview-html.js to pick up changes (delete cache first for hot-reload)
    delete require.cache[require.resolve('../extension/webview-html')];
    const { getWebviewHtml: freshHtml } = require('../extension/webview-html');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(freshHtml({ styleHref: '/style.css', scriptSrc: '/main.js' }));
    return;
  }

  // Serve webview static files
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

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ─────────────────────────────────────────────────
let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
} catch {
  console.error('Error: "ws" package not found. Run: npm install ws');
  process.exit(1);
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const panelId = crypto.randomUUID();
  console.log(`[${panelId.slice(0, 8)}] Client connected`);

  // Duck-typed panel for WebviewRenderer
  const fakePanel = {
    webview: {
      postMessage(msg) {
        if (ws.readyState === 1) { // WebSocket.OPEN
          try { ws.send(JSON.stringify(msg)); } catch {}
        }
      },
    },
  };

  const renderer = new WebviewRenderer(fakePanel);
  const panelConfig = {};

  function postMessage(msg) {
    if (msg && msg.type === 'syncConfig' && msg.config) {
      Object.assign(panelConfig, msg.config);
    }
    fakePanel.webview.postMessage(msg);
  }

  const session = new SessionManager(renderer, {
    repoRoot,
    panelId,
    postMessage,
    initialConfig: panelConfig,
    extensionPath,
  });
  session._tasksMcpPort = _tasksMcpPort;
  session._testsMcpPort = _testsMcpPort;
  session._qaDesktopMcpPort = _qaDesktopMcpPort;
  session.setMcpServers(handlers.loadMergedMcpServers(repoRoot));
  session.setAgents(loadMergedAgents(repoRoot, extensionPath));
  session.setModes(loadMergedModes(repoRoot, extensionPath));
  session.prestart();

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || !msg.type) return;

    // ── Config ──
    if (msg.type === 'configChanged') {
      session.applyConfig(msg.config);
      Object.assign(panelConfig, msg.config);
      return;
    }

    // ── Debug logging ──
    if (msg.type === '_debugLog') {
      const logPath = path.join(os.homedir(), '.qpanda', 'wizard-debug.log');
      try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
      try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg.text}\n`); } catch {}
      return;
    }

    // ── Onboarding ──
    if (msg.type === 'onboardingDetect') {
      runFullDetection().then(detected => {
        postMessage({ type: 'onboardingDetected', detected });
      }).catch(() => {
        postMessage({ type: 'onboardingDetected', detected: null, error: 'Detection failed' });
      });
      return;
    }
    if (msg.type === 'onboardingAutoFix') {
      runAutoFix(msg.step,
        (text) => postMessage({ type: 'onboardingFixProgress', step: msg.step, text }),
        (success, error) => postMessage({ type: 'onboardingFixDone', step: msg.step, success, error })
      );
      return;
    }
    if (msg.type === 'onboardingSave') {
      const bundledPath = path.join(extensionPath, 'resources', 'system-agents.json');
      const bundledAgents = loadAgentsFile(bundledPath);
      const result = completeOnboarding({ preference: msg.preference, detected: msg.detected, bundledAgents });
      const agentsData = loadMergedAgents(repoRoot, extensionPath);
      session.setAgents(agentsData);
      postMessage({ type: 'onboardingComplete', onboarding: { complete: true, data: result } });
      postMessage({ type: 'agentsData', agents: agentsData });
      return;
    }

    // ── Ready (init) ──
    if (msg.type === 'ready') {
      const mcpData = handlers.loadMergedMcpServers(repoRoot);
      const agentsData = loadMergedAgents(repoRoot, extensionPath);
      const modesData = loadMergedModes(repoRoot, extensionPath);
      const onboardingData = loadOnboarding();
      postMessage({
        type: 'initConfig',
        config: panelConfig,
        mcpServers: mcpData,
        agents: agentsData,
        modes: modesData,
        panelId,
        runId: msg.runId || null,
        onboarding: { complete: isOnboardingComplete(), data: onboardingData },
        featureFlags: require(path.join(__dirname, '..', 'src', 'feature-flags')).loadFeatureFlags(),
      });
      return;
    }

    // ── MCP server config ──
    if (msg.type === 'mcpServersChanged') {
      const scope = msg.scope;
      const filePath = scope === 'global' ? handlers.globalMcpPath() : handlers.projectMcpPath(repoRoot);
      handlers.saveMcpFile(filePath, msg.servers);
      const mcpData = handlers.loadMergedMcpServers(repoRoot);
      session.setMcpServers(mcpData);
      return;
    }
    if (msg.type === 'settingsLoad') {
      postMessage({ type: 'settingsData', settings: loadSettings(), defaults: buildSelfTestingPrompt.DEFAULTS });
      return;
    }
    if (msg.type === 'settingsSave') {
      const updated = saveSettings(msg.settings || {});
      session._selfTesting = !!updated.selfTesting;
      postMessage({ type: 'settingsData', settings: updated, defaults: buildSelfTestingPrompt.DEFAULTS });
      return;
    }

    // ── Panel title (no-op in web) ──
    if (msg.type === 'setPanelTitle') return;

    // ── CRUD handlers ──
    const taskReply = handlers.handleTaskMessage(msg, repoRoot);
    if (taskReply) { postMessage(taskReply); return; }

    const testReply = handlers.handleTestMessage(msg, repoRoot);
    if (testReply) { postMessage(testReply); return; }

    const agentReply = handlers.handleAgentMessage(msg, repoRoot, extensionPath);
    if (agentReply) {
      postMessage(agentReply);
      session.setAgents(loadMergedAgents(repoRoot, extensionPath));
      return;
    }

    const modeReply = handlers.handleModeMessage(msg, repoRoot, extensionPath);
    if (modeReply) {
      postMessage(modeReply);
      session.setModes(loadMergedModes(repoRoot, extensionPath));
      return;
    }

    const instanceReply = await handlers.handleInstanceMessage(msg, repoRoot, panelId, postMessage, extensionPath);
    if (instanceReply) { postMessage(instanceReply); return; }

    // ── Fallthrough to SessionManager ──
    session.handleMessage(msg);
  });

  ws.on('close', () => {
    console.log(`[${panelId.slice(0, 8)}] Client disconnected`);
    session.dispose();
  });
});

// ── Hot reload (file watcher) ────────────────────────────────────────
function startFileWatcher() {
  const watchDirs = [
    path.join(EXTENSION_DIR, 'webview'),
    EXTENSION_DIR,                          // webview-html.js, session-manager.js, etc.
    path.join(__dirname, '..', 'src'),
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

// ── Start ────────────────────────────────────────────────────────────
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

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
