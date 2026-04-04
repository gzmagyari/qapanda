const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');

function stubRenderer() {
  return new Proxy({}, {
    get() {
      return () => {};
    },
  });
}

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);

function buildSession({ config = {}, manifest = null, loopOverride = null } = {}) {
  const posted = [];
  const captured = {
    runManagerLoopCalls: [],
    saveManifestCalls: [],
  };
  const fakeManifest = manifest || {
    runId: 'test-run',
    controller: { cli: 'codex', sessionId: 'controller-1', config: [] },
    worker: { cli: 'codex', model: null },
    status: 'idle',
    files: {},
    requests: [],
  };

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath,
    filename: statePath,
    loaded: true,
    exports: {
      ...origState,
      prepareNewRun: async () => ({ ...fakeManifest }),
      resolveRunDir: async () => '/fake/run',
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async (value) => {
        captured.saveManifestCalls.push(JSON.parse(JSON.stringify(value)));
      },
    },
  };

  const defaultLoop = async (currentManifest, _renderer, options) => {
    captured.runManagerLoopCalls.push({
      manifest: JSON.parse(JSON.stringify(currentManifest)),
      options: { ...options },
    });
    return currentManifest;
  };

  require.cache[orchPath] = {
    id: orchPath,
    filename: orchPath,
    loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: loopOverride || defaultLoop,
      runDirectWorkerTurn: async (currentManifest) => currentManifest,
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath,
    filename: promptsPath,
    loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };

  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: config,
    postMessage: (msg) => posted.push(msg),
  });

  session._startAgentDelegateMcp = async () => {};
  session._syncMcpToManifest = () => {};

  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };

  return { session, posted, captured, cleanup };
}

test('_getConfig includes loop objective and loop mode', () => {
  const { session, cleanup } = buildSession({
    config: { loopMode: true, loopObjective: 'Finish A-03' },
  });
  try {
    const config = session._getConfig();
    assert.equal(config.loopMode, true);
    assert.equal(config.loopObjective, 'Finish A-03');
  } finally {
    cleanup();
  }
});

test('applyConfig persists loop objective to the active manifest', () => {
  const { session, cleanup } = buildSession();
  try {
    session._activeManifest = {
      runId: 'run-1',
      controller: { cli: 'codex', sessionId: null, config: [] },
      worker: { cli: 'codex' },
      status: 'idle',
      files: {},
      requests: [],
    };

    session.applyConfig({ loopMode: true, loopObjective: 'Finish A-03' });

    assert.equal(session._loopMode, true);
    assert.equal(session._loopObjective, 'Finish A-03');
    assert.equal(session._activeManifest.loopMode, true);
    assert.equal(session._activeManifest.loopObjective, 'Finish A-03');
  } finally {
    cleanup();
  }
});

test('reattachRun restores loop config from the manifest and syncs it to the webview', async () => {
  const { session, posted, cleanup } = buildSession({
    manifest: {
      runId: 'existing-run',
      controller: { cli: 'codex', sessionId: null, config: [] },
      worker: { cli: 'codex' },
      status: 'idle',
      files: {},
      requests: [],
      loopMode: true,
      loopObjective: 'Finish A-03',
    },
  });
  try {
    await session.reattachRun('existing-run');

    assert.equal(session._loopMode, true);
    assert.equal(session._loopObjective, 'Finish A-03');

    const syncMsg = posted.filter((msg) => msg.type === 'syncConfig').at(-1);
    assert.ok(syncMsg, 'expected syncConfig after reattach');
    assert.equal(syncMsg.config.loopMode, true);
    assert.equal(syncMsg.config.loopObjective, 'Finish A-03');
  } finally {
    cleanup();
  }
});

test('_runControllerContinue uses the loop objective in auto-continue mode', async () => {
  const { session, captured, cleanup } = buildSession({
    config: {
      chatTarget: 'agent-dev',
      loopMode: true,
      loopObjective: 'Finish A-01 through A-03',
    },
  });
  try {
    session._activeManifest = {
      runId: 'run-1',
      controller: { cli: 'codex', sessionId: 'controller-1', config: [] },
      worker: { cli: 'codex' },
      status: 'running',
      files: {},
      requests: [],
      controllerSystemPrompt: 'BASE PROMPT',
    };

    await session._runControllerContinue('');

    const call = captured.runManagerLoopCalls[0];
    assert.ok(call, 'expected runManagerLoop to be called');
    assert.match(call.manifest.controllerSystemPrompt, /Finish A-01 through A-03/);
    assert.match(call.manifest.controllerSystemPrompt, /Stop only when this objective is achieved/i);
    assert.equal(session._activeManifest.controllerSystemPrompt, 'BASE PROMPT');
  } finally {
    cleanup();
  }
});
