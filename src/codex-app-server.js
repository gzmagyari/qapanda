/**
 * Codex App-Server connection manager.
 *
 * Manages a persistent `codex app-server` process that communicates via
 * JSON-RPC over stdio (JSONL). Unlike the CLI mode which spawns a new
 * process per controller turn, this keeps a single long-running process
 * and uses the thread/turn APIs.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');
const { spawnArgs, killProcessTree } = require('./process-utils');
const { MCP_STARTUP_TIMEOUT_SEC, mcpToolTimeoutSec } = require('./mcp-timeouts');
const { appendWizardDebug, summarizeForDebug } = require('./debug-log');

const REQUEST_TIMEOUT_MS = 120_000;

class CodexAppServerConnection {
  constructor({ bin, cwd, env, model, configArgs }) {
    this._bin = bin || 'codex';
    this._cwd = cwd;
    this._env = env || {};
    this._model = model || null;
    this._configArgs = configArgs || []; // extra -c flags for MCP servers etc.

    this._proc = null;
    this._rl = null;
    this._nextId = 1;
    this._pendingRequests = new Map(); // id → { resolve, reject, timer }
    this._threadId = null;
    this._turnId = null;
    this._initialized = false;
    this._intentionalKill = false;
    this._onNotification = null;
  }

  /**
   * Spawn the app-server process and complete the initialize handshake.
   */
  async connect() {
    if (this._proc && !this._proc.killed) return;
    _dbg(`CodexAppServerConnection.connect cwd=${this._cwd} bin=${this._bin} configArgs=${JSON.stringify(this._configArgs)}`);
    _wizardDbg('codex-appserver', `connect:start cwd=${this._cwd} bin=${this._bin} configArgs=${summarizeForDebug(this._configArgs)}`, {
      repoRoot: this._cwd,
    });

    // Build a clean env: strip ELECTRON_RUN_AS_NODE, use isolated CODEX_HOME
    const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = { ...process.env, ...this._env };
    const codexHome = path.join(os.tmpdir(), 'cc-codex-appserver-home');
    const realCodexHome = path.join(os.homedir(), '.codex');
    try {
      fs.mkdirSync(codexHome, { recursive: true });
      for (const f of ['auth.json', 'cap_sid']) {
        const src = path.join(realCodexHome, f);
        const dst = path.join(codexHome, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      }
    } catch {}
    cleanEnv.CODEX_HOME = codexHome;

    this._intentionalKill = false;
    const args = ['app-server', ...this._configArgs];
    this._proc = spawnArgs(this._bin, args, {
      cwd: this._cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._rl = readline.createInterface({ input: this._proc.stdout, crlfDelay: Infinity });

    this._rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      this._dispatch(msg);
    });

    // Stderr: log but don't crash
    const stderrRl = readline.createInterface({ input: this._proc.stderr, crlfDelay: Infinity });
    stderrRl.on('line', () => { /* silently consume stderr */ });

    this._proc.on('error', (err) => {
      _wizardDbg('codex-appserver', `process:error cwd=${this._cwd} message=${err && err.message ? err.message : err}`, {
        repoRoot: this._cwd,
      });
      this._handleCrash(`Process error: ${err.message}`);
    });

    this._proc.on('close', (code) => {
      if (!this._intentionalKill) {
        _wizardDbg('codex-appserver', `process:close cwd=${this._cwd} code=${code}`, {
          repoRoot: this._cwd,
        });
        this._handleCrash(`Process exited unexpectedly (code=${code})`);
      }
    });

    // Initialize handshake
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'qapanda',
        title: 'QA Panda',
        version: '1.0.0',
      },
    });
    this.sendNotification('initialized', {});
    this._initialized = true;
    _dbg(`CodexAppServerConnection.connect initialized cwd=${this._cwd} bin=${this._bin}`);
    _wizardDbg('codex-appserver', `connect:initialized cwd=${this._cwd} bin=${this._bin}`, {
      repoRoot: this._cwd,
    });
  }

  /**
   * Route an incoming JSON message to the appropriate handler.
   */
  _dispatch(msg) {
    // Response to a request (has id)
    if (msg.id != null && this._pendingRequests.has(msg.id)) {
      _wizardDbg('codex-appserver', `dispatch:response id=${msg.id} hasError=${!!msg.error}`, {
        repoRoot: this._cwd,
      });
      const pending = this._pendingRequests.get(msg.id);
      this._pendingRequests.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification (has method, no id)
    if (msg.method && msg.id == null) {
      if (
        msg.method === 'thread.started' ||
        msg.method === 'turn.completed' ||
        msg.method === 'turn.failed' ||
        msg.method === 'item.completed' ||
        msg.method === 'error'
      ) {
        _wizardDbg('codex-appserver', `dispatch:notification method=${msg.method}`, {
          repoRoot: this._cwd,
        });
      }
      if (this._onNotification) {
        this._onNotification(msg);
      }
      return;
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._proc || this._proc.killed) {
        return reject(new Error('App-server not connected'));
      }
      const id = this._nextId++;
      _wizardDbg('codex-appserver', `sendRequest:start method=${method} id=${id} threadId=${this._threadId || 'null'} turnId=${this._turnId || 'null'}`, {
        repoRoot: this._cwd,
      });
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        _wizardDbg('codex-appserver', `sendRequest:timeout method=${method} id=${id} threadId=${this._threadId || 'null'} turnId=${this._turnId || 'null'}`, {
          repoRoot: this._cwd,
        });
        reject(new Error(`Request ${method} (id=${id}) timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this._pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify({ method, id, params }) + '\n';
      this._proc.stdin.write(line);
    });
  }

  /**
   * Send a JSON-RPC notification (fire-and-forget, no response expected).
   */
  sendNotification(method, params = {}) {
    if (!this._proc || this._proc.killed) return;
    const line = JSON.stringify({ method, params }) + '\n';
    this._proc.stdin.write(line);
  }

  /**
   * Create a new thread.
   */
  async startThread({ cwd, model, approvalPolicy, sandbox }) {
    const params = {};
    if (model || this._model) params.model = model || this._model;
    if (cwd) params.cwd = cwd;
    if (approvalPolicy) params.approvalPolicy = approvalPolicy;
    if (sandbox) params.sandbox = sandbox;
    const result = await this.sendRequest('thread/start', params);
    this._threadId = result.thread.id;
    _wizardDbg('codex-appserver', `thread:start threadId=${this._threadId}`, {
      repoRoot: this._cwd,
    });
    return this._threadId;
  }

  /**
   * Resume an existing thread.
   */
  async resumeThread(threadId) {
    if (this._threadId === threadId) return threadId;
    const result = await this.sendRequest('thread/resume', { threadId });
    this._threadId = result.thread.id;
    _wizardDbg('codex-appserver', `thread:resume requested=${threadId} active=${this._threadId}`, {
      repoRoot: this._cwd,
    });
    return this._threadId;
  }

  /**
   * Fork an existing thread into a new thread, optionally changing sandbox
   * and approval settings while preserving conversation history.
   */
  async forkThread(threadId, { approvalPolicy, sandbox } = {}) {
    const params = { threadId };
    if (approvalPolicy) params.approvalPolicy = approvalPolicy;
    if (sandbox) params.sandbox = sandbox;
    const result = await this.sendRequest('thread/fork', params);
    this._threadId = result.thread.id;
    _wizardDbg('codex-appserver', `thread:fork from=${threadId} to=${this._threadId}`, {
      repoRoot: this._cwd,
    });
    return this._threadId;
  }

  /**
   * Start a turn on the current thread.
   */
  async startTurn(inputText, outputSchema, options = {}) {
    if (!this._threadId) throw new Error('No active thread');
    const approvalPolicy = options.approvalPolicy || 'never';
    const params = {
      threadId: this._threadId,
      input: [{ type: 'text', text: inputText }],
      approvalPolicy,
    };
    if (options.sandbox) params.sandbox = options.sandbox;
    if (outputSchema) params.outputSchema = outputSchema;
    const result = await this.sendRequest('turn/start', params);
    this._turnId = result.turn.id;
    _wizardDbg('codex-appserver', `turn:start turnId=${this._turnId} threadId=${this._threadId} inputChars=${String(inputText || '').length}`, {
      repoRoot: this._cwd,
    });
    return this._turnId;
  }

  /**
   * Interrupt the active turn.
   */
  async interruptTurn() {
    if (!this._threadId || !this._turnId) return;
    try {
      _wizardDbg('codex-appserver', `turn:interrupt turnId=${this._turnId} threadId=${this._threadId}`, {
        repoRoot: this._cwd,
      });
      await this.sendRequest('turn/interrupt', {
        threadId: this._threadId,
        turnId: this._turnId,
      });
    } catch {
      // May fail if turn already finished
    }
  }

  /**
   * Set the notification callback.
   */
  onNotification(cb) {
    this._onNotification = cb;
  }

  /**
   * Gracefully disconnect.
   */
  async disconnect() {
    this._intentionalKill = true;
    _wizardDbg('codex-appserver', `disconnect threadId=${this._threadId || 'null'} turnId=${this._turnId || 'null'}`, {
      repoRoot: this._cwd,
    });
    this._initialized = false;
    this._threadId = null;
    this._turnId = null;

    for (const [id, pending] of this._pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    this._pendingRequests.clear();

    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }

    if (this._proc && !this._proc.killed) {
      killProcessTree(this._proc.pid);
      this._proc = null;
    }
  }

  /**
   * Ensure the connection is alive; reconnect if crashed.
   */
  async ensureConnected() {
    if (this._proc && !this._proc.killed && this._initialized) return;
    await this.connect();
  }

  /**
   * Handle unexpected process death.
   */
  _handleCrash(reason) {
    _wizardDbg('codex-appserver', `crash reason=${reason}`, {
      repoRoot: this._cwd,
    });
    this._proc = null;
    this._initialized = false;
    for (const [id, pending] of this._pendingRequests) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(`App-server crashed: ${reason}`));
    }
    this._pendingRequests.clear();
  }

  get threadId() { return this._threadId; }
  get isConnected() { return this._proc && !this._proc.killed && this._initialized; }
}

// ── Connection cache ──────────────────────────────────────────────────────

const _connections = new Map(); // runId → CodexAppServerConnection

/**
 * Build -c config flags for MCP servers (same format as codex.js buildCodexArgs).
 * Resolves {CHROME_DEBUG_PORT}, {EXTENSION_DIR}, {REPO_ROOT} placeholders
 * in server args and env values (matching codex-worker.js buildCodexWorkerArgs).
 */
function buildMcpConfigArgs(mcpServers, manifest) {
  const args = [];
  if (!mcpServers) return args;
  const tomlEsc = (s) => s.replace(/\\/g, '\\\\');
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server) continue;
    const codexName = name.replace(/-/g, '_');
    const toolTimeoutSec = mcpToolTimeoutSec(name);
    if (server.url) {
      args.push('-c', `mcp_servers.${codexName}.url="${tomlEsc(server.url)}"`);
      args.push('-c', `mcp_servers.${codexName}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
      if (toolTimeoutSec != null) {
        args.push('-c', `mcp_servers.${codexName}.tool_timeout_sec=${toolTimeoutSec}`);
      }
      continue;
    }
    if (!server.command) continue;
    args.push('-c', `mcp_servers.${codexName}.command="${tomlEsc(server.command)}"`);
    if (Array.isArray(server.args) && server.args.length > 0) {
      // Resolve placeholders (same as codex-worker.js lines 72-76)
      let resolvedArgs = server.args;
      if (manifest && manifest.chromeDebugPort) resolvedArgs = resolvedArgs.map(a => a.replace(/\{CHROME_DEBUG_PORT\}/g, String(manifest.chromeDebugPort)));
      if (manifest && manifest.extensionDir) resolvedArgs = resolvedArgs.map(a => a.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/')));
      if (manifest && manifest.repoRoot) resolvedArgs = resolvedArgs.map(a => a.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/')));
      const argsToml = `[${resolvedArgs.map((a) => `"${tomlEsc(a)}"`).join(', ')}]`;
      args.push('-c', `mcp_servers.${codexName}.args=${argsToml}`);
    }
    if (server.env && typeof server.env === 'object') {
      for (const [key, val] of Object.entries(server.env)) {
        // Resolve placeholders (same as codex-worker.js lines 81-84)
        let resolvedVal = val;
        if (manifest && manifest.extensionDir) resolvedVal = resolvedVal.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/'));
        if (manifest && manifest.repoRoot) resolvedVal = resolvedVal.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/'));
        args.push('-c', `mcp_servers.${codexName}.env.${key}="${tomlEsc(resolvedVal)}"`);
      }
    }
    args.push('-c', `mcp_servers.${codexName}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
    if (toolTimeoutSec != null) {
      args.push('-c', `mcp_servers.${codexName}.tool_timeout_sec=${toolTimeoutSec}`);
    }
  }
  // Disable built-in shell when detached-command MCP is available
  if (mcpServers['detached-command']) {
    args.push('-c', 'features.shell_tool=false');
  }
  return args;
}

function _resolveManifestArgValue(value, manifest) {
  let resolved = String(value);
  if (manifest && manifest.chromeDebugPort != null) {
    resolved = resolved.replace(/\{CHROME_DEBUG_PORT\}/g, String(manifest.chromeDebugPort));
  }
  if (manifest && manifest.extensionDir) {
    resolved = resolved.replace(/\{EXTENSION_DIR\}/g, String(manifest.extensionDir).replace(/\\/g, '/'));
  }
  if (manifest && manifest.repoRoot) {
    resolved = resolved.replace(/\{REPO_ROOT\}/g, String(manifest.repoRoot).replace(/\\/g, '/'));
  }
  return resolved;
}

function _resolveMcpServerFingerprintEntries(mcpServers, manifest) {
  return Object.keys(mcpServers || {}).sort().map((name) => {
    const server = mcpServers[name] || {};
    const entry = { name: String(name) };
    if (server.url) {
      entry.url = String(server.url);
      return entry;
    }
    if (server.command) {
      entry.command = String(server.command);
    }
    if (Array.isArray(server.args) && server.args.length > 0) {
      entry.args = server.args.map((arg) =>
        typeof arg === 'string' ? _resolveManifestArgValue(arg, manifest) : arg
      );
    }
    if (server.env && typeof server.env === 'object') {
      entry.env = Object.fromEntries(
        Object.entries(server.env)
          .sort(([left], [right]) => String(left).localeCompare(String(right)))
          .map(([key, value]) => [
            String(key),
            typeof value === 'string' ? _resolveManifestArgValue(value, manifest) : value,
          ])
      );
    }
    return entry;
  });
}

/**
 * Get or create an app-server connection for the given manifest.
 */
function _buildFingerprint(mcpServers, manifest = {}) {
  return JSON.stringify({
    servers: _resolveMcpServerFingerprintEntries(mcpServers || {}, manifest),
    chromeDebugPort: manifest && manifest.chromeDebugPort != null
      ? Number(manifest.chromeDebugPort) || String(manifest.chromeDebugPort)
      : null,
  });
}

const _dbgFile = require('path').join(require('os').tmpdir(), 'cc-appserver-debug.log');
function _dbg(msg) {
  try { require('fs').appendFileSync(_dbgFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function _wizardDbg(tag, msg, options = {}) {
  appendWizardDebug(tag, msg, options);
}

function _manifestBrowserContext(manifest) {
  return JSON.stringify({
    runId: manifest && manifest.runId || null,
    panelId: manifest && manifest.panelId || null,
    chromeDebugPort: manifest && manifest.chromeDebugPort != null ? manifest.chromeDebugPort : null,
    prestartKeys: manifest && Array.isArray(manifest.prestartKeys) ? manifest.prestartKeys : null,
    prestartKey: manifest && manifest.prestartKey || null,
    controllerPrestartKey: manifest && manifest.controllerPrestartKey || null,
    workerPrestartKey: manifest && manifest.workerPrestartKey || null,
  });
}

function getOrCreateConnection(manifest) {
  const key = manifest.runId || 'default';
  const mcpServers = manifest.controllerMcpServers || manifest.mcpServers || {};
  const mcpFingerprint = _buildFingerprint(mcpServers, manifest);

  _dbg(`getOrCreateConnection key=${key} fingerprint=${mcpFingerprint}`);
  _dbg(`  manifestCtx=${_manifestBrowserContext(manifest)}`);
  _dbg(`  _connections keys: [${Array.from(_connections.keys()).join(', ')}]`);
  _wizardDbg('codex-appserver', `getOrCreateConnection key=${key} panelId=${manifest && manifest.panelId || 'null'} chromeDebugPort=${manifest && manifest.chromeDebugPort != null ? manifest.chromeDebugPort : 'null'}`, {
    repoRoot: manifest && manifest.repoRoot ? manifest.repoRoot : null,
  });

  if (_connections.has(key)) {
    const existing = _connections.get(key);
    if (existing._mcpFingerprint !== mcpFingerprint) {
      _dbg(`  CACHE HIT key=${key} but fingerprint mismatch: ${existing._mcpFingerprint} vs ${mcpFingerprint} — reconnecting`);
      existing.disconnect();
      _connections.delete(key);
    } else {
      _dbg(`  CACHE HIT key=${key} fingerprint match, isConnected=${existing.isConnected}`);
      return existing;
    }
  }

  // Adopt a prestarted connection if available and MCP config matches.
  const prestartKeys = Array.isArray(manifest.prestartKeys) && manifest.prestartKeys.length > 0
    ? manifest.prestartKeys
    : (manifest.prestartKey
        ? [manifest.prestartKey]
        : (manifest.controllerPrestartKey
            ? [manifest.controllerPrestartKey]
            : (manifest.workerPrestartKey
                ? [manifest.workerPrestartKey]
                : ['prestart', 'prestart-worker'])));
  for (const prestartKey of prestartKeys) {
    if (_connections.has(prestartKey)) {
      const prestarted = _connections.get(prestartKey);
      _dbg(`  checking ${prestartKey}: prestart_fp=${prestarted._mcpFingerprint} wanted_fp=${mcpFingerprint} isConnected=${prestarted.isConnected}`);
      if (prestarted._mcpFingerprint === mcpFingerprint) {
        _dbg(`  ADOPTED ${prestartKey} → key=${key}`);
        _connections.delete(prestartKey);
        _connections.set(key, prestarted);
        return prestarted;
      }
      _dbg(`  ${prestartKey} fingerprint mismatch — leaving for other callers`);
    }
  }

  _dbg(`  NO MATCH — creating new connection for key=${key}`);
  const configArgs = buildMcpConfigArgs(mcpServers, manifest);
  const conn = new CodexAppServerConnection({
    bin: manifest.controller.bin || 'codex',
    cwd: manifest.repoRoot,
    model: manifest.controller.model,
    configArgs,
  });
  conn._mcpFingerprint = mcpFingerprint;
  conn._connectionKey = key;
  conn._panelId = manifest.panelId || null;
  conn._chromeDebugPort = manifest.chromeDebugPort || null;
  _connections.set(key, conn);
  return conn;
}

/**
 * Pre-start an app-server connection before the first run.
 * The connection is stored under key 'prestart' and adopted by
 * getOrCreateConnection() when the first real run starts.
 */
async function prestartConnection({ key, bin, cwd, mcpServers, manifest }) {
  const storeKey = key || 'prestart';
  const fp = _buildFingerprint(mcpServers || {}, manifest || {});
  _dbg(`prestartConnection key=${storeKey} fingerprint=${fp} mcpKeys=${JSON.stringify(Object.keys(mcpServers || {}))}`);
  _dbg(`  manifestCtx=${_manifestBrowserContext(manifest || {})}`);
  _wizardDbg('codex-appserver', `prestartConnection key=${storeKey} panelId=${manifest && manifest.panelId || 'null'}`, {
    repoRoot: manifest && manifest.repoRoot ? manifest.repoRoot : cwd,
  });
  const configArgs = buildMcpConfigArgs(mcpServers || {}, manifest || {});
  const conn = new CodexAppServerConnection({ bin: bin || 'codex', cwd, configArgs });
  conn._mcpFingerprint = fp;
  conn._connectionKey = storeKey;
  conn._panelId = manifest && manifest.panelId ? manifest.panelId : null;
  conn._chromeDebugPort = manifest && manifest.chromeDebugPort != null ? manifest.chromeDebugPort : null;
  await conn.connect();
  _dbg(`prestartConnection key=${storeKey} CONNECTED isConnected=${conn.isConnected}`);
  _connections.set(storeKey, conn);
  return conn;
}

/**
 * Close and remove a connection.
 */
async function closeConnection(runId) {
  const key = runId || 'default';
  _wizardDbg('codex-appserver', `closeConnection key=${key}`);
  const conn = _connections.get(key);
  if (conn) {
    await conn.disconnect();
    _connections.delete(key);
  }
}

async function closeConnectionsWhere(predicate) {
  const closers = [];
  for (const [key, conn] of _connections.entries()) {
    if (!predicate(key, conn)) continue;
    _dbg(`closeConnectionsWhere: closing key=${key} panelId=${conn && conn._panelId || null} chromeDebugPort=${conn && conn._chromeDebugPort || null}`);
    closers.push(
      Promise.resolve()
        .then(() => conn.disconnect())
        .catch(() => {})
        .then(() => {
          _connections.delete(key);
        })
    );
  }
  await Promise.all(closers);
}

/**
 * Close all active connections (used on extension deactivation).
 */
async function closeAllConnections() {
  for (const conn of _connections.values()) {
    await conn.disconnect();
  }
  _connections.clear();
}

module.exports = {
  CodexAppServerConnection,
  buildMcpConfigArgs,
  getOrCreateConnection,
  prestartConnection,
  closeConnection,
  closeConnectionsWhere,
  closeAllConnections,
};
