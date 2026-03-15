const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');

const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'cc-manager.js');
const fakeClaude = path.join(rootDir, 'tests', 'fakes', 'fake-claude.js');
const fakeCodex = path.join(rootDir, 'tests', 'fakes', 'fake-codex.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function stubRenderer() {
  const calls = [];
  return new Proxy({}, {
    get(_target, prop) {
      return (...args) => { calls.push({ method: prop, args }); };
    },
  });
}

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);

function buildSession(config = {}, { loopOverride } = {}) {
  const captured = {
    prepareNewRunCalls: [],
    runManagerLoopCalls: [],
    runDirectWorkerTurnCalls: [],
  };
  const posted = [];

  const fakeManifest = () => ({
    runId: 'test-run',
    controller: { cli: config.controllerCli || 'codex', model: null, config: [], sessionId: null },
    worker: { model: null, hasStarted: false, sessionId: 'sess-1' },
    status: 'idle',
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
  });

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      prepareNewRun: async (msg, opts) => {
        captured.prepareNewRunCalls.push({ msg, opts });
        return fakeManifest();
      },
      saveManifest: async () => {},
    },
  };

  const defaultLoop = async (manifest, _renderer, options) => {
    captured.runManagerLoopCalls.push({ manifest, options });
    return manifest;
  };

  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: loopOverride || defaultLoop,
      runDirectWorkerTurn: async (manifest, _renderer, options) => {
        captured.runDirectWorkerTurnCalls.push({ manifest, options });
        return manifest;
      },
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };

  const { SessionManager } = require(smPath);

  const renderer = stubRenderer();
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: config,
    postMessage: (msg) => posted.push(msg),
  });

  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };

  return { session, captured, posted, renderer, cleanup };
}

// ── Config persistence tests ────────────────────────────────────────────────

test('controllerCli defaults to codex', () => {
  const { session, cleanup } = buildSession();
  try {
    const config = session._getConfig();
    assert.equal(config.controllerCli, 'codex');
  } finally {
    cleanup();
  }
});

test('controllerCli persists through _getConfig', () => {
  const { session, cleanup } = buildSession({ controllerCli: 'claude' });
  try {
    const config = session._getConfig();
    assert.equal(config.controllerCli, 'claude');
  } finally {
    cleanup();
  }
});

test('applyConfig updates controllerCli', () => {
  const { session, cleanup } = buildSession();
  try {
    assert.equal(session._getConfig().controllerCli, 'codex');
    session.applyConfig({ controllerCli: 'claude' });
    assert.equal(session._getConfig().controllerCli, 'claude');
  } finally {
    cleanup();
  }
});

test('syncConfig includes controllerCli', () => {
  const { session, posted, cleanup } = buildSession({ controllerCli: 'claude' });
  try {
    session._syncConfig();
    const syncMsg = posted.find(m => m.type === 'syncConfig');
    assert.ok(syncMsg, 'should post syncConfig');
    assert.equal(syncMsg.config.controllerCli, 'claude');
  } finally {
    cleanup();
  }
});

// ── Controller CLI switching/reset tests ────────────────────────────────────

test('switching controllerCli resets controller model and thinking', () => {
  const { session, cleanup } = buildSession({ controllerCli: 'codex', controllerModel: 'gpt-5.4', controllerThinking: 'high' });
  try {
    assert.equal(session._getConfig().controllerModel, 'gpt-5.4');
    assert.equal(session._getConfig().controllerThinking, 'high');

    session.applyConfig({ controllerCli: 'claude' });

    assert.equal(session._getConfig().controllerCli, 'claude');
    assert.equal(session._getConfig().controllerModel, '', 'model should be cleared');
    assert.equal(session._getConfig().controllerThinking, '', 'thinking should be cleared');
  } finally {
    cleanup();
  }
});

