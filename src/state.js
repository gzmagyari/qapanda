const path = require('node:path');
const fs = require('node:fs/promises');

const {
  ensureDir,
  nowIso,
  randomId,
  readJson,
  slugify,
  truncate,
  writeJson,
} = require('./utils');
const { defaultSchemaPath, writeControllerSchema } = require('./schema');

function defaultStateRoot(cwd) {
  return path.join(cwd, '.cc-manager');
}

function runDirFromId(stateRoot, runId) {
  return path.join(stateRoot, 'runs', runId);
}

function manifestPath(runDir) {
  return path.join(runDir, 'manifest.json');
}

function eventsPath(runDir) {
  return path.join(runDir, 'events.jsonl');
}

function transcriptPath(runDir) {
  return path.join(runDir, 'transcript.jsonl');
}

function progressPath(runDir) {
  return path.join(runDir, 'progress.md');
}

// ── Wait delay options ──────────────────────────────────────────────────────

const WAIT_OPTIONS = [
  { value: '', label: 'None', ms: 0 },
  { value: '1m', label: '1 min', ms: 60_000 },
  { value: '2m', label: '2 min', ms: 120_000 },
  { value: '3m', label: '3 min', ms: 180_000 },
  { value: '5m', label: '5 min', ms: 300_000 },
  { value: '10m', label: '10 min', ms: 600_000 },
  { value: '15m', label: '15 min', ms: 900_000 },
  { value: '30m', label: '30 min', ms: 1_800_000 },
  { value: '1h', label: '1 hour', ms: 3_600_000 },
  { value: '2h', label: '2 hours', ms: 7_200_000 },
  { value: '3h', label: '3 hours', ms: 10_800_000 },
  { value: '5h', label: '5 hours', ms: 18_000_000 },
  { value: '6h', label: '6 hours', ms: 21_600_000 },
  { value: '12h', label: '12 hours', ms: 43_200_000 },
  { value: '1d', label: '1 day', ms: 86_400_000 },
  { value: '2d', label: '2 days', ms: 172_800_000 },
  { value: '3d', label: '3 days', ms: 259_200_000 },
  { value: '4d', label: '4 days', ms: 345_600_000 },
  { value: '5d', label: '5 days', ms: 432_000_000 },
  { value: '6d', label: '6 days', ms: 518_400_000 },
  { value: '7d', label: '7 days', ms: 604_800_000 },
];

/**
 * Parse a wait delay string (e.g. '5m', '2h', '1d') and return milliseconds.
 * Returns 0 for empty/unknown values (means no delay).
 */
function parseWaitDelay(value) {
  if (!value) return 0;
  const option = WAIT_OPTIONS.find(o => o.value === value);
  if (option) return option.ms;
  // Try numeric parse: "5m", "2h", "1d"
  const match = String(value).match(/^(\d+)\s*(m|h|d)$/i);
  if (match) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 'm') return n * 60_000;
    if (unit === 'h') return n * 3_600_000;
    if (unit === 'd') return n * 86_400_000;
  }
  return 0;
}

/**
 * Format milliseconds as a human-readable wait label.
 */
function formatWaitDelay(ms) {
  if (!ms || ms <= 0) return 'none';
  const option = WAIT_OPTIONS.find(o => o.ms === ms);
  if (option) return option.label;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function normalizeRunOptions(options = {}) {
  return {
    repoRoot: path.resolve(options.repoRoot || process.cwd()),
    stateRoot: path.resolve(options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd())),
    runId: options.runId || `${slugify(options.initialMessage || 'run', 24)}-${Date.now().toString(36)}`,
    controller: {
      cli: options.controllerCli || 'codex',
      bin: options.controllerCli === 'claude' ? (options.claudeBin || 'claude') : (options.codexBin || 'codex'),
      model: options.controllerModel || null,
      profile: options.controllerProfile || null,
      sandbox: options.controllerSandbox || 'workspace-write',
      config: Array.isArray(options.controllerConfig) ? options.controllerConfig : [],
      skipGitRepoCheck: Boolean(options.controllerSkipGitRepoCheck),
      extraInstructions: options.controllerExtraInstructions || null,
    },
    worker: {
      cli: options.workerCli || 'claude',
      bin: options.workerCli || options.claudeBin || 'claude',
      model: options.workerModel || null,
      sessionId: options.workerSessionId || randomId(),
      allowedTools: options.workerAllowedTools || 'Bash,Read,Edit',
      tools: options.workerTools || null,
      disallowedTools: options.workerDisallowedTools || null,
      permissionPromptTool: options.workerPermissionPromptTool || null,
      maxTurns: options.workerMaxTurns == null ? null : options.workerMaxTurns,
      maxBudgetUsd: options.workerMaxBudgetUsd == null ? null : options.workerMaxBudgetUsd,
      addDirs: Array.isArray(options.workerAddDir) ? options.workerAddDir.map((entry) => path.resolve(entry)) : [],
      appendSystemPrompt: options.workerAppendSystemPrompt || null,
    },
    settings: {
      rawEvents: Boolean(options.rawEvents),
      quiet: Boolean(options.quiet),
      color: options.color !== false,
    },
    mcpServers: options.mcpServers || {},
    controllerMcpServers: options.controllerMcpServers || null,
    workerMcpServers: options.workerMcpServers || null,
    agents: options.agents || {},
    panelId: options.panelId || null,
    controllerSystemPrompt: options.controllerSystemPrompt || null,
  };
}

