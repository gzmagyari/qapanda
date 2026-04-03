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

function makeManifest() {
  return {
    runId: 'test-run',
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, hasStarted: false, sessionId: 'sess-1', agentSessions: {} },
    status: 'idle',
    phase: 'idle',
    stopReason: null,
    activeRequestId: null,
    waitDelay: null,
    requests: [],
  };
}

function buildSession({ runDirectWorkerTurnImpl, runManagerLoopImpl } = {}) {
  const posted = [];

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath,
    filename: statePath,
    loaded: true,
    exports: {
      ...origState,
      saveManifest: async () => {},
      prepareNewRun: async () => makeManifest(),
    },
  };

  require.cache[orchPath] = {
    id: orchPath,
    filename: orchPath,
    loaded: true,
    exports: {
      ...origOrch,
      runDirectWorkerTurn: runDirectWorkerTurnImpl || (async (manifest) => manifest),
      runManagerLoop: runManagerLoopImpl || (async (manifest) => manifest),
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
    postMessage: (msg) => posted.push(msg),
  });
  session._activeManifest = makeManifest();
  session._startAgentDelegateMcp = async () => {};
  session._ensureChromeIfNeeded = async () => {};

  session.setAgents({
    system: {
      'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', mcps: {}, enabled: true },
      dev: { name: 'Developer', cli: 'codex', mcps: {}, enabled: true },
    },
    global: {},
    project: {},
  });

  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };

  return { session, posted, cleanup };
}

test('direct agent run emits one running start and one running end', async () => {
  const { session, posted, cleanup } = buildSession({
    runDirectWorkerTurnImpl: async (manifest) => manifest,
  });
  try {
    await session._runDirectAgent('test login page', 'QA-Browser');
    const runningMessages = posted.filter((msg) => msg.type === 'running');
    assert.deepEqual(runningMessages, [
      { type: 'running', value: true, showStop: true },
      { type: 'running', value: false, showStop: false },
    ]);
    assert.equal(session.running, false);
  } finally {
    cleanup();
  }
});

test('nested delegation keeps running active until outer work fully settles', async () => {
  const { session, posted, cleanup } = buildSession({
    runDirectWorkerTurnImpl: async (manifest, _renderer, options) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        ...manifest,
        requests: [...(manifest.requests || []), { latestWorkerResult: { resultText: `done ${options.agentId}` } }],
      };
    },
  });
  try {
    const endOuter = session._beginActivity('foreground');
    session._pushExecutingAgent('QA-Browser');
    assert.equal(session.running, true);

    const delegated = session._handleDelegation('dev', 'investigate');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(session.running, true);
    assert.equal(posted.filter((msg) => msg.type === 'running' && msg.value === true).length, 1);
    assert.equal(posted.filter((msg) => msg.type === 'running' && msg.value === false).length, 0);

    const result = await delegated;
    assert.equal(result, 'done dev');
    assert.equal(session.running, true, 'outer activity should still keep the session running');

    endOuter();
    session._popExecutingAgent();

    assert.equal(session.running, false);
    assert.equal(posted.filter((msg) => msg.type === 'running' && msg.value === false).length, 1);
  } finally {
    cleanup();
  }
});

test('self-delegation is hidden from list_agents and rejected server-side', async () => {
  const { session, cleanup } = buildSession({
    runDirectWorkerTurnImpl: async (manifest) => manifest,
  });
  try {
    session._pushExecutingAgent('QA-Browser');

    const listed = JSON.parse(session._handleListAgents());
    assert.equal(listed.some((agent) => agent.id === 'QA-Browser'), false);
    assert.equal(listed.some((agent) => agent.id === 'dev'), true);

    await assert.rejects(
      () => session._handleDelegation('QA-Browser', 'delegate to self'),
      /cannot delegate to itself/i
    );
  } finally {
    cleanup();
  }
});

test('controller-launched worker turns also get self-delegation protection', async () => {
  let sessionRef;
  const { session, cleanup } = buildSession({
    runManagerLoopImpl: async (manifest, _renderer, options) => {
      await options.onWorkerStart('QA-Browser');
      try {
        const listed = JSON.parse(sessionRef._handleListAgents());
        assert.equal(listed.some((agent) => agent.id === 'QA-Browser'), false);
        await assert.rejects(
          () => sessionRef._handleDelegation('QA-Browser', 'delegate to self'),
          /cannot delegate to itself/i
        );
      } finally {
        await options.onWorkerEnd('QA-Browser');
      }
      return manifest;
    },
  });
  sessionRef = session;
  try {
    await session._runLoop({ userMessage: 'orchestrate next step' });
  } finally {
    cleanup();
  }
});
