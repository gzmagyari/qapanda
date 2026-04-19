const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extDir = path.resolve(__dirname, '..', 'extension');
const repoSrcDir = path.resolve(__dirname, '..', 'src');
const generatedSrcDir = path.join(extDir, 'src');
if (!fs.existsSync(generatedSrcDir)) {
  fs.cpSync(repoSrcDir, generatedSrcDir, { recursive: true });
  process.on('exit', () => {
    try { fs.rmSync(generatedSrcDir, { recursive: true, force: true }); } catch {}
  });
}

const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');
const compactionPath = path.join(extDir, 'src', 'api-compaction.js');
const chromePath = path.join(extDir, 'chrome-manager.js');

const origState = require(statePath);
const origPrompts = require(promptsPath);

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

function buildSession({ manifest = null, runManagerLoopImpl = null } = {}) {
  const posted = [];
  const captured = {
    saveManifestCalls: [],
    runManagerLoopCalls: [],
  };

  const fakeManifest = manifest || {
    runId: 'critical-run-1',
    status: 'running',
    controllerSystemPrompt: 'original system prompt',
    controller: { model: null, config: [], sessionId: 'controller-session-1' },
    worker: { model: null },
    files: { progress: '/tmp/fake-progress.md' },
  };

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath,
    filename: statePath,
    loaded: true,
    exports: {
      ...origState,
      prepareNewRun: async () => ({ ...fakeManifest }),
      saveManifest: async (value) => {
        captured.saveManifestCalls.push(JSON.parse(JSON.stringify(value)));
      },
    },
  };

  require.cache[orchPath] = {
    id: orchPath,
    filename: orchPath,
    loaded: true,
    exports: {
      runManagerLoop: async (manifestValue, renderer, options) => {
        captured.runManagerLoopCalls.push({ options: { ...options } });
        if (typeof runManagerLoopImpl === 'function') {
          return runManagerLoopImpl(manifestValue, renderer, options);
        }
        return { ...manifestValue, status: 'running' };
      },
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath,
    filename: promptsPath,
    loaded: true,
    exports: {
      ...origPrompts,
      loadWorkflows: () => [],
      buildCopilotBasePrompt: () => 'base copilot prompt',
      buildContinueDirective: () => 'continue directive',
    },
  };

  const { SessionManager } = require(smPath);
  const renderer = stubRenderer();
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    postMessage: (msg) => posted.push(msg),
  });

  session._activeManifest = JSON.parse(JSON.stringify(fakeManifest));
  session._startAgentDelegateMcp = async () => {};
  session._syncMcpToManifest = () => {};
  session._workerRunHooks = () => ({});
  session._beginActivity = () => () => {};
  session._applyWorkerThinking = () => {};
  session._stopAgentDelegateMcp = () => {};

  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    delete require.cache[orchPath];
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
    delete require.cache[compactionPath];
    delete require.cache[chromePath];
  };

  return { session, captured, cleanup };
}

test('_runControllerContinue saves the restored controller state, not the temporary continue state', async () => {
  const { session, captured, cleanup } = buildSession({
    manifest: {
      runId: 'continue-run',
      status: 'running',
      controllerSystemPrompt: 'persistent prompt',
      controller: { model: null, config: [], sessionId: 'controller-session-42' },
      worker: { model: null },
      files: { progress: '/tmp/fake-progress.md' },
    },
  });

  try {
    session._loopMode = false;
    await session._runControllerContinue('keep going');

    assert.equal(captured.saveManifestCalls.length, 1);
    const saved = captured.saveManifestCalls[0];
    assert.equal(saved.controllerSystemPrompt, 'persistent prompt');
    assert.equal(saved.controller.sessionId, 'controller-session-42');
  } finally {
    cleanup();
  }
});

