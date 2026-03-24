/**
 * Manages headless Chrome instances for local agents.
 * Each cc-manager panel gets its own Chrome on a unique debug port.
 * Provides CDP-based Page.startScreencast streaming.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const _debugLogPath = path.join(require('node:os').homedir(), 'Desktop', 'cc-chrome-debug.log');
function _dbg(msg) {
  try { fs.appendFileSync(_debugLogPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// Per-panel Chrome instances: panelId -> { port, process, ws, frameCallback, nextId }
const _instances = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function _findChromeBinary() {
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } else if (process.platform === 'darwin') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(mac)) return mac;
  }
  // Fallback to PATH
  const { execSync } = require('node:child_process');
  try {
    const which = process.platform === 'win32' ? 'where chrome' : 'which google-chrome || which chromium';
    return execSync(which, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

function _httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function _waitForChrome(port, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      await _httpGet(`http://127.0.0.1:${port}/json/version`);
      return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a headless Chrome instance is running for a panel.
 * @param {string} panelId
 * @returns {Promise<{port: number}|null>}
 */
async function ensureChrome(panelId) {
  _dbg(`ensureChrome called, panelId=${panelId}`);
  if (_instances.has(panelId)) {
    _dbg(`ensureChrome: already running on port ${_instances.get(panelId).port}`);
    return { port: _instances.get(panelId).port };
  }

  const chromePath = _findChromeBinary();
  _dbg(`ensureChrome: chromePath=${chromePath}`);
  if (!chromePath) {
    _dbg('ensureChrome: Chrome binary NOT FOUND');
    return null;
  }

  const port = await _findFreePort();
  const userDataDir = path.join(require('node:os').tmpdir(), `cc-chrome-${panelId.slice(0, 8)}-${Date.now()}`);
  _dbg(`ensureChrome: port=${port}, userDataDir=${userDataDir}`);

  const proc = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--no-proxy-server',
    '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--window-size=1280,720',
    `--user-data-dir=${userDataDir}`,
    'https://www.google.com',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });

  let stderrChunks = '';
  proc.stderr.on('data', (d) => { stderrChunks += d.toString(); });

  proc.on('error', (err) => {
    _dbg(`ensureChrome: process error: ${err.message}`);
    _instances.delete(panelId);
  });

  proc.on('exit', (code, signal) => {
    _dbg(`ensureChrome: process exited code=${code} signal=${signal} stderr=${stderrChunks.slice(0, 500)}`);
  });

  _dbg('ensureChrome: waiting for Chrome to be ready...');
  const ready = await _waitForChrome(port);
  _dbg(`ensureChrome: ready=${ready}`);
  if (!ready) {
    proc.kill();
    _dbg('ensureChrome: Chrome did not start in time, killed');
    return null;
  }

  _instances.set(panelId, { port, process: proc, ws: null, frameCallback: null, navCallback: null, nextId: 1, currentTargetId: null, knownTargetIds: new Set(), tabPoller: null });
  _dbg(`ensureChrome: Chrome started on port ${port}`);
  return { port };
}

// Resolve WebSocket constructor (works in both VSCode extension host and Node.js)
function _getWS() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try { return require('ws'); } catch {}
  try { return require('node:ws'); } catch {}
  return null;
}

// Connect screencast WebSocket to a specific CDP page target
function _connectToTarget(instance, target) {
  const WS = _getWS();
  if (!WS) { _dbg('_connectToTarget: no WebSocket available'); return; }

  // Close old WebSocket if any
  if (instance.ws) {
    try { instance.ws.onclose = null; instance.ws.close(); } catch {}
    instance.ws = null;
  }

  _dbg(`_connectToTarget: connecting to ${target.webSocketDebuggerUrl} (id=${target.id})`);
  const ws = new WS(target.webSocketDebuggerUrl);

  ws.onopen = () => {
    _dbg('_connectToTarget: WebSocket OPEN');
    ws.send(JSON.stringify({ id: instance.nextId++, method: 'Page.enable', params: {} }));
    ws.send(JSON.stringify({
      id: instance.nextId++,
      method: 'Page.startScreencast',
      params: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
    }));
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.method === 'Page.screencastFrame') {
        const { data, metadata, sessionId } = msg.params;
        ws.send(JSON.stringify({
          id: instance.nextId++,
          method: 'Page.screencastFrameAck',
          params: { sessionId },
        }));
        if (instance.frameCallback) instance.frameCallback(data, metadata);
      } else if (msg.method === 'Page.frameNavigated') {
        const frame = msg.params && msg.params.frame;
        if (frame && !frame.parentId && frame.url && instance.navCallback) {
          instance.navCallback(frame.url);
        }
      }
    } catch {}
  };

  ws.onerror = () => {};
  ws.onclose = () => { if (instance.ws === ws) instance.ws = null; };

  instance.ws = ws;
  instance.currentTargetId = target.id;
  if (instance.knownTargetIds) instance.knownTargetIds.add(target.id);
}

