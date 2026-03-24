/**
 * Manages QAAgentDesktop container lifecycle for remote agents.
 *
 * When any agent uses a `qa-remote-*` CLI backend, this module ensures
 * a desktop container is running and provides the port info needed to
 * connect.
 *
 * Uses the bundled Node.js qa-desktop CLI (qa-desktop/cli.js) instead of
 * the Python qa-desktop CLI, so no Python installation is needed.
 */
const { exec, execFile } = require('node:child_process');
const path = require('node:path');

// Per-panel cache: panelId -> desktop info
const _cache = new Map();

// Path to the bundled qa-desktop CLI
let _qaDesktopDir = null;

/**
 * Set the path to the qa-desktop directory (called by extension on init).
 * If not set, falls back to ../qa-desktop relative to this file.
 */
function setQaDesktopPath(dirPath) {
  _qaDesktopDir = dirPath;
}

function _qaDesktopCli() {
  const dir = _qaDesktopDir || path.resolve(__dirname, '..', 'qa-desktop');
  return path.join(dir, 'cli.js');
}

/**
 * Run the bundled qa-desktop CLI and return { code, stdout, stderr }.
 */
function _qaExec(args, timeout = 300000) {
  return new Promise((resolve) => {
    execFile('node', [_qaDesktopCli(), ...args], { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || err.status || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * Derive a stable instance name from workspace path + panel ID.
 */
function instanceName(repoRoot, panelId) {
  const crypto = require('node:crypto');
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const seed = panelId ? `${repoRoot}:${panelId}` : repoRoot;
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Wait for the container's API to become healthy.
 */
async function _waitForHealthy(apiPort, maxWaitMs = 1200000, containerName = null) {
  const http = require('node:http');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // If we have a container name, check health from inside via docker exec to avoid
    // Docker Desktop for Windows port-proxy delay (can take 2-3 min on snapshot starts)
    if (containerName) {
      const r = await _shellExec(`docker exec ${containerName} curl -fsS http://127.0.0.1:8765/healthz`, 5000);
      if (r.code === 0) return true;
    } else {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${apiPort}/healthz`, { timeout: 3000 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Check if a snapshot image exists for a workspace.
 */
async function getSnapshotExists(workspace) {
  const safe = workspace.replace(/\\/g, '/');
  const r = await _qaExec(['snapshot-exists', '--workspace', safe, '--json']);
  try { return JSON.parse(r.stdout.trim()); } catch { return { exists: false, tag: '' }; }
}

/**
 * Ensure a QAAgentDesktop container is running.
 */
async function ensureDesktop(repoRoot, panelId, useSnapshot = true) {
  const cacheKey = panelId || repoRoot;

  if (_cache.has(cacheKey)) {
    const cached = _cache.get(cacheKey);
    const still = await _waitForHealthy(cached.apiPort, 3000);
    if (still) return { ...cached, isNew: false };
    _cache.delete(cacheKey);
  }

  const name = instanceName(repoRoot, panelId);

  try {
    const safePath = repoRoot.replace(/\\/g, '/');
    const args = ['up', name, '--workspace', safePath, '--json'];
    if (!useSnapshot) args.push('--no-snapshot');
    const result = await _qaExec(args);

    if (result.code !== 0) {
      console.error('[remote-desktop] qa-desktop up failed:', result.stderr);
      return null;
    }

    const info = JSON.parse(result.stdout.trim());
    const isNew = info.status === 'started';

    if (isNew) {
      console.log(`[remote-desktop] Container '${info.name}' starting, waiting for API on port ${info.api_port}...`);
    }
    const healthy = await _waitForHealthy(info.api_port);
    if (!healthy) {
      console.error(`[remote-desktop] Container '${info.name}' API did not become healthy within timeout`);
      return null;
    }

    const desktop = {
      name: info.name,
      apiPort: info.api_port,
      vncPort: info.vnc_port,
      novncPort: info.novnc_port,
      containerId: info.container_id,
    };

    _cache.set(cacheKey, desktop);
    console.log(`[remote-desktop] Container '${info.name}' ready on API port ${info.api_port}`);
    return { ...desktop, isNew };
  } catch (err) {
    console.error('[remote-desktop] Failed to start desktop:', err.message);
    return null;
  }
}

function clearPanel(panelId) {
  _cache.delete(panelId);
}

function getLinkedInstance(panelId) {
  return _cache.get(panelId) || null;
}

/**
 * Check if a CLI name is a remote backend.
 */
function isRemoteCli(cli) {
  return typeof cli === 'string' && cli.startsWith('qa-remote');
}

/**
 * Resolve the command + args needed to spawn a remote agent via the bundled proxy.
 * Returns { command: 'node', args: ['proxy.js', '--agent', 'claude', '--remote-port=PORT', ...originalArgs] }
 */
function resolveRemoteCommand(cli, originalArgs, desktop) {
  if (!isRemoteCli(cli) || !desktop) return { command: cli, args: originalArgs };
  const dir = _qaDesktopDir || path.resolve(__dirname, '..', 'qa-desktop');
  const proxyPath = path.join(dir, 'proxy.js');
  const agent = cli.includes('codex') ? 'codex' : 'claude';
  return {
    command: 'node',
    args: [proxyPath, '--agent', agent, `--remote-port=${desktop.apiPort}`, '--remote-cwd=/workspace', ...originalArgs],
  };
}

/**
 * Inject --remote-port into args for a remote CLI invocation.
 * @deprecated Use resolveRemoteCommand instead for bundled proxy support.
 */
function injectRemotePort(cli, args, desktop) {
  if (!isRemoteCli(cli) || !desktop) return args;
  return [`--remote-port=${desktop.apiPort}`, `--remote-cwd=/workspace`, ...args];
}

/**
 * Helper to run a shell command and return { code, stdout, stderr }.
 */
function _shellExec(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * List all running qa-desktop instances.
 */
async function listInstances(currentPanelId, workspace) {
  try {
    const result = await _qaExec(['ls', '--json']);
    if (result.code !== 0) return [];
    const instances = JSON.parse(result.stdout.trim());

    const nameToPanel = {};
    for (const [panelId, desktop] of _cache.entries()) {
      nameToPanel[desktop.name] = panelId;
    }

    let snapshotExists = false;
    let snapshotTag = '';
    if (workspace) {
      const snap = await getSnapshotExists(workspace);
      snapshotExists = snap.exists;
      snapshotTag = snap.tag;
    }

    return instances.map((inst) => ({
      ...inst,
      linkedPanelId: nameToPanel[inst.name] || null,
      isLinked: nameToPanel[inst.name] === currentPanelId,
      snapshotExists,
      snapshotTag,
    }));
  } catch {
    return [];
  }
}

/**
 * Stop a running instance by name.
 */
async function stopInstance(name) {
  const result = await _qaExec(['down', name]);
  for (const [key, desktop] of _cache.entries()) {
    if (desktop.name === name) {
      _cache.delete(key);
      break;
    }
  }
  return result.code === 0;
}

/**
 * Restart an instance: stop then start, wait for healthy.
 */
async function restartInstance(name, repoRoot, panelId) {
  await stopInstance(name);
  return ensureDesktop(repoRoot, panelId);
}

/**
 * Check if a container already exists for this panel WITHOUT creating one.
 */
async function findExistingDesktop(repoRoot, panelId) {
  const cacheKey = panelId || repoRoot;

  if (_cache.has(cacheKey)) {
    const cached = _cache.get(cacheKey);
    const healthy = await _waitForHealthy(cached.apiPort, 3000);
    if (healthy) return cached;
    _cache.delete(cacheKey);
  }

  const name = instanceName(repoRoot, panelId);
  try {
    const result = await _qaExec(['ls', '--json']);
    if (result.code !== 0) return null;
    const instances = JSON.parse(result.stdout.trim());
    const match = instances.find(i => i.name === name && i.status && i.status.toLowerCase().includes('up'));
    if (!match) return null;

    const healthy = await _waitForHealthy(match.api_port, 1200000);
    if (!healthy) return null;

    const desktop = {
      name: match.name,
      apiPort: match.api_port,
      vncPort: match.vnc_port,
      novncPort: match.novnc_port,
      containerId: match.container_id,
    };
    _cache.set(cacheKey, desktop);
    return desktop;
  } catch {
    return null;
  }
}

/**
 * Send an immediate cancel to the container API.
 */
async function cancelRemoteRun(apiPort) {
  if (!apiPort) return;
  const http = require('node:http');
  return new Promise((resolve) => {
    const req = http.request(`http://localhost:${apiPort}/api/cancel`, {
      method: 'POST',
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = {
  ensureDesktop,
  findExistingDesktop,
  cancelRemoteRun,
  clearPanel,
  getLinkedInstance,
  getSnapshotExists,
  isRemoteCli,
  injectRemotePort,
  resolveRemoteCommand,
  instanceName,
  listInstances,
  stopInstance,
  restartInstance,
  setQaDesktopPath,
};
