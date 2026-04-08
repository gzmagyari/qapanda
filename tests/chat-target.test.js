const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// session-manager.js lives in extension/ and requires('./src/...').
// We patch those cache entries just like session-manager-config.test.js does.

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');
const namedWorkspacesPath = path.join(extDir, 'src', 'named-workspaces.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function stubRenderer() {
  const calls = [];
  return new Proxy({ __calls: calls }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push({ method: prop, args }); };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);
const origNamedWorkspaces = require(namedWorkspacesPath);

function buildSession(config = {}, { loopOverride, manifestOverride } = {}) {
  const captured = {
    prepareNewRunCalls: [],
    runManagerLoopCalls: [],
    runDirectWorkerTurnCalls: [],
    saveManifestCalls: [],
    bindResumeAliasCalls: [],
  };
  const posted = [];

  const fakeManifest = () => ({
    runId: 'test-run',
    controller: { model: null, config: [] },
    worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: {} },
    agents: {},
    status: 'idle',
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
    ...(manifestOverride || {}),
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
      saveManifest: async (manifest) => {
        captured.saveManifestCalls.push(JSON.parse(JSON.stringify(manifest)));
      },
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

  require.cache[namedWorkspacesPath] = {
    id: namedWorkspacesPath, filename: namedWorkspacesPath, loaded: true,
    exports: {
      ...origNamedWorkspaces,
      bindResumeAlias: async (repoRoot, alias, runId, metadata = {}) => {
        captured.bindResumeAliasCalls.push({ repoRoot, alias, runId, metadata: { ...metadata } });
        return {
          alias: String(alias || '').trim().toLowerCase(),
          previous: null,
          current: {
            runId,
            chatTarget: metadata.chatTarget || null,
          },
          overwritten: false,
        };
      },
    },
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
    require.cache[namedWorkspacesPath] = { id: namedWorkspacesPath, filename: namedWorkspacesPath, loaded: true, exports: origNamedWorkspaces };
  };

  return { session, captured, posted, renderer, cleanup };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('chatTarget defaults to controller', () => {
  const { session, cleanup } = buildSession();
  try {
    const config = session._getConfig();
    assert.equal(config.chatTarget, 'controller');
  } finally {
    cleanup();
  }
});

test('chatTarget persists through _getConfig', () => {
  const { session, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    const config = session._getConfig();
    assert.equal(config.chatTarget, 'claude');
  } finally {
    cleanup();
  }
});

test('applyConfig updates chatTarget', () => {
  const { session, cleanup } = buildSession();
  try {
    assert.equal(session._getConfig().chatTarget, 'controller');
    session.applyConfig({ chatTarget: 'claude' });
    assert.equal(session._getConfig().chatTarget, 'claude');
  } finally {
    cleanup();
  }
});

test('applyConfig with empty chatTarget resets to controller', () => {
  const { session, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    session.applyConfig({ chatTarget: '' });
    assert.equal(session._getConfig().chatTarget, 'controller');
  } finally {
    cleanup();
  }
});

test('new runs persist chatTarget into prepareNewRun options', async () => {
  const { session, captured, cleanup } = buildSession({ chatTarget: 'agent-dev' });
  try {
    session.setAgents({ system: { dev: { name: 'Developer', cli: 'codex', enabled: true } }, global: {}, project: {} });
    await session.handleMessage({ type: 'userInput', text: 'implement fix' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    assert.equal(captured.prepareNewRunCalls[0].opts.chatTarget, 'agent-dev');
  } finally {
    cleanup();
  }
});

test('switching to an existing agent session persists target and shows reattach banner', () => {
  const { session, captured, renderer, cleanup } = buildSession(
    { chatTarget: 'controller' },
    {
      manifestOverride: {
        worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: { dev: { hasStarted: true } } },
        agents: { dev: { name: 'Developer', cli: 'codex', enabled: true } },
      },
    },
  );
  try {
    session.setAgents({ system: { dev: { name: 'Developer', cli: 'codex', enabled: true } }, global: {}, project: {} });
    session._activeManifest = {
      runId: 'test-run',
      controller: { model: null, config: [] },
      worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: { dev: { hasStarted: true } } },
      agents: { dev: { name: 'Developer', cli: 'codex', enabled: true } },
      status: 'idle',
    };

    session.applyConfig({ chatTarget: 'agent-dev' });

    assert.equal(session._getConfig().chatTarget, 'agent-dev');
    assert.equal(captured.saveManifestCalls.length, 1);
    assert.equal(captured.saveManifestCalls[0].chatTarget, 'agent-dev');
    const bannerCall = renderer.__calls.find((call) => call.method === 'banner');
    assert.ok(bannerCall, 'should show a target-switch banner');
    assert.match(bannerCall.args[0], /Reattached to the existing session/i);
  } finally {
    cleanup();
  }
});

test('switching to a brand-new agent session shows new-session banner without clearing the run', () => {
  const { session, captured, renderer, cleanup } = buildSession(
    { chatTarget: 'controller' },
    {
      manifestOverride: {
        worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: {} },
        agents: { dev: { name: 'Developer', cli: 'codex', enabled: true } },
      },
    },
  );
  try {
    session.setAgents({ system: { dev: { name: 'Developer', cli: 'codex', enabled: true } }, global: {}, project: {} });
    session._activeManifest = {
      runId: 'test-run',
      controller: { model: null, config: [] },
      worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: {} },
      agents: { dev: { name: 'Developer', cli: 'codex', enabled: true } },
      status: 'idle',
    };

    session.applyConfig({ chatTarget: 'agent-dev' });

    assert.equal(session._getConfig().chatTarget, 'agent-dev');
    assert.equal(captured.saveManifestCalls.length, 1);
    assert.equal(captured.saveManifestCalls[0].chatTarget, 'agent-dev');
    const bannerCall = renderer.__calls.find((call) => call.method === 'banner');
    assert.ok(bannerCall, 'should show a target-switch banner');
    assert.match(bannerCall.args[0], /next message will start a new session/i);
  } finally {
    cleanup();
  }
});

