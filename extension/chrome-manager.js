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
const {
  filterChromePageTargets,
  resolveChromeTargetByBinding,
  resolveChromeTargetFromSelection,
} = require('./chrome-page-binding');

const _debugLogPath = path.join(require('node:os').tmpdir(), 'cc-chrome-debug.log');
function _dbg(msg) {
  try { fs.appendFileSync(_debugLogPath, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// Per-panel Chrome instances: panelId -> { port, process, ws, frameCallback, nextId }
const _instances = new Map();
const _pendingEnsures = new Map();
const _reservedPorts = new Map();

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

function _instanceSummary(instance) {
  if (!instance) return null;
  return {
    panelId: instance.panelId || null,
    port: Number.isFinite(Number(instance.port)) ? Number(instance.port) : null,
    adopted: !!instance.adopted,
    hasProcess: !!instance.process,
    hasWs: !!instance.ws,
    currentTargetId: instance.currentTargetId || null,
    currentTargetUrl: instance.currentTargetUrl || null,
    boundTargetId: instance.boundTargetId || null,
    boundTargetUrl: instance.boundTargetUrl || null,
    boundBy: instance.boundBy || null,
    boundPageNumber: Number.isFinite(Number(instance.boundPageNumber)) ? Number(instance.boundPageNumber) : null,
    lastSelectedUrl: instance.lastSelectedUrl || null,
    lastKnownUrl: instance.lastKnownUrl || null,
    lastNavAt: instance.lastNavAt || null,
    lastFrameAt: instance.lastFrameAt || null,
    screencastGeneration: Number(instance.screencastGeneration) || 0,
    knownTargetCount: instance.knownTargetIds instanceof Set ? instance.knownTargetIds.size : 0,
  };
}

function getChromeDebugState(panelId) {
  return {
    panelId,
    reservedPort: getReservedChromePort(panelId),
    pendingEnsure: _pendingEnsures.has(panelId),
    instance: _instanceSummary(_instances.get(panelId)),
  };
}

function _dbgState(prefix, panelId) {
  try {
    _dbg(`${prefix} state=${JSON.stringify(getChromeDebugState(panelId))}`);
  } catch (err) {
    _dbg(`${prefix} state=<failed:${err && err.message ? err.message : err}>`);
  }
}

function _rejectPendingCdpRequests(instance, error) {
  if (!instance || !(instance.pendingCdpRequests instanceof Map) || instance.pendingCdpRequests.size === 0) {
    return;
  }
  for (const pending of instance.pendingCdpRequests.values()) {
    if (pending && pending.timeout) {
      clearTimeout(pending.timeout);
    }
    try {
      pending.reject(error);
    } catch {}
  }
  instance.pendingCdpRequests.clear();
}

function _sendCdpRequest(instance, method, params = {}, options = {}) {
  if (!instance || !instance.ws) {
    return Promise.reject(new Error(`Cannot call ${method}: Chrome target is not connected.`));
  }
  const ws = instance.ws;
  if (Number(ws.readyState) !== 1) {
    return Promise.reject(new Error(`Cannot call ${method}: Chrome target websocket is not open.`));
  }
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 10_000);
  const id = instance.nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (instance.pendingCdpRequests instanceof Map) {
        instance.pendingCdpRequests.delete(id);
      }
      reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    if (!(instance.pendingCdpRequests instanceof Map)) {
      instance.pendingCdpRequests = new Map();
    }
    instance.pendingCdpRequests.set(id, { resolve, reject, timeout, method });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timeout);
      instance.pendingCdpRequests.delete(id);
      reject(error);
    }
  });
}

function _httpText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString());
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function _buildChromeLaunchArgs(port, userDataDir) {
  const args = [
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
  ];
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  args.push('https://www.google.com');
  return args;
}