async function prepareNewRun(initialMessage, options = {}) {
  const normalized = normalizeRunOptions({ ...options, initialMessage });
  const runDir = runDirFromId(normalized.stateRoot, normalized.runId);
  const files = {
    manifest: manifestPath(runDir),
    events: eventsPath(runDir),
    transcript: transcriptPath(runDir),
    progress: progressPath(runDir),
    schema: defaultSchemaPath(runDir),
    requestsDir: path.join(runDir, 'requests'),
  };

  await ensureDir(files.requestsDir);
  await writeControllerSchema(files.schema);

  const manifest = {
    version: 1,
    runId: normalized.runId,
    repoRoot: normalized.repoRoot,
    stateRoot: normalized.stateRoot,
    runDir,
    files,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'idle',
    phase: 'idle',
    error: null,
    stopReason: null,
    controller: {
      ...normalized.controller,
      sessionId: null,
      schemaFile: files.schema,
    },
    worker: {
      ...normalized.worker,
      hasStarted: false,
      agentSessions: {},
    },
    settings: normalized.settings,
    mcpServers: normalized.mcpServers || {},
    controllerMcpServers: normalized.controllerMcpServers || null,
    workerMcpServers: normalized.workerMcpServers || null,
    agents: normalized.agents || {},
    panelId: normalized.panelId || null,
    controllerSystemPrompt: normalized.controllerSystemPrompt || null,
    counters: {
      request: 0,
      loop: 0,
      controllerTurn: 0,
      workerTurn: 0,
    },
    activeRequestId: null,
    requests: [],
    transcriptSummary: truncate(initialMessage, 120),
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
  };

  await saveManifest(manifest);
  return manifest;
}

async function saveManifest(manifest) {
  manifest.updatedAt = nowIso();
  await ensureDir(manifest.runDir);
  await writeJson(manifest.files.manifest, manifest);
}

async function loadManifestFromDir(runDir) {
  const manifest = await readJson(manifestPath(runDir));
  if (!manifest) {
    throw new Error(`No manifest found in ${runDir}`);
  }
  return manifest;
}

async function resolveRunDir(specifier, stateRoot) {
  const absolute = path.resolve(specifier || '');
  try {
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      if (await fs.stat(manifestPath(absolute)).catch(() => null)) {
        return absolute;
      }
    }
  } catch {
    // ignore
  }

  const root = path.resolve(stateRoot || defaultStateRoot(process.cwd()));
  return runDirFromId(root, specifier);
}

async function listRunManifests(stateRoot) {
  const runsRoot = path.join(stateRoot, 'runs');
  try {
    const entries = await fs.readdir(runsRoot, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const runDir = path.join(runsRoot, entry.name);
      const manifest = await readJson(manifestPath(runDir), null);
      if (manifest) {
        manifests.push(manifest);
      }
    }
    manifests.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return manifests;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function createRequest(manifest, userMessage) {
  manifest.counters.request += 1;
  const id = `req-${String(manifest.counters.request).padStart(4, '0')}`;
  const requestsDir = path.join(manifest.files.requestsDir, id);
  const request = {
    id,
    userMessage,
    startedAt: nowIso(),
    finishedAt: null,
    status: 'running',
    stopReason: null,
    loops: [],
    requestsDir,
    latestControllerDecision: null,
    latestWorkerResult: null,
  };
  manifest.requests.push(request);
  manifest.activeRequestId = id;
  return request;
}

function getActiveRequest(manifest) {
  if (!manifest.activeRequestId) {
    return null;
  }
  return manifest.requests.find((request) => request.id === manifest.activeRequestId) || null;
}

async function createLoopRecord(manifest, request) {
  manifest.counters.loop += 1;
  manifest.counters.controllerTurn += 1;

  const index = request.loops.length + 1;
  const loopDir = path.join(request.requestsDir, `loop-${String(index).padStart(4, '0')}`);
  await ensureDir(loopDir);

  const loop = {
    id: `loop-${String(index).padStart(4, '0')}`,
    index,
    startedAt: nowIso(),
    finishedAt: null,
    controller: {
      promptFile: path.join(loopDir, 'controller.prompt.txt'),
      stdoutFile: path.join(loopDir, 'controller.stdout.log'),
      stderrFile: path.join(loopDir, 'controller.stderr.log'),
      finalFile: path.join(loopDir, 'controller.final.json'),
      exitCode: null,
      decision: null,
      sessionId: manifest.controller.sessionId,
    },
    worker: null,
  };

  request.loops.push(loop);
  return loop;
}

function attachWorkerRecord(manifest, loop) {
  manifest.counters.workerTurn += 1;
  const loopDir = path.dirname(loop.controller.promptFile);
  loop.worker = {
    promptFile: path.join(loopDir, 'worker.prompt.txt'),
    stdoutFile: path.join(loopDir, 'worker.stdout.log'),
    stderrFile: path.join(loopDir, 'worker.stderr.log'),
    finalFile: path.join(loopDir, 'worker.final.json'),
    exitCode: null,
    resultText: null,
    sessionId: manifest.worker.sessionId,
  };
  return loop.worker;
}

/** Case-insensitive agent lookup — controller may return wrong-case agent_id. */
function lookupAgentConfig(agents, agentId) {
  if (!agents || !agentId) return null;
  if (agents[agentId]) return agents[agentId];
  const lower = agentId.toLowerCase();
  for (const [key, val] of Object.entries(agents)) {
    if (key.toLowerCase() === lower) return val;
  }
  return null;
}

module.exports = {
  WAIT_OPTIONS,
  attachWorkerRecord,
  createLoopRecord,
  createRequest,
  defaultStateRoot,
  formatWaitDelay,
  getActiveRequest,
  listRunManifests,
  loadManifestFromDir,
  manifestPath,
  lookupAgentConfig,
  normalizeRunOptions,
  parseWaitDelay,
  prepareNewRun,
  progressPath,
  resolveRunDir,
  runDirFromId,
  saveManifest,
};