test('switching targets on an aliased run backfills the alias for the new target', async () => {
  const { session, captured, cleanup } = buildSession(
    { chatTarget: 'agent-dev' },
    {
      manifestOverride: {
        runId: 'test-run',
        resumeToken: 'main',
        chatTarget: 'agent-dev',
        worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: {} },
        agents: {
          dev: { name: 'Developer', cli: 'codex', enabled: true },
          memory: { name: 'Memory', cli: 'codex', enabled: true },
        },
        status: 'idle',
      },
    },
  );
  try {
    session.setAgents({
      system: {
        dev: { name: 'Developer', cli: 'codex', enabled: true },
        memory: { name: 'Memory', cli: 'codex', enabled: true },
      },
      global: {},
      project: {},
    });
    session._activeManifest = {
      runId: 'test-run',
      resumeToken: 'main',
      chatTarget: 'agent-dev',
      controller: { model: null, config: [] },
      worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: {} },
      agents: {
        dev: { name: 'Developer', cli: 'codex', enabled: true },
        memory: { name: 'Memory', cli: 'codex', enabled: true },
      },
      status: 'idle',
    };
    session._resumeToken = 'main';

    session.applyConfig({ chatTarget: 'agent-memory' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(captured.bindResumeAliasCalls.length, 1);
    assert.deepEqual(captured.bindResumeAliasCalls[0], {
      repoRoot: '/tmp/fake-repo',
      alias: 'main',
      runId: 'test-run',
      metadata: { chatTarget: 'agent-memory' },
    });
  } finally {
    cleanup();
  }
});