test('_runControllerContinue strips stale continue directives from persisted controller prompts before running', async () => {
  const pollutedPrompt = [
    'persistent prompt',
    '',
    'CONTINUE DIRECTIVE — stale old lock',
    'Use agent_id: "QA-Browser" when delegating.',
  ].join('\n');
  const { session, captured, cleanup } = buildSession({
    manifest: {
      runId: 'continue-run-sanitized',
      status: 'running',
      controllerSystemPrompt: pollutedPrompt,
      controller: { model: null, config: [], sessionId: 'controller-session-77' },
      worker: { model: null },
      files: { progress: '/tmp/fake-progress.md' },
    },
  });

  try {
    session._chatTarget = 'agent-dev';
    await session._runControllerContinue('');

    assert.equal(captured.saveManifestCalls.length, 2);
    assert.equal(captured.saveManifestCalls[0].controllerSystemPrompt, 'persistent prompt');
    assert.equal(captured.saveManifestCalls[1].controllerSystemPrompt, 'persistent prompt');

    const loopCall = captured.runManagerLoopCalls[0];
    assert.ok(loopCall, 'expected runManagerLoop to be called');
    assert.doesNotMatch(loopCall.options.controllerPromptOverride, /QA-Browser/);
    assert.match(loopCall.options.controllerPromptOverride, /continue directive/i);
  } finally {
    cleanup();
  }
});

test('_runControllerContinue restores app-server controller thread state after the temporary continue turn', async () => {
  const { session, captured, cleanup } = buildSession({
    manifest: {
      runId: 'continue-appserver-run',
      status: 'running',
      controllerSystemPrompt: 'persistent prompt',
      controller: {
        model: null,
        config: [],
        sessionId: 'controller-session-42',
        appServerThreadId: 'controller-thread-99',
        threadSandbox: 'danger-full-access',
        approvalPolicy: 'never',
      },
      worker: { model: null },
      files: { progress: '/tmp/fake-progress.md' },
    },
    runManagerLoopImpl: async (manifestValue) => {
      assert.equal(manifestValue.controller.sessionId, null);
      assert.equal(manifestValue.controller.appServerThreadId, null);
      assert.equal(manifestValue.controller.threadSandbox, null);
      assert.equal(manifestValue.controller.approvalPolicy, null);
      return {
        ...manifestValue,
        status: 'running',
        controller: {
          ...manifestValue.controller,
          appServerThreadId: 'temporary-continue-thread',
          threadSandbox: 'danger-full-access',
          approvalPolicy: 'never',
        },
      };
    },
  });

  try {
    await session._runControllerContinue('');

    assert.equal(captured.saveManifestCalls.length, 1);
    const saved = captured.saveManifestCalls[0];
    assert.equal(saved.controller.sessionId, 'controller-session-42');
    assert.equal(saved.controller.appServerThreadId, 'controller-thread-99');
    assert.equal(saved.controller.threadSandbox, 'danger-full-access');
    assert.equal(saved.controller.approvalPolicy, 'never');
  } finally {
    cleanup();
  }
});

test('_handleOrchestrate keeps multi-pass mode even when wait delay is enabled', async () => {
  const { session, captured, cleanup } = buildSession({
    manifest: {
      runId: 'orchestrate-run',
      status: 'running',
      controllerSystemPrompt: 'orchestrate prompt',
      controller: { model: null, config: [], sessionId: 'controller-session-99' },
      worker: { model: null },
      files: { progress: '/tmp/fake-progress.md' },
    },
  });

  try {
    session._waitDelay = '5m';
    await session._handleOrchestrate('continue until done');

    assert.equal(captured.runManagerLoopCalls.length, 1);
    assert.equal(captured.runManagerLoopCalls[0].options.singlePass, false);
  } finally {
    cleanup();
  }
});

test('dispose cancels any scheduled loop-continue timer', async () => {
  const { session, cleanup } = buildSession();
  let continueCalls = 0;

  try {
    session._loopMode = true;
    session._handleContinue = async () => { continueCalls += 1; };
    session._scheduleLoopContinue();
    session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(continueCalls, 0);
  } finally {
    cleanup();
  }
});