function _summarizeCdpParams(method, params) {
  const p = params || {};
  if (method === 'Page.navigate') {
    return { url: p.url || null };
  }
  if (method === 'Input.dispatchMouseEvent') {
    return {
      type: p.type || null,
      x: p.x,
      y: p.y,
      button: p.button || null,
      buttons: p.buttons,
      deltaX: p.deltaX,
      deltaY: p.deltaY,
    };
  }
  if (method === 'Input.dispatchKeyEvent') {
    return {
      type: p.type || null,
      key: p.key || null,
      code: p.code || null,
      windowsVirtualKeyCode: p.windowsVirtualKeyCode,
    };
  }
  if (method === 'Runtime.evaluate') {
    return {
      expression: typeof p.expression === 'string' ? p.expression.slice(0, 120) : null,
    };
  }
  return Object.keys(p).length > 0 ? p : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a headless Chrome instance is running for a panel.
 * @param {string} panelId
 * @returns {Promise<{port: number}|null>}
 */
async function ensureChrome(panelId, options = {}) {
  const desiredPort = await reserveChromePort(panelId, options.port);
  _dbg(`ensureChrome called, panelId=${panelId}, desiredPort=${desiredPort}`);
  _dbgState('ensureChrome:entry', panelId);
  const foreignLiveOwner = _findPanelByLivePort(desiredPort, panelId);
  if (foreignLiveOwner) {
    throw new Error(`Chrome debug port ${desiredPort} is already owned by panel ${foreignLiveOwner}.`);
  }
  if (_instances.has(panelId)) {
    const existing = _instances.get(panelId);
    if (existing.port === desiredPort) {
      if (await _isInspectableChromeOnPort(desiredPort)) {
        _dbg(`ensureChrome: already running on desired port ${existing.port}`);
        _dbgState('ensureChrome:reuse-cached', panelId);
        return { port: existing.port, status: 'existing' };
      }
      _dbg(`ensureChrome: cached instance for panelId=${panelId} on port ${desiredPort} is stale; dropping it`);
      _instances.delete(panelId);
    }
    _dbg(`ensureChrome: stale instance on port ${existing.port}; expected ${desiredPort}. Killing stale instance.`);
    killChrome(panelId);
  }
  if (await _isInspectableChromeOnPort(desiredPort)) {
    const foreignReservedOwner = _findPanelByReservedPort(desiredPort, panelId);
    if (foreignReservedOwner) {
      throw new Error(`Chrome debug port ${desiredPort} is already reserved by panel ${foreignReservedOwner}.`);
    }
    _dbg(`ensureChrome: adopting already-running inspectable Chrome on desired port ${desiredPort}`);
    return attachExistingChrome(panelId, desiredPort, {
      alreadyValidated: true,
      keepReservation: true,
      status: 'adopted',
    });
  }
  if (_pendingEnsures.has(panelId)) {
    _dbg(`ensureChrome: awaiting pending launch for panelId=${panelId}`);
    return _pendingEnsures.get(panelId);
  }
  const launchPromise = (async () => {
    const chromePath = _findChromeBinary();
    _dbg(`ensureChrome: chromePath=${chromePath}`);
    if (!chromePath) {
      _dbg('ensureChrome: Chrome binary NOT FOUND');
      return null;
    }

    const port = desiredPort;
    const userDataDir = _userDataDirForPanel(panelId);
    _dbg(`ensureChrome: port=${port}, userDataDir=${userDataDir}`);

    const portBindable = await _canBindPort(port);
    if (!portBindable) {
      throw new Error(`Chrome debug port ${port} is already in use by another process.`);
    }

    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}

    const proc = spawn(chromePath, _buildChromeLaunchArgs(port, userDataDir), { stdio: ['ignore', 'ignore', 'pipe'], detached: false });

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

    _instances.set(panelId, {
      panelId,
      port,
      process: proc,
      ws: null,
      frameCallback: null,
      navCallback: null,
      nextId: 1,
      currentTargetId: null,
      currentTargetUrl: null,
      boundTargetId: null,
      boundTargetUrl: null,
      boundBy: null,
      boundPageNumber: null,
      knownTargetIds: new Set(),
      tabPoller: null,
      pendingCdpRequests: new Map(),
    });
    _dbg(`ensureChrome: Chrome started on port ${port}`);
    _dbgState('ensureChrome:started', panelId);
    return { port, status: 'started' };
  })();
  _pendingEnsures.set(panelId, launchPromise);
  try {
    return await launchPromise;
  } finally {
    if (_pendingEnsures.get(panelId) === launchPromise) {
      _pendingEnsures.delete(panelId);
    }
  }
}

function _userDataDirForPanel(panelId) {
  return path.join(require('node:os').tmpdir(), 'cc-chrome-panels', String(panelId || 'default'));
}

function _findPanelByReservedPort(port, excludePanelId = null) {
  for (const [panelId, reservedPort] of _reservedPorts.entries()) {
    if (panelId === excludePanelId) continue;
    if (Number(reservedPort) === Number(port)) return panelId;
  }
  return null;
}