/**
 * Start streaming screencast frames via CDP.
 * @param {string} panelId
 * @param {function} onFrame - (base64JpegData: string, metadata: object) => void
 * @param {function} [onNav] - (url: string) => void — called on navigation
 */
async function startScreencast(panelId, onFrame, onNav) {
  _dbg(`startScreencast called, panelId=${panelId}`);
  const instance = _instances.get(panelId);
  if (!instance) { _dbg('startScreencast: no instance found'); return; }

  instance.frameCallback = onFrame;
  instance.navCallback = onNav || null;

  try {
    const targets = await _httpGet(`http://127.0.0.1:${instance.port}/json`);
    const page = targets.find(t => t.type === 'page');
    if (!page || !page.webSocketDebuggerUrl) {
      _dbg('startScreencast: no page target found');
      return;
    }

    _connectToTarget(instance, page);

    // Poll for tab changes every 2 seconds — follow genuinely new tabs, recover from closed tabs
    instance.knownTargetIds.add(page.id);
    instance.tabPoller = setInterval(async () => {
      try {
        const latest = await _httpGet(`http://127.0.0.1:${instance.port}/json`).catch(() => null);
        if (!latest) return;
        const pages = latest.filter(t => t.type === 'page');
        if (pages.length === 0) return;

        const currentId = instance.currentTargetId;
        const currentExists = pages.some(p => p.id === currentId);

        // Find a tab we've never seen before
        const brandNewTarget = pages.find(p => !instance.knownTargetIds.has(p.id));

        // Track all current tabs
        for (const p of pages) instance.knownTargetIds.add(p.id);

        // Switch to brand-new tab, or fall back if current tab was closed
        const switchTo = brandNewTarget || (!currentExists ? pages[pages.length - 1] : null);
        if (switchTo && switchTo.id !== currentId) {
          _dbg(`tabPoller: switching from ${currentId} to ${switchTo.id} (url=${switchTo.url})`);
          _connectToTarget(instance, switchTo);
          if (instance.navCallback && switchTo.url) instance.navCallback(switchTo.url);
        }
      } catch {}
    }, 2000);

    _dbg('startScreencast: setup complete, polling for tab changes');
  } catch (err) {
    _dbg(`startScreencast: EXCEPTION: ${err.message}\n${err.stack}`);
  }
}

/**
 * Stop screencast streaming for a panel.
 */
function stopScreencast(panelId) {
  const instance = _instances.get(panelId);
  if (!instance) return;
  instance.frameCallback = null;
  if (instance.tabPoller) { clearInterval(instance.tabPoller); instance.tabPoller = null; }
  if (instance.ws) {
    try {
      instance.ws.send(JSON.stringify({ id: instance.nextId++, method: 'Page.stopScreencast', params: {} }));
    } catch {}
  }
}

/**
 * Kill Chrome for a panel and clean up.
 */
function killChrome(panelId) {
  const instance = _instances.get(panelId);
  if (!instance) return;
  instance.frameCallback = null;
  if (instance.tabPoller) { clearInterval(instance.tabPoller); instance.tabPoller = null; }
  if (instance.ws) {
    try { instance.ws.close(); } catch {}
  }
  if (instance.process) {
    try { instance.process.kill(); } catch {}
  }
  _instances.delete(panelId);
  console.log(`[chrome-manager] Chrome killed for panel ${panelId.slice(0, 8)}`);
}

/**
 * Get the Chrome port for a panel, or null if not running.
 */
function getChromePort(panelId) {
  const inst = _instances.get(panelId);
  return inst ? inst.port : null;
}

/**
 * Send a CDP input command to Chrome for a panel.
 */
function sendInput(panelId, cdpMethod, cdpParams) {
  const instance = _instances.get(panelId);
  if (!instance || !instance.ws) return;
  try {
    instance.ws.send(JSON.stringify({
      id: instance.nextId++,
      method: cdpMethod,
      params: cdpParams,
    }));
  } catch {}
}

/**
 * Kill all Chrome instances and clean up temp dirs.
 */
function killAll() {
  for (const panelId of _instances.keys()) {
    killChrome(panelId);
  }
}

module.exports = {
  ensureChrome,
  findChromeBinary: _findChromeBinary,
  startScreencast,
  stopScreencast,
  killChrome,
  killAll,
  getChromePort,
  sendInput,
  _dbg,
};