test('plain text with default target routes to controller (runManagerLoop)', async () => {
  const { session, captured, cleanup } = buildSession();
  try {
    await session.handleMessage({ type: 'userInput', text: 'do stuff' });
    assert.equal(captured.runManagerLoopCalls.length, 1, 'should call runManagerLoop');
    assert.equal(captured.runDirectWorkerTurnCalls.length, 0, 'should not call runDirectWorkerTurn');
    assert.equal(captured.runManagerLoopCalls[0].options.userMessage, 'do stuff');
  } finally {
    cleanup();
  }
});

test('plain text with chatTarget=claude routes to direct worker', async () => {
  const { session, captured, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    await session.handleMessage({ type: 'userInput', text: 'do stuff' });
    assert.equal(captured.runDirectWorkerTurnCalls.length, 1, 'should call runDirectWorkerTurn');
    assert.equal(captured.runManagerLoopCalls.length, 0, 'should not call runManagerLoop');
    assert.equal(captured.runDirectWorkerTurnCalls[0].options.userMessage, 'do stuff');
    assert.equal(captured.runDirectWorkerTurnCalls[0].options.enableWorkerHandoff, true);
  } finally {
    cleanup();
  }
});

test('slash commands still use controller path regardless of chatTarget', async () => {
  const { session, captured, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/help' });
    // /help doesn't call either loop — it just shows help text
    assert.equal(captured.runManagerLoopCalls.length, 0);
    assert.equal(captured.runDirectWorkerTurnCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('/new always uses controller loop even with chatTarget=claude', async () => {
  const { session, captured, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    assert.equal(captured.runManagerLoopCalls.length, 1, '/new should use runManagerLoop');
    assert.equal(captured.runDirectWorkerTurnCalls.length, 0, '/new should not use runDirectWorkerTurn');
  } finally {
    cleanup();
  }
});

test('direct worker path does not schedule auto-pass', async () => {
  const { session, captured, posted, cleanup } = buildSession({ chatTarget: 'claude', waitDelay: '5m' });
  try {
    await session.handleMessage({ type: 'userInput', text: 'do stuff' });
    assert.equal(captured.runDirectWorkerTurnCalls.length, 1);
    // No waitStatus should be posted (no auto-pass scheduled)
    const waitMsgs = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.equal(waitMsgs.length, 0, 'should not schedule auto-pass for direct worker path');
  } finally {
    cleanup();
  }
});

test('controller path still schedules auto-pass when waitDelay is set', async () => {
  const loopOverride = async (manifest, _renderer, options) => {
    manifest.status = 'running';
    return manifest;
  };
  const { session, captured, posted, cleanup } = buildSession(
    { chatTarget: 'controller', waitDelay: '5m' },
    { loopOverride },
  );
  try {
    await session.handleMessage({ type: 'userInput', text: 'do stuff' });
    // waitStatus should be posted (auto-pass scheduled)
    const waitMsgs = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.ok(waitMsgs.length > 0, 'should schedule auto-pass for controller path');
  } finally {
    cleanup();
  }
});

test('chatTarget=claude preserves existing run (reuses manifest)', async () => {
  const { session, captured, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    // First message creates the run
    await session.handleMessage({ type: 'userInput', text: 'first message' });
    assert.equal(captured.prepareNewRunCalls.length, 1);

    // Second message should reuse the existing manifest (no new prepareNewRun)
    await session.handleMessage({ type: 'userInput', text: 'second message' });
    assert.equal(captured.prepareNewRunCalls.length, 1, 'should not create a new run');
    assert.equal(captured.runDirectWorkerTurnCalls.length, 2, 'both messages should route to direct worker');
    assert.ok(captured.runDirectWorkerTurnCalls.every((call) => call.options.enableWorkerHandoff === true));
  } finally {
    cleanup();
  }
});

test('syncConfig includes chatTarget', () => {
  const { session, posted, cleanup } = buildSession({ chatTarget: 'claude' });
  try {
    session._syncConfig();
    const syncMsg = posted.find(m => m.type === 'syncConfig');
    assert.ok(syncMsg, 'should post syncConfig');
    assert.equal(syncMsg.config.chatTarget, 'claude');
  } finally {
    cleanup();
  }
});