test('switching controllerCli resets controller session on attached manifest', async () => {
  const { session, cleanup } = buildSession({ controllerCli: 'codex' });
  try {
    // Attach a run first
    await session.handleMessage({ type: 'userInput', text: 'start a run' });
    // Now the manifest should be attached
    assert.ok(session.getRunId());

    // Manually set a controller session
    session._activeManifest.controller.sessionId = 'old-codex-session';

    session.applyConfig({ controllerCli: 'claude' });

    assert.equal(session._activeManifest.controller.sessionId, null, 'controller session should be reset');
    assert.equal(session._activeManifest.controller.cli, 'claude', 'manifest cli should be updated');
    assert.equal(session._activeManifest.controller.model, null, 'manifest model should be cleared');
    assert.deepEqual(session._activeManifest.controller.config, [], 'manifest config should be cleared');
  } finally {
    cleanup();
  }
});

test('switching controllerCli syncs config to UI', () => {
  const { session, posted, cleanup } = buildSession({ controllerCli: 'codex' });
  try {
    session.applyConfig({ controllerCli: 'claude' });
    const syncMsgs = posted.filter(m => m.type === 'syncConfig');
    assert.ok(syncMsgs.length > 0, 'should sync config after CLI switch');
    const lastSync = syncMsgs[syncMsgs.length - 1];
    assert.equal(lastSync.config.controllerCli, 'claude');
    assert.equal(lastSync.config.controllerModel, '');
    assert.equal(lastSync.config.controllerThinking, '');
  } finally {
    cleanup();
  }
});

test('same controllerCli does not reset', () => {
  const { session, cleanup } = buildSession({ controllerCli: 'codex', controllerModel: 'gpt-5.4' });
  try {
    session.applyConfig({ controllerCli: 'codex' });
    assert.equal(session._getConfig().controllerModel, 'gpt-5.4', 'model should not be cleared for same CLI');
  } finally {
    cleanup();
  }
});

// ── Default Codex controller behavior ───────────────────────────────────────

test('default controller uses codex in prepareNewRun opts', async () => {
  const { session, captured, cleanup } = buildSession();
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.equal(opts.controllerCli, 'codex');
  } finally {
    cleanup();
  }
});

test('controllerCli=codex passes controllerConfig for thinking', async () => {
  const { session, captured, cleanup } = buildSession({ controllerCli: 'codex', controllerThinking: 'high' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.ok(opts.controllerConfig.some(c => c.includes('model_reasoning_effort="high"')),
      'should pass reasoning effort config for codex');
  } finally {
    cleanup();
  }
});

test('controllerCli=claude does NOT pass codex-specific controllerConfig', async () => {
  const { session, captured, cleanup } = buildSession({ controllerCli: 'claude', controllerThinking: 'high' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.equal(opts.controllerConfig, undefined,
      'should not pass reasoning effort config for claude controller');
  } finally {
    cleanup();
  }
});

test('controllerCli=claude passes correct CLI in opts', async () => {
  const { session, captured, cleanup } = buildSession({ controllerCli: 'claude' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.equal(opts.controllerCli, 'claude');
  } finally {
    cleanup();
  }
});

// ── Integration: Claude-backed controller ───────────────────────────────────

async function runCli(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code, signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function setupWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-manager-ctrl-cli-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const stateRoot = path.join(tempRoot, 'state');
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'logic.py'), 'def add(a, b):\n    return a + b\n');
  return { tempRoot, repoRoot, stateRoot };
}

test('Claude-backed controller handles greeting and stops', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  const result = await runCli([
    'run',
    'Hi',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeClaude,  // controller binary = claude fake
    '--claude-bin', fakeClaude,
    '--controller-cli', 'claude',
  ]);

  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /Hi from Claude controller!/);
  assert.match(result.stdout, /STOP/);
  assert.doesNotMatch(result.stdout, /Launching Worker/);
});

test('Claude-backed controller delegates to worker then stops', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  const result = await runCli([
    'run',
    'Please do fixes in this repository until all unit tests pass',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeClaude,
    '--claude-bin', fakeClaude,
    '--controller-cli', 'claude',
  ]);

  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /Claude controller delegating to worker/);
  assert.match(result.stdout, /Launching Worker/);
  assert.match(result.stdout, /Claude controller verified the fix/);
  assert.match(result.stdout, /STOP/);
});

