const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// session-manager.js lives in extension/ and requires('./src/state') etc.,
// which resolves to extension/src/state.  We patch those cache entries.

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal renderer stub. */
function stubRenderer() {
  return new Proxy({}, {
    get() { return () => {}; },
  });
}

/** Pre-load the real modules so we can restore them. */
const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);

function buildSession(config = {}, { workflows } = {}) {
  const captured = { prepareNewRunCalls: [] };

  const fakeManifest = () => ({
    runId: 'test-run',
    controller: { model: null, config: [] },
    worker: { model: null },
  });

  // Patch modules in require cache
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

  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: async (manifest) => manifest,
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: {
      ...origPrompts,
      loadWorkflows: () => workflows || [],
    },
  };

  const { SessionManager } = require(smPath);

  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: config,
  });

  const cleanup = () => {
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };

  return { session, captured, cleanup };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('/new applies controller model from config', async () => {
  const { session, captured, cleanup } = buildSession({ controllerModel: 'gpt-5.4' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    assert.equal(captured.prepareNewRunCalls[0].opts.controllerModel, 'gpt-5.4');
  } finally {
    cleanup();
  }
});

test('/new applies worker model from config', async () => {
  const { session, captured, cleanup } = buildSession({ workerModel: 'opus' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    assert.equal(captured.prepareNewRunCalls[0].opts.workerModel, 'opus');
  } finally {
    cleanup();
  }
});

test('/new applies controller thinking from config', async () => {
  const { session, captured, cleanup } = buildSession({ controllerThinking: 'high' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    const config = captured.prepareNewRunCalls[0].opts.controllerConfig;
    assert.ok(Array.isArray(config), 'controllerConfig should be an array');
    assert.ok(config.some(c => c.includes('model_reasoning_effort="high"')));
  } finally {
    cleanup();
  }
});

test('/new sets CLAUDE_CODE_EFFORT_LEVEL for worker thinking', async () => {
  const origEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const { session, cleanup } = buildSession({ workerThinking: 'medium' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new do stuff' });
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = origEnv;
    cleanup();
  }
});

test('plain-text start applies all config (parity with /new)', async () => {
  const origEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const { session, captured, cleanup } = buildSession({
    controllerModel: 'gpt-5.4',
    workerModel: 'opus',
    controllerThinking: 'high',
    workerThinking: 'low',
  });
  try {
    await session.handleMessage({ type: 'userInput', text: 'do stuff' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    const opts = captured.prepareNewRunCalls[0].opts;
    assert.equal(opts.controllerModel, 'gpt-5.4');
    assert.equal(opts.workerModel, 'opus');
    assert.ok(opts.controllerConfig.some(c => c.includes('model_reasoning_effort="high"')));
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = origEnv;
    cleanup();
  }
});

test('/new with all config matches plain-text start options', async () => {
  const origEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  const config = {
    controllerModel: 'gpt-5.3-codex',
    workerModel: 'sonnet',
    controllerThinking: 'medium',
    workerThinking: 'high',
  };

  // Run via /new
  const s1 = buildSession(config);
  await s1.session.handleMessage({ type: 'userInput', text: '/new do stuff' });
  const newOpts = s1.captured.prepareNewRunCalls[0].opts;
  const newEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  s1.cleanup();

  // Reset env
  if (origEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  else process.env.CLAUDE_CODE_EFFORT_LEVEL = origEnv;

  // Run via plain text
  const s2 = buildSession(config);
  await s2.session.handleMessage({ type: 'userInput', text: 'do stuff' });
  const plainOpts = s2.captured.prepareNewRunCalls[0].opts;
  const plainEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  s2.cleanup();

  // They should match
  assert.equal(newOpts.controllerModel, plainOpts.controllerModel);
  assert.equal(newOpts.workerModel, plainOpts.workerModel);
  assert.deepEqual(newOpts.controllerConfig, plainOpts.controllerConfig);
  assert.equal(newEffort, plainEffort);

  // Restore
  if (origEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  else process.env.CLAUDE_CODE_EFFORT_LEVEL = origEnv;
});

test('clearing worker thinking deletes CLAUDE_CODE_EFFORT_LEVEL', async () => {
  const origEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  // Start with worker thinking set
  const { session, cleanup } = buildSession({ workerThinking: 'high' });
  try {
    await session.handleMessage({ type: 'userInput', text: '/new first run' });
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');

    // Simulate user clearing worker thinking back to default
    session.applyConfig({ workerThinking: '' });

    // Next run should clear the env var
    await session.handleMessage({ type: 'userInput', text: 'second run' });
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = origEnv;
    cleanup();
  }
});

test('setting worker thinking after default sets CLAUDE_CODE_EFFORT_LEVEL', async () => {
  const origEnv = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  // Start with no worker thinking
  const { session, cleanup } = buildSession({});
  try {
    await session.handleMessage({ type: 'userInput', text: '/new first run' });
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);

    // Now set worker thinking
    session.applyConfig({ workerThinking: 'low' });

    await session.handleMessage({ type: 'userInput', text: 'second run' });
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  } finally {
    if (origEnv === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = origEnv;
    cleanup();
  }
});

test('/workflow includes name, path, summary, and full file body in message', async () => {
  const wfPath = '/tmp/fake-repo/.cc-manager/workflows/autonomous-dev/WORKFLOW.md';
  const wfBody = '---\nname: autonomous-dev\ndescription: Run autonomous dev loop\n---\n\nStep 1: clone repo\nStep 2: run tests';
  const workflows = [
    { name: 'autonomous-dev', description: 'Run autonomous dev loop', path: wfPath },
  ];

  const { session, captured, cleanup } = buildSession({}, { workflows });
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = (p, enc) => {
    if (p === wfPath) return wfBody;
    return origReadFileSync.call(fs, p, enc);
  };
  try {
    await session.handleMessage({ type: 'userInput', text: '/workflow autonomous-dev' });
    assert.equal(captured.prepareNewRunCalls.length, 1);
    const msg = captured.prepareNewRunCalls[0].msg;
    assert.ok(msg.includes('autonomous-dev'), 'message should contain workflow name');
    assert.ok(msg.includes(wfPath), 'message should contain workflow file path');
    assert.ok(msg.includes('Run autonomous dev loop'), 'message should contain summary');
    assert.ok(msg.includes('Step 1: clone repo'), 'message should contain body text from file');
    assert.ok(msg.includes('Step 2: run tests'), 'message should contain body text from file');
  } finally {
    fs.readFileSync = origReadFileSync;
    cleanup();
  }
});