function _findPanelByLivePort(port, excludePanelId = null) {
  for (const [panelId, instance] of _instances.entries()) {
    if (panelId === excludePanelId) continue;
    if (instance && Number(instance.port) === Number(port)) return panelId;
  }
  return null;
}

function _canBindPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function _isInspectableChromeOnPort(port) {
  try {
    await _httpGet(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function reserveChromePort(panelId, preferredPort = null) {
  const existing = _reservedPorts.get(panelId);
  if (Number.isFinite(existing) && existing > 0) {
    _dbg(`reserveChromePort: panelId=${panelId} reusedExistingPort=${existing}`);
    return existing;
  }
  const normalizedPreferred = Number(preferredPort);
  if (Number.isFinite(normalizedPreferred) && normalizedPreferred > 0) {
    const ownerPanelId = _findPanelByReservedPort(normalizedPreferred, panelId);
    if (ownerPanelId) {
      throw new Error(`Chrome debug port ${normalizedPreferred} is already reserved by panel ${ownerPanelId}.`);
    }
    _reservedPorts.set(panelId, normalizedPreferred);
    _dbg(`reserveChromePort: panelId=${panelId} preferredPort=${normalizedPreferred}`);
    return normalizedPreferred;
  }
  const port = await _findFreePort();
  _reservedPorts.set(panelId, port);
  _dbg(`reserveChromePort: panelId=${panelId} allocatedPort=${port}`);
  return port;
}

function getReservedChromePort(panelId) {
  const port = _reservedPorts.get(panelId);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function releaseChromeReservation(panelId) {
  _dbg(`releaseChromeReservation: panelId=${panelId} releasedPort=${_reservedPorts.get(panelId) || null}`);
  _reservedPorts.delete(panelId);
}

function _isPlaceholderPageUrl(url) {
  const normalized = String(url || '').trim().toLowerCase();
  if (!normalized) return true;
  return normalized === 'about:blank' ||
    normalized.startsWith('chrome-error://') ||
    normalized.startsWith('chrome://newtab') ||
    normalized.startsWith('edge://newtab') ||
    normalized.startsWith('https://www.google.com');
}

function _selectBestPageTarget(pages, currentTargetId = null) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!page || page.type !== 'page' || !page.webSocketDebuggerUrl) continue;
    let score = i;
    const placeholder = _isPlaceholderPageUrl(page.url);
    if (!placeholder) score += 200;
    if (page.url && /^https?:/i.test(page.url)) score += 20;
    if (page.id === currentTargetId) {
      score += placeholder ? 25 : 150;
    }
    if (best === null || score > bestScore) {
      best = page;
      bestScore = score;
    }
  }
  return best;
}

function _notifyTargetUrl(instance, url) {
  if (!instance || !instance.navCallback || !url) return;
  try { instance.navCallback(url); } catch {}
}

function _applyBoundTarget(instance, target, { reason = null, pageNumber = null } = {}) {
  if (!instance || !target) return;
  instance.boundTargetId = target.id || null;
  instance.boundTargetUrl = target.url || instance.boundTargetUrl || null;
  instance.boundBy = reason || instance.boundBy || null;
  instance.boundPageNumber = Number.isFinite(Number(pageNumber)) ? Number(pageNumber) : null;
}

async function _fetchChromePageTargets(port) {
  return _httpGet(`http://127.0.0.1:${port}/json/list`)
    .catch(() => _httpGet(`http://127.0.0.1:${port}/json`).catch(() => null));
}

async function _closeChromeTarget(port, targetId) {
  const encodedTargetId = encodeURIComponent(String(targetId || '').trim());
  if (!encodedTargetId) throw new Error('Missing target id.');
  return _httpText(`http://127.0.0.1:${port}/json/close/${encodedTargetId}`);
}

async function _waitForCollapsedTargets(port, keepTargetId, closingTargetIds = [], maxMs = 1500) {
  let latest = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxMs) {
    latest = await _fetchChromePageTargets(port).catch(() => null);
    const pages = filterChromePageTargets(latest);
    const keepPresent = !keepTargetId || pages.some((page) => page.id === keepTargetId);
    const closingRemain = closingTargetIds.some((id) => pages.some((page) => page.id === id));
    if (keepPresent && !closingRemain) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}

function _resolvePreferredPageTarget(instance, targets) {
  const pages = filterChromePageTargets(targets);
  if (!pages.length) return { target: null, reason: 'no-pages' };

  const bound = resolveChromeTargetByBinding(pages, {
    targetId: instance && instance.boundTargetId || null,
    url: instance && instance.boundTargetUrl || null,
  }, instance && instance.currentTargetId || null);
  if (bound.target) {
    const best = _selectBestPageTarget(pages, instance && instance.currentTargetId || null);
    if (
      best &&
      best.id !== bound.target.id &&
      _isPlaceholderPageUrl(bound.target.url) &&
      !_isPlaceholderPageUrl(best.url)
    ) {
      return { target: best, reason: 'best-over-placeholder-binding' };
    }
    return bound;
  }

  return {
    target: _selectBestPageTarget(pages, instance && instance.currentTargetId || null),
    reason: 'best-target',
  };
}

/**
 * Adopt an already-running Chrome debug port for a panel.
 * This is used when a run is reattached after the webview/extension reloads.
 * @param {string} panelId
 * @param {number|string} port
 * @returns {Promise<{port: number}|null>}
 */
async function attachExistingChrome(panelId, port, options = {}) {
  const normalizedPort = Number(port);
  _dbg(`attachExistingChrome called, panelId=${panelId}, port=${normalizedPort}`);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    _dbg('attachExistingChrome: invalid port');
    return null;
  }
  if (!options.keepReservation) {
    _reservedPorts.set(panelId, normalizedPort);
  }

  const existing = _instances.get(panelId);
  if (existing && existing.port === normalizedPort) {
    _dbg(`attachExistingChrome: already attached on port ${normalizedPort}`);
    _dbgState('attachExistingChrome:reuse-existing', panelId);
    return { port: normalizedPort, status: options.status || 'existing' };
  }

  if (!options.alreadyValidated) {
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
    currentTargetUrl: null,
    boundTargetId: null,
    boundTargetUrl: null,
    boundBy: null,
    boundPageNumber: null,
    knownTargetIds: new Set(),
    tabPoller: null,
    adopted: true,
    pendingCdpRequests: new Map(),
  });
  _dbg(`attachExistingChrome: adopted running Chrome on port ${normalizedPort}`);
  _dbgState('attachExistingChrome:adopted', panelId);
  return { port: normalizedPort, status: options.status || 'adopted' };
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
  if (!WS) { _dbg('_connectToTarget: no WebSocket available'); return false; }

  // Close old WebSocket if any
  if (instance.ws) {
    _dbg('_connectToTarget: closing old WebSocket');
    _rejectPendingCdpRequests(instance, new Error('Chrome target connection was replaced.'));
    try { instance.ws.onclose = null; instance.ws.close(); } catch {}
    instance.ws = null;
  }

  _dbg(`_connectToTarget: connecting to ${target.webSocketDebuggerUrl} (id=${target.id}, url=${target.url || ''})`);
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
      if (Number.isFinite(Number(msg.id)) && instance.pendingCdpRequests instanceof Map && instance.pendingCdpRequests.has(Number(msg.id))) {
        const requestId = Number(msg.id);
        const pending = instance.pendingCdpRequests.get(requestId);
        instance.pendingCdpRequests.delete(requestId);
        if (pending && pending.timeout) {
          clearTimeout(pending.timeout);
        }
        if (msg.error) {
          const message = msg.error && msg.error.message
            ? msg.error.message
            : `CDP ${pending && pending.method ? pending.method : 'request'} failed.`;
          pending.reject(new Error(message));
        } else {
          pending.resolve(msg.result || {});
        }
      } else if (msg.method === 'Page.screencastFrame') {
        _frameCount++;
        if (_frameCount <= 3 || _frameCount % 50 === 0) {
          _dbg(`screencastFrame #${_frameCount}: sessionId=${msg.params.sessionId} hasCallback=${!!instance.frameCallback}`);
        }
        const { data, metadata, sessionId } = msg.params;
        instance.lastFrameAt = new Date().toISOString();
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
          instance.lastKnownUrl = frame.url;
          instance.currentTargetUrl = frame.url;
          if (!instance.boundTargetId || instance.boundTargetId === instance.currentTargetId) {
            instance.boundTargetUrl = frame.url;
          }
          instance.lastNavAt = new Date().toISOString();
          _dbgState('frameNavigated:root-frame', instance.panelId);
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
      _rejectPendingCdpRequests(instance, new Error('Chrome target connection was closed.'));
      instance.ws = null;
      // Auto-reconnect after 1s if instance still alive
      if (instance.panelId && _instances.has(instance.panelId)) {
        setTimeout(async () => {
          if (!_instances.has(instance.panelId) || instance.ws) return;
          _dbg('auto-reconnect: attempting...');
          try {
            const targets = await _httpGet(`http://127.0.0.1:${instance.port}/json`).catch(() => null);
            if (!targets) { _dbg('auto-reconnect: /json failed'); return; }
            const resolved = _resolvePreferredPageTarget(instance, targets);
            const pg = resolved.target;
            if (pg && pg.webSocketDebuggerUrl) {
              _applyBoundTarget(instance, pg, { reason: `auto-reconnect:${resolved.reason}` });
              _dbg(`auto-reconnect: found page target id=${pg.id} url=${pg.url} via=${resolved.reason}`);
              _connectToTarget(instance, pg);
              _notifyTargetUrl(instance, pg.url || null);
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
  instance.currentTargetUrl = target.url || instance.currentTargetUrl || null;
  if (!instance.boundTargetId || instance.boundTargetId === target.id) {
    instance.boundTargetId = target.id;
    instance.boundTargetUrl = target.url || instance.boundTargetUrl || null;
  }
  instance.lastSelectedUrl = target.url || null;
  instance.lastTargetSelectedAt = new Date().toISOString();
  if (instance.knownTargetIds) instance.knownTargetIds.add(target.id);
  _dbgState('_connectToTarget:attached', instance.panelId);
  return true;
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
  if (!instance) {
    _dbg('startScreencast: no instance for panelId');
    return { started: false, reason: 'no-instance' };
  }
  _dbgState('startScreencast:entry', panelId);

  instance.frameCallback = onFrame;
  instance.navCallback = onNav || null;
  const generation = (Number(instance.screencastGeneration) || 0) + 1;
  instance.screencastGeneration = generation;
  instance.lastScreencastStartedAt = new Date().toISOString();
  if (instance.tabPoller) {
    clearInterval(instance.tabPoller);
    instance.tabPoller = null;
  }

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
        const resolved = _resolvePreferredPageTarget(instance, targets);
        page = resolved.target;
        if (page && page.webSocketDebuggerUrl) {
          _applyBoundTarget(instance, page, { reason: `start:${resolved.reason}` });
          _dbg(`startScreencast: found page target id=${page.id} url=${page.url} via=${resolved.reason}`);
          break;
        }
        _dbg('startScreencast: no page target with webSocketDebuggerUrl yet');
      }
      if (attempt < 15) await new Promise(r => setTimeout(r, 2000));
    }

    if (instance.screencastGeneration !== generation) {
      _dbg(`startScreencast: stale generation ${generation}; current=${instance.screencastGeneration}`);
      return { started: false, reason: 'stale-generation' };
    }

    if (!page || !page.webSocketDebuggerUrl) {
      if (instance.screencastGeneration === generation) {
        instance.frameCallback = null;
        instance.navCallback = null;
      }
      _dbg('startScreencast: GIVING UP — no page target found after 15 attempts');
      return { started: false, reason: 'no-page-target' };
    }

    const connected = _connectToTarget(instance, page);
    if (!connected) {
      if (instance.screencastGeneration === generation) {
        instance.frameCallback = null;
        instance.navCallback = null;
      }
      return { started: false, reason: 'connect-failed', targetId: page.id, url: page.url || null };
    }
    _notifyTargetUrl(instance, page.url || null);

    // Poll for tab changes every 2 seconds — follow genuinely new tabs, recover from closed tabs
    instance.knownTargetIds.add(page.id);
    instance.tabPoller = setInterval(async () => {
      try {
        const latest = await _httpGet(`http://127.0.0.1:${instance.port}/json`).catch(() => null);
        if (!latest) return;
        const pages = filterChromePageTargets(latest);
        if (pages.length === 0) return;

        const currentId = instance.currentTargetId;
        const currentPage = pages.find(p => p.id === currentId) || null;
        const currentExists = !!currentPage;

        // Track all current tabs
        for (const p of pages) instance.knownTargetIds.add(p.id);

        const resolved = _resolvePreferredPageTarget(instance, pages);
        const boundTarget = resolved.target;
        if (boundTarget && boundTarget.id !== currentId) {
          _applyBoundTarget(instance, boundTarget, { reason: `tab-poller:${resolved.reason}` });
          _dbg(`tabPoller: switching from ${currentId} to bound target ${boundTarget.id} (url=${boundTarget.url}) via=${resolved.reason}`);
          _connectToTarget(instance, boundTarget);
          _notifyTargetUrl(instance, boundTarget.url || null);
        } else if (!boundTarget && !currentExists) {
          const fallback = _selectBestPageTarget(pages, currentId);
          if (fallback && fallback.id !== currentId) {
            _applyBoundTarget(instance, fallback, { reason: 'tab-poller:fallback' });
            _dbg(`tabPoller: recovering from ${currentId} to ${fallback.id} (url=${fallback.url})`);
            _connectToTarget(instance, fallback);
            _notifyTargetUrl(instance, fallback.url || null);
          }
        } else if (currentPage) {
          instance.currentTargetUrl = currentPage.url || instance.currentTargetUrl || null;
          if (instance.boundTargetId === currentPage.id) {
            instance.boundTargetUrl = currentPage.url || instance.boundTargetUrl || null;
          }
        }
      } catch {}
    }, 2000);

    _dbg('startScreencast: setup complete, polling for tab changes');
    _dbgState('startScreencast:ready', panelId);
    return { started: true, targetId: page.id, url: page.url || null };
  } catch (err) {
    _dbg(`startScreencast: EXCEPTION: ${err.message}\n${err.stack}`);
    if (instance.screencastGeneration === generation) {
      instance.frameCallback = null;
      instance.navCallback = null;
    }
    return { started: false, reason: 'error', error: err.message };
  }
}

/**
 * Stop screencast streaming for a panel.
 */
function stopScreencast(panelId) {
  const instance = _instances.get(panelId);
  if (!instance) return;
  _dbgState('stopScreencast:entry', panelId);
  instance.screencastGeneration = (Number(instance.screencastGeneration) || 0) + 1;
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
  _dbgState('killChrome:entry', panelId);
  if (instance) {
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
  }
  console.log(`[chrome-manager] Chrome killed for panel ${panelId.slice(0, 8)}`);
  _dbgState('killChrome:after', panelId);
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
  _dbg(`sendInput: panelId=${panelId} port=${instance && instance.port || null} method=${cdpMethod} params=${JSON.stringify(_summarizeCdpParams(cdpMethod, cdpParams))}`);
  _dbgState('sendInput:state', panelId);
  if (!instance || !instance.ws) return;
  try {
    instance.ws.send(JSON.stringify({
      id: instance.nextId++,
      method: cdpMethod,
      params: cdpParams,
    }));
  } catch {}
}

async function capturePanelScreenshot(panelId, options = {}) {
  const instance = _instances.get(panelId);
  if (!instance) {
    throw new Error('No Chrome instance is linked to this panel.');
  }
  const format = String(options.format || 'jpeg').toLowerCase() === 'png' ? 'png' : 'jpeg';
  const params = {
    format,
    fromSurface: true,
    captureBeyondViewport: false,
  };
  if (format === 'jpeg') {
    params.quality = Math.max(1, Math.min(100, Number(options.quality) || 70));
  }
  const result = await _sendCdpRequest(instance, 'Page.captureScreenshot', params, {
    timeoutMs: Math.max(1, Number(options.timeoutMs) || 10_000),
  });
  if (!result || typeof result.data !== 'string' || !result.data.trim()) {
    throw new Error('Chrome did not return screenshot data.');
  }
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  return {
    dataUrl: `data:${mime};base64,${result.data}`,
    targetId: instance.boundTargetId || instance.currentTargetId || null,
    targetUrl: instance.boundTargetUrl || instance.currentTargetUrl || null,
    format,
  };
}

async function bindPanelToTarget(panelId, { targetId = null, reason = 'mcp', pageNumber = null, reconnect = true } = {}) {
  const instance = _instances.get(panelId);
  if (!instance || !instance.port) return { status: 'no-instance' };
  const normalizedTargetId = typeof targetId === 'string' ? targetId.trim() : '';
  if (!normalizedTargetId) return { status: 'missing-target-id' };

  const targets = await _fetchChromePageTargets(instance.port);
  if (!targets) return { status: 'unreachable' };
  const pages = filterChromePageTargets(targets);
  const target = pages.find((page) => page.id === normalizedTargetId) || null;
  if (!target) {
    _dbg(`bindPanelToTarget: target not found panelId=${panelId} targetId=${normalizedTargetId} reason=${reason}`);
    _dbgState('bindPanelToTarget:not-found', panelId);
    return { status: 'not-found' };
  }

  const resolvedPageNumber = Number.isFinite(Number(pageNumber))
    ? Number(pageNumber)
    : Math.max(1, pages.findIndex((page) => page.id === target.id) + 1);
  _applyBoundTarget(instance, target, { reason, pageNumber: resolvedPageNumber });
  const switched = instance.currentTargetId !== target.id;
  if (reconnect && switched) {
    _dbg(`bindPanelToTarget: switching panelId=${panelId} from=${instance.currentTargetId || 'null'} to=${target.id} url=${target.url || ''} reason=${reason}`);
    _connectToTarget(instance, target);
  } else if (!switched) {
    instance.currentTargetUrl = target.url || instance.currentTargetUrl || null;
    if (target.url) instance.lastSelectedUrl = target.url;
  }
  if (instance.knownTargetIds instanceof Set) {
    instance.knownTargetIds.add(target.id);
  }
  if (reconnect || !switched) {
    _notifyTargetUrl(instance, target.url || null);
  }
  _dbgState('bindPanelToTarget:done', panelId);
  return {
    status: switched ? (reconnect ? 'switched' : 'bound-only') : 'already-bound',
    targetId: target.id || null,
    targetUrl: target.url || null,
  };
}

function setPanelPageBinding(panelId, binding = null) {
  const instance = _instances.get(panelId);
  if (!instance) return false;
  if (!binding || typeof binding !== 'object') {
    instance.boundTargetId = null;
    instance.boundTargetUrl = null;
    instance.boundBy = null;
    instance.boundPageNumber = null;
    _dbgState('setPanelPageBinding:cleared', panelId);
    return true;
  }
  instance.boundTargetId = typeof binding.targetId === 'string' ? binding.targetId : null;
  instance.boundTargetUrl = typeof binding.url === 'string' ? binding.url : null;
  instance.boundBy = typeof binding.reason === 'string'
    ? binding.reason
    : (typeof binding.boundBy === 'string' ? binding.boundBy : 'manifest');
  instance.boundPageNumber = Number.isFinite(Number(binding.pageNumber)) ? Number(binding.pageNumber) : null;
  _dbgState('setPanelPageBinding:set', panelId);
  return true;
}

async function collapsePanelToSinglePage(panelId, { keepTargetId = null, reason = 'collapse', reconnect = false } = {}) {
  const instance = _instances.get(panelId);
  if (!instance || !instance.port) return { status: 'no-instance' };

  const targets = await _fetchChromePageTargets(instance.port);
  if (!targets) return { status: 'unreachable' };
  const pages = filterChromePageTargets(targets);
  if (!pages.length) return { status: 'no-pages' };

  const normalizedKeepTargetId = typeof keepTargetId === 'string' ? keepTargetId.trim() : '';
  let keepTarget = null;
  let resolution = null;
  if (normalizedKeepTargetId) {
    keepTarget = pages.find((page) => page.id === normalizedKeepTargetId) || null;
    resolution = keepTarget ? 'explicit-target' : 'keep-target-missing';
    if (!keepTarget) {
      _dbg(`collapsePanelToSinglePage: keep target missing panelId=${panelId} targetId=${normalizedKeepTargetId} reason=${reason}`);
      _dbgState('collapsePanelToSinglePage:keep-target-missing', panelId);
      return { status: 'keep-target-missing', resolution };
    }
  } else {
    const resolved = _resolvePreferredPageTarget(instance, targets);
    keepTarget = resolved.target;
    resolution = resolved.reason || null;
    if (!keepTarget) {
      _dbg(`collapsePanelToSinglePage: unresolved panelId=${panelId} reason=${reason} resolution=${resolution || 'unresolved'}`);
      _dbgState('collapsePanelToSinglePage:unresolved', panelId);
      return { status: resolution || 'unresolved', resolution };
    }
  }

  const keepPageNumber = Math.max(1, pages.findIndex((page) => page.id === keepTarget.id) + 1);
  const extraTargets = pages.filter((page) => page.id !== keepTarget.id);
  _applyBoundTarget(instance, keepTarget, { reason, pageNumber: keepPageNumber });

  const closedTargets = [];
  const closeErrors = [];
  for (const page of extraTargets) {
    try {
      await _closeChromeTarget(instance.port, page.id);
      closedTargets.push({ id: page.id, url: page.url || null });
    } catch (error) {
      closeErrors.push({
        id: page.id,
        url: page.url || null,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  const finalTargets = extraTargets.length > 0
    ? await _waitForCollapsedTargets(instance.port, keepTarget.id, extraTargets.map((page) => page.id))
    : targets;
  const finalPages = filterChromePageTargets(finalTargets);
  if (instance.knownTargetIds instanceof Set) {
    instance.knownTargetIds = new Set(finalPages.map((page) => page.id));
  }

  const survivor = finalPages.find((page) => page.id === keepTarget.id) || null;
  if (!survivor) {
    _dbg(`collapsePanelToSinglePage: kept target disappeared panelId=${panelId} keepTargetId=${keepTarget.id} reason=${reason}`);
    _dbgState('collapsePanelToSinglePage:keep-target-lost', panelId);
    return {
      status: 'keep-target-lost',
      resolution,
      targetId: keepTarget.id || null,
      targetUrl: keepTarget.url || null,
      closedTargets,
      closeErrors,
      remainingPageCount: finalPages.length,
    };
  }

  const bindResult = await bindPanelToTarget(panelId, {
    targetId: survivor.id,
    reason,
    pageNumber: Math.max(1, finalPages.findIndex((page) => page.id === survivor.id) + 1),
    reconnect,
  });
  _dbg(`collapsePanelToSinglePage: panelId=${panelId} reason=${reason} resolution=${resolution} keep=${survivor.id} closed=${closedTargets.length} errors=${closeErrors.length} reconnect=${reconnect}`);
  _dbgState('collapsePanelToSinglePage:done', panelId);
  return {
    status: extraTargets.length > 0 ? (closeErrors.length > 0 ? 'partial' : 'collapsed') : 'single-page',
    resolution,
    targetId: survivor.id || null,
    targetUrl: survivor.url || null,
    closedTargets,
    closeErrors,
    remainingPageCount: finalPages.length,
    bindStatus: bindResult && bindResult.status ? bindResult.status : null,
  };
}

async function syncPanelPageTarget(panelId, { pageNumber = null, expectedUrl = null, reason = 'mcp' } = {}) {
  const instance = _instances.get(panelId);
  if (!instance || !instance.port) return { status: 'no-instance' };
  const targets = await _httpGet(`http://127.0.0.1:${instance.port}/json`).catch(() => null);
  if (!targets) return { status: 'unreachable' };
  const resolved = resolveChromeTargetFromSelection(targets, { pageNumber, expectedUrl }, instance.currentTargetId || null);
  const target = resolved.target;
  if (!target) {
    _dbg(`syncPanelPageTarget: unresolved panelId=${panelId} pageNumber=${pageNumber || 'null'} expectedUrl=${expectedUrl || ''} reason=${reason} resolution=${resolved.reason}`);
    _dbgState('syncPanelPageTarget:unresolved', panelId);
    return { status: resolved.reason || 'unresolved' };
  }

  _applyBoundTarget(instance, target, { reason, pageNumber });
  const switched = instance.currentTargetId !== target.id;
  if (switched) {
    _dbg(`syncPanelPageTarget: switching panelId=${panelId} from=${instance.currentTargetId || 'null'} to=${target.id} url=${target.url || ''} via=${resolved.reason}`);
    _connectToTarget(instance, target);
  } else {
    instance.currentTargetUrl = target.url || instance.currentTargetUrl || null;
    if (target.url) instance.lastSelectedUrl = target.url;
  }
  _notifyTargetUrl(instance, target.url || null);
  _dbgState('syncPanelPageTarget:done', panelId);
  return {
    status: switched ? 'switched' : 'already-bound',
    targetId: target.id || null,
    targetUrl: target.url || null,
    resolution: resolved.reason || null,
  };
}

/**
 * Kill all Chrome instances and clean up temp dirs.
 */
function killAll() {
  for (const panelId of _instances.keys()) {
    killChrome(panelId);
  }
  _reservedPorts.clear();
}

module.exports = {
  reserveChromePort,
  getReservedChromePort,
  releaseChromeReservation,
  ensureChrome,
  attachExistingChrome,
  findChromeBinary: _findChromeBinary,
  startScreencast,
  stopScreencast,
  killChrome,
  killAll,
  getChromePort,
  getChromeDebugState,
  setPanelPageBinding,
  bindPanelToTarget,
  sendInput,
  syncPanelPageTarget,
  collapsePanelToSinglePage,
  capturePanelScreenshot,
  _buildChromeLaunchArgs,
  _dbg,
  _selectBestPageTarget,
  _isPlaceholderPageUrl,
};
