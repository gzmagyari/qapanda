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
async function _waitForHealthy(apiPort, maxWaitMs = 1200000, containerName = null) {
  const http = require('node:http');
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // If we have a container name, check health from inside via docker exec to avoid
    // Docker Desktop for Windows port-proxy delay (can take 2-3 min on snapshot starts)
    if (containerName) {
      const r = await _exec(`docker exec ${containerName} curl -fsS http://127.0.0.1:8765/healthz`, 5000);
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
 * @param {string} workspace
 * @returns {Promise<{exists: boolean, tag: string}>}
 */
async function getSnapshotExists(workspace) {
  const safe = workspace.replace(/\\/g, '/');
  const r = await _exec(`qa-desktop snapshot-exists --workspace "${safe}"`);
  try { return JSON.parse(r.stdout.trim()); } catch { return { exists: false, tag: '' }; }
}

/**
 * Ensure a QAAgentDesktop container is running.
 *
 * @param {string} repoRoot — workspace path
 * @param {string} [panelId] — unique panel identifier for per-panel isolation
 * @param {boolean} [useSnapshot=true] — whether to use snapshot image if available
 * @returns {{ apiPort, vncPort, novncPort, name, containerId, isNew }} or null
 */
async function ensureDesktop(repoRoot, panelId, useSnapshot = true) {
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
    const noSnapshotFlag = useSnapshot ? '' : ' --no-snapshot';
    const cmd = `qa-desktop up "${name}" --workspace "${safePath}"${noSnapshotFlag} --json`;
    const result = await new Promise((resolve) => {
      exec(cmd, { cwd: repoRoot, timeout: 300000 }, (err, stdout, stderr) => {
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
 * Get the cached desktop info for a panelId, or null.
 */
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
 * Inject --remote-port into args for a remote CLI invocation.
 */
function injectRemotePort(cli, args, desktop) {
  if (!isRemoteCli(cli) || !desktop) return args;
  return [`--remote-port=${desktop.apiPort}`, `--remote-cwd=/workspace`, ...args];
}

/**
 * Helper to run a shell command and return { code, stdout, stderr }.
 */
function _exec(cmd, timeout = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * List all running qa-desktop instances.
 * Annotates each with `linkedPanelId` if a cached panel maps to it,
 * and `snapshotExists`/`snapshotTag` if a snapshot exists for the workspace.
 * @param {string} currentPanelId
 * @param {string} [workspace] — workspace path for snapshot lookup
 */
async function listInstances(currentPanelId, workspace) {
  try {
    const result = await _exec('qa-desktop ls --json');
    if (result.code !== 0) return [];
    const instances = JSON.parse(result.stdout.trim());

    // Build reverse map: container name -> panelId
    const nameToPanel = {};
    for (const [panelId, desktop] of _cache.entries()) {
      nameToPanel[desktop.name] = panelId;
    }

    // Check snapshot existence once for the workspace (shared across all instances)
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
  const result = await _exec(`qa-desktop down "${name}"`);
  // Remove from cache if present
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
 * Returns desktop info if found and healthy, null otherwise.
 */
async function findExistingDesktop(repoRoot, panelId) {
  const cacheKey = panelId || repoRoot;

  // Check cache first
  if (_cache.has(cacheKey)) {
    const cached = _cache.get(cacheKey);
    const healthy = await _waitForHealthy(cached.apiPort, 3000);
    if (healthy) return cached;
    _cache.delete(cacheKey);
  }

  // Check if container exists via qa-desktop ls
  const name = instanceName(repoRoot, panelId);
  try {
    const result = await _exec('qa-desktop ls --json');
    if (result.code !== 0) return null;
    const instances = JSON.parse(result.stdout.trim());
    const match = instances.find(i => i.name === name && i.status && i.status.toLowerCase().includes('up'));
    if (!match) return null;

    // Found it — verify healthy and cache
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
 * Send an immediate cancel to the container API, killing all active subprocesses.
 * Used when cc-manager aborts a remote CLI run.
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
  instanceName,
  listInstances,
  stopInstance,
  restartInstance,
};
