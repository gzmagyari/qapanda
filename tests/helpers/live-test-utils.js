const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const http = require('node:http');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSION_DIR = path.join(PROJECT_ROOT, 'extension');

/**
 * Check if a CLI binary is available on PATH.
 */
async function isCliAvailable(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    const child = spawn(cmd, [name], { stdio: 'ignore', shell: true });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Skip a test if a CLI is not available.
 * Usage: await skipIfMissing(t, 'claude');
 */
async function skipIfMissing(t, cliName) {
  if (!(await isCliAvailable(cliName))) {
    t.skip(`${cliName} CLI not found on PATH`);
    return true;
  }
  return false;
}

/**
 * Start the tasks MCP server as a stdio child process.
 * Returns { send(jsonRpcMsg), receive(), close() }
 */
function startTasksMcp(tasksFile) {
  const serverPath = path.join(EXTENSION_DIR, 'tasks-mcp-server.js');
  const child = spawn('node', [serverPath], {
    env: { ...process.env, TASKS_FILE: tasksFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = [];
  const received = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (pending.length > 0) {
        pending.shift()(msg);
      } else {
        received.push(msg);
      }
    } catch {}
  });

  return {
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
    receive(timeoutMs = 5000) {
      if (received.length > 0) return Promise.resolve(received.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP receive timeout')), timeoutMs);
        pending.push((msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    async call(method, params = {}) {
      const id = Math.random().toString(36).slice(2, 8);
      this.send({ jsonrpc: '2.0', id, method, params });
      return this.receive();
    },
    async callTool(name, args = {}) {
      return this.call('tools/call', { name, arguments: args });
    },
    close() {
      try { child.kill(); } catch {}
    },
    child,
  };
}

/**
 * Start the detached-command MCP server as a stdio child process.
 */
function startDetachedCommandMcp(dataDir) {
  const serverPath = path.join(EXTENSION_DIR, 'detached-command-mcp', 'dist', 'index.js');
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      DETACHED_BASH_MCP_DATA_DIR: dataDir,
      DETACHED_COMMAND_INSTANCE_ID: 'test-' + Date.now(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = [];
  const received = [];

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (pending.length > 0) {
        pending.shift()(msg);
      } else {
        received.push(msg);
      }
    } catch {}
  });

  return {
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n');
    },
    receive(timeoutMs = 10000) {
      if (received.length > 0) return Promise.resolve(received.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP receive timeout')), timeoutMs);
        pending.push((msg) => { clearTimeout(timer); resolve(msg); });
      });
    },
    async call(method, params = {}) {
      const id = Math.random().toString(36).slice(2, 8);
      this.send({ jsonrpc: '2.0', id, method, params });
      return this.receive();
    },
    async callTool(name, args = {}) {
      return this.call('tools/call', { name, arguments: args });
    },
    close() {
      try { child.kill(); } catch {}
    },
    child,
  };
}

/**
 * Make an HTTP POST request and return parsed JSON response.
 */
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Wait for an HTTP endpoint to be reachable.
 */
async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await httpPost(url, { jsonrpc: '2.0', id: 'ping', method: 'initialize', params: {} });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw new Error(`HTTP endpoint ${url} not reachable after ${timeoutMs}ms`);
}

module.exports = {
  PROJECT_ROOT,
  EXTENSION_DIR,
  isCliAvailable,
  skipIfMissing,
  startTasksMcp,
  startDetachedCommandMcp,
  httpPost,
  waitForHttp,
};
