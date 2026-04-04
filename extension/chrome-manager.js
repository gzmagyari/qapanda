/**
 * Manages headless Chrome instances for local agents.
 * Each qapanda panel gets its own Chrome on a unique debug port.
 * Provides CDP-based Page.startScreencast streaming.
 */
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const _debugLogPath = path.join(require('node:os').tmpdir(), 'cc-chrome-debug.log');
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
    const which = process.platform === 'win32' ? 'where chrome' : 'which google-chrome-stable || which google-chrome || which chromium-browser || which chromium';
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
    '--disable-features=AutomationControlled',
    '--disable-infobars',
    '--lang=en-US,en',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
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
    _dbg(`ensureChrome: process EXITED code=${code} signal=${signal} stderr=${stderrChunks.slice(0, 500)}`);
    _instances.delete(panelId);
  });

  _dbg('ensureChrome: waiting for Chrome to be ready...');
  const ready = await _waitForChrome(port);
  _dbg(`ensureChrome: ready=${ready}`);
  if (!ready) {
    proc.kill();
    _dbg('ensureChrome: Chrome did not start in time, killed');
    return null;
  }

  _instances.set(panelId, { panelId, port, process: proc, ws: null, frameCallback: null, navCallback: null, nextId: 1, currentTargetId: null, knownTargetIds: new Set(), tabPoller: null });
  _dbg(`ensureChrome: Chrome started on port ${port}`);
  return { port };
}

/**
 * Adopt an already-running Chrome debug port for a panel.
 * This is used when a run is reattached after the webview/extension reloads.
 * @param {string} panelId
 * @param {number|string} port
 * @returns {Promise<{port: number}|null>}
 */