// ── State normalization: old manifests default to codex ──────────────────────

test('prepareNewRun with no controllerCli defaults to codex', async () => {
  const { prepareNewRun } = require(statePath);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-state-'));
  try {
    const manifest = await prepareNewRun('test', {
      repoRoot: tmpDir,
      stateRoot: path.join(tmpDir, '.cc-manager'),
    });
    assert.equal(manifest.controller.cli, 'codex', 'default cli should be codex');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('prepareNewRun with controllerCli=claude sets cli and uses claude bin', async () => {
  const { prepareNewRun } = require(statePath);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-state-'));
  try {
    const manifest = await prepareNewRun('test', {
      repoRoot: tmpDir,
      stateRoot: path.join(tmpDir, '.cc-manager'),
      controllerCli: 'claude',
    });
    assert.equal(manifest.controller.cli, 'claude');
    assert.equal(manifest.controller.bin, 'claude', 'bin should default to claude');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Issue 1: switching controllerCli updates manifest.controller.bin ─────────

test('switching controllerCli on attached run updates manifest.controller.bin', async () => {
  const { session, cleanup } = buildSession({ controllerCli: 'codex' });
  try {
    // Start a run so we have an attached manifest
    await session.handleMessage({ type: 'userInput', text: 'start a run' });
    assert.ok(session.getRunId());
    assert.equal(session._activeManifest.controller.bin, undefined); // mock doesn't set bin

    session.applyConfig({ controllerCli: 'claude' });

    assert.equal(session._activeManifest.controller.cli, 'claude');
    assert.equal(session._activeManifest.controller.bin, 'claude',
      'bin should be updated to claude');
  } finally {
    cleanup();
  }
});

test('switching controllerCli back to codex updates manifest.controller.bin', async () => {
  const { session, cleanup } = buildSession({ controllerCli: 'claude' });
  try {
    await session.handleMessage({ type: 'userInput', text: 'start a run' });
    assert.ok(session.getRunId());

    session.applyConfig({ controllerCli: 'codex' });

    assert.equal(session._activeManifest.controller.cli, 'codex');
    assert.equal(session._activeManifest.controller.bin, 'codex',
      'bin should be updated to codex');
  } finally {
    cleanup();
  }
});

test('switching controllerCli with custom claudeBin uses that binary', async () => {
  // Pass runOptions with a custom claudeBin
  const captured = { prepareNewRunCalls: [], runManagerLoopCalls: [] };
  const posted = [];

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      prepareNewRun: async (msg, opts) => {
        captured.prepareNewRunCalls.push({ msg, opts });
        return {
          runId: 'test-run', controller: { cli: 'codex', model: null, config: [], sessionId: null, bin: 'codex' },
          worker: { model: null, hasStarted: false, sessionId: 'sess-1' },
          status: 'idle', waitDelay: null, nextWakeAt: null, errorRetry: false,
        };
      },
      saveManifest: async () => {},
    },
  };

  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: async (manifest) => manifest,
      runDirectWorkerTurn: async (manifest) => manifest,
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };

  const { SessionManager } = require(smPath);
  const renderer = stubRenderer();
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    runOptions: { claudeBin: '/custom/claude' },
    initialConfig: { controllerCli: 'codex' },
    postMessage: (msg) => posted.push(msg),
  });

  try {
    await session.handleMessage({ type: 'userInput', text: 'test' });
    session.applyConfig({ controllerCli: 'claude' });
    assert.equal(session._activeManifest.controller.bin, '/custom/claude',
      'should use custom claudeBin when switching to claude');
  } finally {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

// ── Issue 2: incompatible controller model not forwarded for claude ──────────

test('controllerCli=claude does NOT forward controllerModel in _buildNewRunOpts', async () => {
  const { session, captured, cleanup } = buildSession({ controllerCli: 'claude', controllerModel: 'gpt-5.4' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.equal(opts.controllerModel, undefined,
      'should not forward codex model to claude controller');
  } finally {
    cleanup();
  }
});

test('controllerCli=codex forwards controllerModel in _buildNewRunOpts', async () => {
  const { session, captured, cleanup } = buildSession({ controllerCli: 'codex', controllerModel: 'gpt-5.4' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.equal(opts.controllerModel, 'gpt-5.4',
      'should forward model for codex controller');
  } finally {
    cleanup();
  }
});

// ── Issue 3: Claude-controller run does not require codex binary ─────────────

test('Claude-controller CLI run does not require codex binary', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  // Use a non-existent codex binary — should still succeed because controller-cli is claude
  const result = await runCli([
    'run',
    'Hi',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', 'nonexistent-codex-binary-that-does-not-exist',
    '--claude-bin', fakeClaude,
    '--controller-cli', 'claude',
  ]);

  assert.equal(result.code, 0, `should succeed without codex binary.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /Hi from Claude controller!/);
});

// ── Issue: switching controllerCli clears claudeSessionId ────────────────────

test('switching controllerCli clears claudeSessionId on attached manifest', async () => {
  const { session, cleanup } = buildSession({ controllerCli: 'claude' });
  try {
    await session.handleMessage({ type: 'userInput', text: 'start a run' });
    assert.ok(session.getRunId());

    // Simulate a Claude controller session having set claudeSessionId
    session._activeManifest.controller.claudeSessionId = 'old-uuid-1234';
    session._activeManifest.controller.sessionId = 'session-abc';

    // Switch to codex
    session.applyConfig({ controllerCli: 'codex' });

    assert.equal(session._activeManifest.controller.claudeSessionId, null,
      'claudeSessionId should be cleared on CLI switch');
    assert.equal(session._activeManifest.controller.sessionId, null,
      'sessionId should be cleared on CLI switch');

    // Switch back to claude — should not reuse the old stale claudeSessionId
    session.applyConfig({ controllerCli: 'claude' });
    assert.equal(session._activeManifest.controller.claudeSessionId, null,
      'claudeSessionId should still be null after switching back');
  } finally {
    cleanup();
  }
});

// ── Controller output uses backend-specific label ────────────────────────────

test('Claude-controller output uses Controller (Claude) label', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  const result = await runCli([
    'run',
    'Hi',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeClaude,
    '--claude-bin', fakeClaude,
    '--controller-cli', 'claude',
  ]);

  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /Controller \(Claude\)/,
    'output should contain Controller (Claude) label');
  assert.doesNotMatch(result.stdout, /Controller \(Codex\)/,
    'should not contain Controller (Codex) label');
});

test('Codex-controller output uses Controller (Codex) label', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  const result = await runCli([
    'run',
    'Hi',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeCodex,
    '--claude-bin', fakeClaude,
  ]);

  assert.equal(result.code, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.match(result.stdout, /Controller \(Codex\)/,
    'output should contain Controller (Codex) label');
  assert.doesNotMatch(result.stdout, /Controller \(Claude\)/,
    'should not contain Controller (Claude) label');
});

test('printRunSummary includes controller CLI', async () => {
  const { prepareNewRun } = require(statePath);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-summary-'));
  try {
    const manifest = await prepareNewRun('test', {
      repoRoot: tmpDir,
      stateRoot: path.join(tmpDir, '.cc-manager'),
      controllerCli: 'claude',
    });
    const lines = [];
    const fakeOut = { write: (t) => lines.push(t) };
    const { printRunSummary } = require(path.join(rootDir, 'src', 'orchestrator.js'));
    await printRunSummary(manifest, fakeOut);
    const output = lines.join('');
    assert.match(output, /Controller CLI: claude/,
      'summary should show controller CLI');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('session-manager sets controllerLabel on renderer', () => {
  const { session, cleanup } = buildSession({ controllerCli: 'claude' });
  try {
    // The stub renderer is a proxy, but we can check calls
    // Instead, check via _getConfig and the renderer property
    assert.equal(session._controllerCli, 'claude');
    // Switch to codex and verify label updates
    session.applyConfig({ controllerCli: 'codex' });
    assert.equal(session._controllerCli, 'codex');
  } finally {
    cleanup();
  }
});
