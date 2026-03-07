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

function normalizeRunOptions(options = {}) {
  return {
    repoRoot: path.resolve(options.repoRoot || process.cwd()),
    stateRoot: path.resolve(options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd())),
    runId: options.runId || `${slugify(options.initialMessage || 'run', 24)}-${Date.now().toString(36)}`,
    controller: {
      bin: options.codexBin || 'codex',
      model: options.controllerModel || null,
      profile: options.controllerProfile || null,
      sandbox: options.controllerSandbox || 'workspace-write',
      config: Array.isArray(options.controllerConfig) ? options.controllerConfig : [],
      skipGitRepoCheck: Boolean(options.controllerSkipGitRepoCheck),
      extraInstructions: options.controllerExtraInstructions || null,
    },
    worker: {
      bin: options.claudeBin || 'claude',
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
  };
}

async function prepareNewRun(initialMessage, options = {}) {
  const normalized = normalizeRunOptions({ ...options, initialMessage });
  const runDir = runDirFromId(normalized.stateRoot, normalized.runId);
  const files = {
    manifest: manifestPath(runDir),
    events: eventsPath(runDir),
    transcript: transcriptPath(runDir),
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
    },
    settings: normalized.settings,
    counters: {
      request: 0,
      loop: 0,
      controllerTurn: 0,
      workerTurn: 0,
    },
    activeRequestId: null,
    requests: [],
    transcriptSummary: truncate(initialMessage, 120),
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

module.exports = {
  attachWorkerRecord,
  createLoopRecord,
  createRequest,
  defaultStateRoot,
  getActiveRequest,
  listRunManifests,
  loadManifestFromDir,
  manifestPath,
  normalizeRunOptions,
  prepareNewRun,
  resolveRunDir,
  runDirFromId,
  saveManifest,
};