async function attachExistingChrome(panelId, port) {
  const normalizedPort = Number(port);
  _dbg(`attachExistingChrome called, panelId=${panelId}, port=${normalizedPort}`);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    _dbg('attachExistingChrome: invalid port');
    return null;
  }

  const existing = _instances.get(panelId);
  if (existing && existing.port === normalizedPort) {
    _dbg(`attachExistingChrome: already attached on port ${normalizedPort}`);
    return { port: normalizedPort };
  }

  try {
    await _httpGet(`http://127.0.0.1:${normalizedPort}/json/version`);
    const targets = await _httpGet(`http://127.0.0.1:${normalizedPort}/json`);
    const hasPage = Array.isArray(targets) && targets.some((target) => target && target.type === 'page');
    if (!hasPage) {
      _dbg(`attachExistingChrome: no page target found on port ${normalizedPort}`);
      return null;
    }
  } catch (err) {
    _dbg(`attachExistingChrome: validation failed: ${err.message}`);
    return null;
  }

  if (existing) {
    try { if (existing.tabPoller) clearInterval(existing.tabPoller); } catch {}
    try { if (existing.ws) existing.ws.close(); } catch {}
  }

  _instances.set(panelId, {
    panelId,
    port: normalizedPort,
    process: null,
    ws: null,
    frameCallback: null,
    navCallback: null,
    nextId: 1,
    currentTargetId: null,
    knownTargetIds: new Set(),
    tabPoller: null,
    adopted: true,
  });
  _dbg(`attachExistingChrome: adopted running Chrome on port ${normalizedPort}`);
  return { port: normalizedPort };
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
    _dbg('_connectToTarget: closing old WebSocket');
    try { instance.ws.onclose = null; instance.ws.close(); } catch {}
    instance.ws = null;
  }

  _dbg(`_connectToTarget: connecting to ${target.webSocketDebuggerUrl} (id=${target.id})`);
  const ws = new WS(target.webSocketDebuggerUrl);

  ws.onopen = () => {
    _dbg('_connectToTarget: WebSocket OPEN — sending Page.enable + stealth + Page.startScreencast');
    ws.send(JSON.stringify({ id: instance.nextId++, method: 'Page.enable', params: {} }));
    // Stealth: hide navigator.webdriver and other automation signals
    ws.send(JSON.stringify({
      id: instance.nextId++,
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: {
        source: `
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          window.chrome = { runtime: {} };
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : originalQuery(parameters);
        `,
      },
    }));
    ws.send(JSON.stringify({
      id: instance.nextId++,
      method: 'Page.startScreencast',
      params: { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
    }));
  };

  let _frameCount = 0;
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      if (msg.method === 'Page.screencastFrame') {
        _frameCount++;
        if (_frameCount <= 3 || _frameCount % 50 === 0) {
          _dbg(`screencastFrame #${_frameCount}: sessionId=${msg.params.sessionId} hasCallback=${!!instance.frameCallback}`);
        }
        const { data, metadata, sessionId } = msg.params;
        ws.send(JSON.stringify({
          id: instance.nextId++,
          method: 'Page.screencastFrameAck',
          params: { sessionId },
        }));
        if (instance.frameCallback) instance.frameCallback(data, metadata);
      } else if (msg.method === 'Page.frameNavigated') {
        const frame = msg.params && msg.params.frame;
        _dbg(`frameNavigated: url=${frame && frame.url} parentId=${frame && frame.parentId}`);
        if (frame && !frame.parentId && frame.url && instance.navCallback) {
          instance.navCallback(frame.url);
        }
      }
    } catch (e) {
      _dbg(`_connectToTarget onmessage error: ${e.message}`);
    }
  };

  ws.onerror = (err) => {
    _dbg(`_connectToTarget: WebSocket ERROR: ${err && err.message || 'unknown'}`);
  };

  ws.onclose = (ev) => {
    _dbg(`_connectToTarget: WebSocket CLOSED code=${ev && ev.code} reason=${ev && ev.reason} wasClean=${ev && ev.wasClean} totalFrames=${_frameCount}`);
    if (instance.ws === ws) {
      instance.ws = null;
      // Auto-reconnect after 1s if instance still alive
      if (instance.panelId && _instances.has(instance.panelId)) {
        setTimeout(async () => {
          if (!_instances.has(instance.panelId) || instance.ws) return;
          _dbg('auto-reconnect: attempting...');
          try {
            const targets = await _httpGet(`http://127.0.0.1:${instance.port}/json`).catch(() => null);
            if (!targets) { _dbg('auto-reconnect: /json failed'); return; }
            const pg = targets.find(t => t.type === 'page');
            if (pg && pg.webSocketDebuggerUrl) {
              _dbg(`auto-reconnect: found page target id=${pg.id} url=${pg.url}`);
              _connectToTarget(instance, pg);
            } else {
              _dbg(`auto-reconnect: no page target found (${targets.length} targets)`);
            }
          } catch (e) { _dbg(`auto-reconnect error: ${e.message}`); }
        }, 1000);
      }
    }
  };

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
  if (!instance) { _dbg('startScreencast: no instance for panelId'); return; }

  instance.frameCallback = onFrame;
  instance.navCallback = onNav || null;

  try {
    // Retry up to 15 times (30s max) waiting for a page target to appear
    let page = null;
    for (let attempt = 1; attempt <= 15; attempt++) {
      _dbg(`startScreencast: attempt ${attempt}/15 — fetching /json on port ${instance.port}`);
      const targets = await _httpGet(`http://127.0.0.1:${instance.port}/json`).catch(e => {
        _dbg(`startScreencast: /json fetch FAILED: ${e.message}`);
        return null;
      });
      if (targets) {
        _dbg(`startScreencast: got ${targets.length} targets: ${targets.map(t => t.type + ':' + t.id).join(', ')}`);
        page = targets.find(t => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) {
          _dbg(`startScreencast: found page target id=${page.id} url=${page.url}`);
          break;
        }
        _dbg('startScreencast: no page target with webSocketDebuggerUrl yet');
      }
      if (attempt < 15) await new Promise(r => setTimeout(r, 2000));
    }

    if (!page || !page.webSocketDebuggerUrl) {
      _dbg('startScreencast: GIVING UP — no page target found after 15 attempts');
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
    if (process.platform === 'win32') {
      try { instance.process.kill(); } catch {}
    } else {
      try { instance.process.kill('SIGTERM'); } catch {}
      // Escalate to SIGKILL on Unix if Chrome doesn't exit cleanly
      const proc = instance.process;
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 500);
    }
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
  attachExistingChrome,
  findChromeBinary: _findChromeBinary,
  startScreencast,
  stopScreencast,
  killChrome,
  killAll,
  getChromePort,
  sendInput,
  _dbg,
};
