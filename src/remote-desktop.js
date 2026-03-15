/**
 * Manages QAAgentDesktop container lifecycle for remote agents.
 *
 * When any agent uses a `qa-remote-*` CLI backend, this module ensures
 * a desktop container is running and provides the port info needed to
 * connect.
 *
 * Each panel/manifest gets its own container instance (keyed by a unique
 * panel ID appended to the workspace-derived name).
 */
const { exec } = require('node:child_process');

// Per-panel cache: panelId -> desktop info
const _cache = new Map();

/**
 * Derive a stable instance name from workspace path + panel ID.
 */
function instanceName(repoRoot, panelId) {
  const crypto = require('node:crypto');
  const path = require('node:path');
  const base = path.basename(repoRoot).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const seed = panelId ? `${repoRoot}:${panelId}` : repoRoot;
  const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Wait for the container's API to become healthy.
 */
async function _waitForHealthy(apiPort, maxWaitMs = 90000) {
  const http = require('node:http');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const ok = await new Promise((resolve) => {
      const req = http.get(`http://localhost:${apiPort}/healthz`, { timeout: 3000 }, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Ensure a QAAgentDesktop container is running.
 *
 * @param {string} repoRoot — workspace path
 * @param {string} [panelId] — unique panel identifier for per-panel isolation
 * @returns {{ apiPort, vncPort, novncPort, name, containerId, isNew }} or null
 */
async function ensureDesktop(repoRoot, panelId) {
  const cacheKey = panelId || repoRoot;

  // Return cached result if container is still healthy
  if (_cache.has(cacheKey)) {
    const cached = _cache.get(cacheKey);
    const still = await _waitForHealthy(cached.apiPort, 3000);
    if (still) {
      return { ...cached, isNew: false };
    }
    // Container gone — clear cache and re-create
    _cache.delete(cacheKey);
  }

  const name = instanceName(repoRoot, panelId);

  try {
    const safePath = repoRoot.replace(/\\/g, '/');
    const cmd = `qa-desktop up "${name}" --workspace "${safePath}" --json`;
    const result = await new Promise((resolve) => {
      exec(cmd, { cwd: repoRoot, timeout: 30000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });

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

/**
 * Remove a panel's cached desktop info.
 */
function clearPanel(panelId) {
  _cache.delete(panelId);
}

/**
 * Check if a CLI name is a remote backend.
 */
function isRemoteCli(cli) {
  return typeof cli === 'string' && cli.startsWith('qa-remote');
}

/**
 * Inject --remote-port into args for a remote CLI invocation.
 */
function injectRemotePort(cli, args, desktop) {
  if (!isRemoteCli(cli) || !desktop) return args;
  return [`--remote-port=${desktop.apiPort}`, ...args];
}

module.exports = {
  ensureDesktop,
  clearPanel,
  isRemoteCli,
  injectRemotePort,
  instanceName,
};
