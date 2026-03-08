const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── parseWaitDelay / formatWaitDelay / WAIT_OPTIONS tests ────────────────────

const { WAIT_OPTIONS, parseWaitDelay, formatWaitDelay } = require('../src/state');

test('parseWaitDelay returns 0 for empty/null/undefined', () => {
  assert.equal(parseWaitDelay(''), 0);
  assert.equal(parseWaitDelay(null), 0);
  assert.equal(parseWaitDelay(undefined), 0);
});

test('parseWaitDelay parses known option values', () => {
  assert.equal(parseWaitDelay('1m'), 60_000);
  assert.equal(parseWaitDelay('5m'), 300_000);
  assert.equal(parseWaitDelay('1h'), 3_600_000);
  assert.equal(parseWaitDelay('12h'), 43_200_000);
  assert.equal(parseWaitDelay('1d'), 86_400_000);
  assert.equal(parseWaitDelay('7d'), 604_800_000);
});

test('parseWaitDelay parses arbitrary numeric values', () => {
  assert.equal(parseWaitDelay('45m'), 45 * 60_000);
  assert.equal(parseWaitDelay('8h'), 8 * 3_600_000);
  assert.equal(parseWaitDelay('14d'), 14 * 86_400_000);
});

test('parseWaitDelay returns 0 for unrecognized formats', () => {
  assert.equal(parseWaitDelay('fast'), 0);
  assert.equal(parseWaitDelay('5s'), 0);
  assert.equal(parseWaitDelay('abc'), 0);
});

test('formatWaitDelay formats known ms values', () => {
  assert.equal(formatWaitDelay(0), 'none');
  assert.equal(formatWaitDelay(60_000), '1 min');
  assert.equal(formatWaitDelay(3_600_000), '1 hour');
  assert.equal(formatWaitDelay(86_400_000), '1 day');
});

test('formatWaitDelay handles arbitrary ms values', () => {
  assert.equal(formatWaitDelay(120_000), '2 min');
  assert.equal(formatWaitDelay(null), 'none');
  assert.equal(formatWaitDelay(-1), 'none');
});

test('WAIT_OPTIONS includes all required durations', () => {
  const values = WAIT_OPTIONS.map(o => o.value);
  // Minutes
  for (const v of ['1m', '2m', '3m', '5m', '10m', '15m', '30m']) {
    assert.ok(values.includes(v), `missing ${v}`);
  }
  // Hours
  for (const v of ['1h', '2h', '3h', '5h', '6h', '12h']) {
    assert.ok(values.includes(v), `missing ${v}`);
  }
  // Days
  for (const v of ['1d', '2d', '3d', '4d', '5d', '6d', '7d']) {
    assert.ok(values.includes(v), `missing ${v}`);
  }
  // None
  assert.ok(values.includes(''), 'missing empty (none)');
});

// ── Manifest persistence tests ──────────────────────────────────────────────

test('prepareNewRun includes waitDelay and nextWakeAt fields', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-wait-'));
  try {
    const { prepareNewRun } = require('../src/state');
    const manifest = await prepareNewRun('test', {
      stateRoot: tmpDir,
      repoRoot: tmpDir,
    });
    assert.equal(manifest.waitDelay, null);
    assert.equal(manifest.nextWakeAt, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── SessionManager wait timer tests ─────────────────────────────────────────

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);

function stubRenderer() {
  return new Proxy({}, {
    get() { return () => {}; },
  });
}

function buildSession({ config = {}, runExists = true, manifest = null } = {}) {
  const posted = [];

  const fakeManifest = manifest || {
    runId: 'wait-run',
    runDir: '/tmp/fake',
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: '/tmp/fake/progress.md' },
    status: 'running',
    waitDelay: null,
    nextWakeAt: null,
  };

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async (runId) => {
        if (!runExists) throw new Error('Not found');
        return '/tmp/fake';
      },
      loadManifestFromDir: async () => {
        if (!runExists) throw new Error('Not found');
        return { ...fakeManifest };
      },
      prepareNewRun: async (msg, opts) => ({ ...fakeManifest, runId: 'new-run', status: 'idle' }),
      saveManifest: async () => {},
    },
  };

  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: async (m) => m,
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };

  const { SessionManager } = require(smPath);

  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: config,
    postMessage: (msg) => posted.push(msg),
  });

  const cleanup = () => {
    // Clear any pending timers
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };

  return { session, posted, cleanup };
}

test('applyConfig sets waitDelay on session', () => {
  const { session, cleanup } = buildSession();
  try {
    session.applyConfig({ waitDelay: '5m' });
    assert.equal(session._waitDelay, '5m');
  } finally {
    cleanup();
  }
});

test('applyConfig with empty waitDelay clears it', () => {
  const { session, cleanup } = buildSession({ config: { waitDelay: '10m' } });
  try {
    assert.equal(session._waitDelay, '10m');
    session.applyConfig({ waitDelay: '' });
    assert.equal(session._waitDelay, '');
  } finally {
    cleanup();
  }
});

test('_clearWaitTimer clears pending timer and resets nextWakeAt', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.reattachRun('wait-run');
    session._waitDelay = '1m';
    // Manually set a nextWakeAt
    session._activeManifest.nextWakeAt = new Date(Date.now() + 60000).toISOString();
    session._clearWaitTimer();
    assert.equal(session._activeManifest.nextWakeAt, null);
    const waitMsg = posted.find(m => m.type === 'waitStatus' && m.active === false);
    assert.ok(waitMsg, 'should post waitStatus active:false');
  } finally {
    cleanup();
  }
});

test('/clear clears wait timer', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.reattachRun('wait-run');
    session._waitDelay = '5m';
    await session.handleMessage({ type: 'userInput', text: '/clear' });
    // Wait timer should be cleared (activeManifest null)
    assert.equal(session.getRunId(), null);
    const waitMsg = posted.filter(m => m.type === 'waitStatus');
    assert.ok(waitMsg.length > 0, '/clear should post waitStatus');
  } finally {
    cleanup();
  }
});

test('/detach clears wait timer', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.reattachRun('wait-run');
    session._waitDelay = '5m';
    await session.handleMessage({ type: 'userInput', text: '/detach' });
    assert.equal(session.getRunId(), null);
    const waitMsg = posted.filter(m => m.type === 'waitStatus');
    assert.ok(waitMsg.length > 0, '/detach should post waitStatus');
  } finally {
    cleanup();
  }
});

test('waitDelay persisted in config includes waitDelay field', () => {
  const { session, cleanup } = buildSession({ config: { waitDelay: '10m' } });
  try {
    const config = session._getConfig();
    assert.equal(config.waitDelay, '10m');
  } finally {
    cleanup();
  }
});

test('_getConfig returns empty waitDelay by default', () => {
  const { session, cleanup } = buildSession();
  try {
    const config = session._getConfig();
    assert.equal(config.waitDelay, '');
  } finally {
    cleanup();
  }
});

test('_restoreWaitTimer restores waitDelay from manifest', async () => {
  const manifest = {
    runId: 'wait-run',
    runDir: '/tmp/fake',
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: '/tmp/fake/progress.md' },
    status: 'running',
    waitDelay: '15m',
    nextWakeAt: null,
  };
  const { session, cleanup } = buildSession({ manifest });
  try {
    await session.reattachRun('wait-run');
    session._restoreWaitTimer();
    assert.equal(session._waitDelay, '15m');
  } finally {
    cleanup();
  }
});

test('manual input clears wait timer before running', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    session._waitDelay = '5m';
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    // Should have posted waitStatus active:false (from _clearWaitTimer)
    const waitClear = posted.filter(m => m.type === 'waitStatus' && m.active === false);
    assert.ok(waitClear.length > 0, 'manual input should clear wait timer');
  } finally {
    cleanup();
  }
});

// ── Gap 1: /wait command in extension session-manager ────────────────────────

test('/wait without args shows current delay', async () => {
  const { session, cleanup } = buildSession();
  try {
    session._waitDelay = '5m';
    await session.handleMessage({ type: 'userInput', text: '/wait' });
    // Should not throw; banner output handled by renderer stub
  } finally {
    cleanup();
  }
});

test('/wait with valid delay sets _waitDelay', async () => {
  const { session, cleanup } = buildSession();
  try {
    await session.reattachRun('wait-run');
    await session.handleMessage({ type: 'userInput', text: '/wait 10m' });
    assert.equal(session._waitDelay, '10m');
  } finally {
    cleanup();
  }
});

test('/wait none clears _waitDelay', async () => {
  const { session, cleanup } = buildSession();
  try {
    session._waitDelay = '5m';
    await session.handleMessage({ type: 'userInput', text: '/wait none' });
    assert.equal(session._waitDelay, '');
  } finally {
    cleanup();
  }
});

test('/wait with invalid delay shows error', async () => {
  const { session, cleanup } = buildSession();
  try {
    session._waitDelay = '5m';
    await session.handleMessage({ type: 'userInput', text: '/wait bogus' });
    // _waitDelay should remain unchanged
    assert.equal(session._waitDelay, '5m');
  } finally {
    cleanup();
  }
});

// ── Gap 2: /clear and /detach persist nulled nextWakeAt ──────────────────────

test('/clear persists nulled nextWakeAt before discarding manifest', async () => {
  let savedManifest = null;
  const manifest = {
    runId: 'wait-run',
    runDir: '/tmp/fake',
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: '/tmp/fake/progress.md' },
    status: 'running',
    waitDelay: '5m',
    nextWakeAt: new Date(Date.now() + 60000).toISOString(),
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => '/tmp/fake',
      loadManifestFromDir: async () => ({ ...manifest }),
      prepareNewRun: async (msg, opts) => ({ ...manifest, runId: 'new-run', status: 'idle' }),
      saveManifest: async (m) => { savedManifest = { ...m }; },
    },
  };
  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: { ...origOrch, runManagerLoop: async (m) => m },
  };
  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };
  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    postMessage: () => {},
  });

  try {
    await session.reattachRun('wait-run');
    session._waitDelay = '5m';
    session._activeManifest.nextWakeAt = manifest.nextWakeAt;
    await session.handleMessage({ type: 'userInput', text: '/clear' });
    // saveManifest should have been called with nulled nextWakeAt
    assert.ok(savedManifest, 'saveManifest should have been called');
    assert.equal(savedManifest.nextWakeAt, null, 'nextWakeAt should be null after /clear');
    assert.equal(session.getRunId(), null);
  } finally {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

test('/detach persists nulled nextWakeAt before discarding manifest', async () => {
  let savedManifest = null;
  const manifest = {
    runId: 'wait-run',
    runDir: '/tmp/fake',
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: '/tmp/fake/progress.md' },
    status: 'running',
    waitDelay: '5m',
    nextWakeAt: new Date(Date.now() + 60000).toISOString(),
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => '/tmp/fake',
      loadManifestFromDir: async () => ({ ...manifest }),
      prepareNewRun: async (msg, opts) => ({ ...manifest, runId: 'new-run', status: 'idle' }),
      saveManifest: async (m) => { savedManifest = { ...m }; },
    },
  };
  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: { ...origOrch, runManagerLoop: async (m) => m },
  };
  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };
  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    postMessage: () => {},
  });

  try {
    await session.reattachRun('wait-run');
    session._waitDelay = '5m';
    session._activeManifest.nextWakeAt = manifest.nextWakeAt;
    await session.handleMessage({ type: 'userInput', text: '/detach' });
    assert.ok(savedManifest, 'saveManifest should have been called');
    assert.equal(savedManifest.nextWakeAt, null, 'nextWakeAt should be null after /detach');
    assert.equal(session.getRunId(), null);
  } finally {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

// ── Gap 3: applyConfig reschedules timer on change ───────────────────────────

test('applyConfig reschedules timer when waitDelay changes', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.reattachRun('wait-run');
    // Set initial delay — should schedule
    session.applyConfig({ waitDelay: '5m' });
    const scheduled = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.ok(scheduled.length > 0, 'should schedule timer on applyConfig with delay');

    // Change delay — should reschedule (clear + schedule)
    posted.length = 0;
    session.applyConfig({ waitDelay: '10m' });
    const rescheduled = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.ok(rescheduled.length > 0, 'should reschedule timer on delay change');
  } finally {
    cleanup();
  }
});

test('applyConfig clears timer when waitDelay set to empty', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.reattachRun('wait-run');
    session.applyConfig({ waitDelay: '5m' });
    posted.length = 0;
    session.applyConfig({ waitDelay: '' });
    const cleared = posted.filter(m => m.type === 'waitStatus' && m.active === false);
    assert.ok(cleared.length > 0, 'should clear timer when delay set to empty');
  } finally {
    cleanup();
  }
});

// ── Persistence regression: disabling wait persists nextWakeAt=null ──────────

function buildSessionWithSaveCapture({ manifest = null } = {}) {
  const posted = [];
  const saves = [];

  const fakeManifest = manifest || {
    runId: 'wait-run',
    runDir: '/tmp/fake',
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: '/tmp/fake/progress.md' },
    status: 'running',
    waitDelay: '5m',
    nextWakeAt: new Date(Date.now() + 300000).toISOString(),
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => '/tmp/fake',
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      prepareNewRun: async () => ({ ...fakeManifest }),
      saveManifest: async (m) => { saves.push({ ...m }); },
    },
  };
  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: { ...origOrch, runManagerLoop: async (m) => m },
  };
  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };
  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    postMessage: (msg) => posted.push(msg),
  });
  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };
  return { session, posted, saves, cleanup };
}

test('/wait none persists nextWakeAt=null to disk', async () => {
  const { session, saves, cleanup } = buildSessionWithSaveCapture();
  try {
    await session.reattachRun('wait-run');
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: '/wait none' });
    // _clearWaitTimer should have persisted nextWakeAt=null
    const nullSave = saves.find(s => s.nextWakeAt === null);
    assert.ok(nullSave, 'saveManifest should be called with nextWakeAt=null when disabling wait');
  } finally {
    cleanup();
  }
});

test('applyConfig with empty waitDelay persists nextWakeAt=null to disk', async () => {
  const { session, saves, cleanup } = buildSessionWithSaveCapture();
  try {
    await session.reattachRun('wait-run');
    saves.length = 0;
    session.applyConfig({ waitDelay: '' });
    const nullSave = saves.find(s => s.nextWakeAt === null);
    assert.ok(nullSave, 'saveManifest should be called with nextWakeAt=null when clearing via applyConfig');
  } finally {
    cleanup();
  }
});

// ── Restore guards: stale nextWakeAt ignored when wait is disabled ───────────

test('_restoreWaitTimer ignores stale nextWakeAt when waitDelay is empty', async () => {
  const { session, posted, cleanup } = buildSessionWithSaveCapture({
    manifest: {
      runId: 'wait-run',
      runDir: '/tmp/fake',
      controller: { model: null, config: [] },
      worker: { model: null },
      files: { progress: '/tmp/fake/progress.md' },
      status: 'running',
      waitDelay: null,  // wait is disabled
      nextWakeAt: new Date(Date.now() + 300000).toISOString(),  // stale
    },
  });
  try {
    await session.reattachRun('wait-run');
    posted.length = 0;
    session._restoreWaitTimer();
    // Should NOT have scheduled a timer
    const scheduled = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.equal(scheduled.length, 0, 'should not restore timer when waitDelay is disabled');
    assert.equal(session._waitTimer, null, 'timer should remain null');
  } finally {
    cleanup();
  }
});

test('_restoreWaitTimer honors nextWakeAt when waitDelay is set', async () => {
  const { session, posted, cleanup } = buildSessionWithSaveCapture({
    manifest: {
      runId: 'wait-run',
      runDir: '/tmp/fake',
      controller: { model: null, config: [] },
      worker: { model: null },
      files: { progress: '/tmp/fake/progress.md' },
      status: 'running',
      waitDelay: '5m',
      nextWakeAt: new Date(Date.now() + 300000).toISOString(),
    },
  });
  try {
    await session.reattachRun('wait-run');
    posted.length = 0;
    session._restoreWaitTimer();
    const scheduled = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.ok(scheduled.length > 0, 'should restore timer when waitDelay is set');
    assert.ok(session._waitTimer !== null, 'timer should be set');
  } finally {
    cleanup();
  }
});

// ── Shutdown/reload persistence: dispose must not erase nextWakeAt ───────────

test('dispose does not persist nextWakeAt=null to disk', async () => {
  const { session, saves, cleanup } = buildSessionWithSaveCapture();
  try {
    await session.reattachRun('wait-run');
    // Manifest has nextWakeAt set from buildSessionWithSaveCapture
    saves.length = 0;
    session.dispose();
    // _stopWaitTimer should NOT have called saveManifest
    const nullSave = saves.find(s => s.nextWakeAt === null);
    assert.equal(nullSave, undefined, 'dispose should not persist nextWakeAt=null — timer should survive reload');
  } finally {
    // cleanup already called dispose, but that's fine — it's idempotent
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

test('_stopWaitTimer clears in-memory timer without disk write', async () => {
  const { session, saves, cleanup } = buildSessionWithSaveCapture();
  try {
    await session.reattachRun('wait-run');
    // Schedule a timer so _waitTimer is set
    session._waitDelay = '5m';
    session._scheduleNextPass();
    assert.ok(session._waitTimer !== null, 'timer should be active after schedule');
    saves.length = 0;
    session._stopWaitTimer();
    assert.equal(session._waitTimer, null, 'timer should be cleared in memory');
    // Should not have written nextWakeAt=null to disk
    const nullSave = saves.find(s => s.nextWakeAt === null);
    assert.equal(nullSave, undefined, '_stopWaitTimer should not persist to disk');
  } finally {
    cleanup();
  }
});

test('_clearWaitTimer persists nextWakeAt=null to disk (explicit cancel)', async () => {
  const { session, saves, cleanup } = buildSessionWithSaveCapture();
  try {
    await session.reattachRun('wait-run');
    session._waitDelay = '5m';
    session._scheduleNextPass();
    saves.length = 0;
    session._clearWaitTimer();
    assert.equal(session._waitTimer, null, 'timer should be cleared in memory');
    const nullSave = saves.find(s => s.nextWakeAt === null);
    assert.ok(nullSave, '_clearWaitTimer should persist nextWakeAt=null to disk');
  } finally {
    cleanup();
  }
});

// ── Task 4: Error safety backoff ─────────────────────────────────────────────

function buildErrorSession({ throwError = null, manifest = null } = {}) {
  const posted = [];
  const saves = [];

  const fakeManifest = manifest || {
    runId: 'err-run',
    runDir: '/tmp/fake',
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: '/tmp/fake/progress.md' },
    status: 'running',
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => '/tmp/fake',
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      prepareNewRun: async (msg) => ({ ...fakeManifest, runId: 'new-run', status: 'idle' }),
      saveManifest: async (m) => { saves.push({ ...m }); },
    },
  };
  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: async (m) => {
        if (throwError) {
          // Simulate real orchestrator: markInterrupted sets status='interrupted'
          m.status = 'interrupted';
          m.phase = 'idle';
          m.error = throwError.message;
          throw throwError;
        }
        return m;
      },
    },
  };
  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };
  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    postMessage: (msg) => posted.push(msg),
  });
  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };
  return { session, posted, saves, cleanup };
}

test('genuine error schedules a 30-minute error retry', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    throwError: new Error('Codex process failed'),
  });
  try {
    await session.reattachRun('err-run');
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    // Should have saved manifest with errorRetry=true and a nextWakeAt ~30min out
    const retrySave = saves.find(s => s.errorRetry === true && s.nextWakeAt);
    assert.ok(retrySave, 'saveManifest should be called with errorRetry=true after genuine error');
    const wakeMs = new Date(retrySave.nextWakeAt).getTime() - Date.now();
    // Should be roughly 30 minutes (allow 5s tolerance)
    assert.ok(wakeMs > 29 * 60_000, `nextWakeAt should be ~30min out, got ${Math.round(wakeMs / 60000)}min`);
    assert.ok(session._waitTimer !== null, 'timer should be set for error retry');
  } finally {
    cleanup();
  }
});

test('abort error does NOT schedule error retry', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    throwError: new Error('Claude Code process was interrupted.'),
  });
  try {
    await session.reattachRun('err-run');
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    // Should NOT have saved with errorRetry=true
    const retrySave = saves.find(s => s.errorRetry === true);
    assert.equal(retrySave, undefined, 'abort should not schedule error retry');
    assert.equal(session._waitTimer, null, 'no timer should be set after abort');
  } finally {
    cleanup();
  }
});

test('error retry persists even without waitDelay configured', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    throwError: new Error('API timeout'),
  });
  try {
    await session.reattachRun('err-run');
    // Ensure waitDelay is empty
    session._waitDelay = '';
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    const retrySave = saves.find(s => s.errorRetry === true && s.nextWakeAt);
    assert.ok(retrySave, 'error retry should schedule even without waitDelay');
  } finally {
    cleanup();
  }
});

test('error retry uses 30 min even when longer waitDelay is configured', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    throwError: new Error('API timeout'),
    manifest: {
      runId: 'err-run',
      runDir: '/tmp/fake',
      controller: { model: null, config: [] },
      worker: { model: null },
      files: { progress: '/tmp/fake/progress.md' },
      status: 'running',
      waitDelay: '2h',
      nextWakeAt: null,
      errorRetry: false,
    },
  });
  try {
    await session.reattachRun('err-run');
    session._waitDelay = '2h';
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    const retrySave = saves.find(s => s.errorRetry === true && s.nextWakeAt);
    assert.ok(retrySave, 'error retry should use 30 min even with 2h waitDelay');
    const wakeMs = new Date(retrySave.nextWakeAt).getTime() - Date.now();
    // Should be ~30 min, NOT 2 hours
    assert.ok(wakeMs < 35 * 60_000, `nextWakeAt should be ~30min, not 2h; got ${Math.round(wakeMs / 60000)}min`);
  } finally {
    cleanup();
  }
});

test('_restoreWaitTimer honors errorRetry on interrupted manifest without waitDelay', async () => {
  const wakeAt = new Date(Date.now() + 300000).toISOString();
  const { session, posted, cleanup } = buildErrorSession({
    manifest: {
      runId: 'err-run',
      runDir: '/tmp/fake',
      controller: { model: null, config: [] },
      worker: { model: null },
      files: { progress: '/tmp/fake/progress.md' },
      status: 'interrupted',
      waitDelay: null,
      nextWakeAt: wakeAt,
      errorRetry: true,
    },
  });
  try {
    await session.reattachRun('err-run');
    session._waitDelay = '';
    posted.length = 0;
    session._restoreWaitTimer();
    const scheduled = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.ok(scheduled.length > 0, 'should restore error-retry timer on interrupted manifest');
    assert.ok(session._waitTimer !== null, 'timer should be set');
  } finally {
    cleanup();
  }
});

test('_clearWaitTimer resets errorRetry on disk', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    manifest: {
      runId: 'err-run',
      runDir: '/tmp/fake',
      controller: { model: null, config: [] },
      worker: { model: null },
      files: { progress: '/tmp/fake/progress.md' },
      status: 'interrupted',
      waitDelay: null,
      nextWakeAt: new Date(Date.now() + 300000).toISOString(),
      errorRetry: true,
    },
  });
  try {
    await session.reattachRun('err-run');
    saves.length = 0;
    session._clearWaitTimer();
    const save = saves.find(s => s.errorRetry === false && s.nextWakeAt === null);
    assert.ok(save, '_clearWaitTimer should persist errorRetry=false and nextWakeAt=null');
  } finally {
    cleanup();
  }
});

test('manual /clear cancels pending error retry', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    throwError: new Error('API timeout'),
  });
  try {
    await session.reattachRun('err-run');
    // Trigger error to schedule retry
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    assert.ok(session._waitTimer !== null, 'error retry timer should be set');
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: '/clear' });
    assert.equal(session._waitTimer, null, 'timer should be cleared after /clear');
    assert.equal(session.getRunId(), null, 'run should be detached');
  } finally {
    cleanup();
  }
});

test('genuine error sets manifest to interrupted AND still schedules retry', async () => {
  const { session, saves, cleanup } = buildErrorSession({
    throwError: new Error('Codex controller process failed'),
  });
  try {
    await session.reattachRun('err-run');
    saves.length = 0;
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    // The runManagerLoop stub mutates status to 'interrupted' before throwing
    // _scheduleErrorRetry must accept this status
    const retrySave = saves.find(s => s.errorRetry === true && s.nextWakeAt);
    assert.ok(retrySave, 'retry should schedule despite interrupted status');
    // The manifest saved by _scheduleErrorRetry should still have status='interrupted'
    // (it doesn't reset status until the timer fires)
    assert.equal(retrySave.status, 'interrupted', 'manifest status should remain interrupted until retry fires');
    assert.ok(session._waitTimer !== null, 'timer should be set');
  } finally {
    cleanup();
  }
});

test('_restoreWaitTimer does NOT restore stale nextWakeAt on interrupted manifest without errorRetry', async () => {
  const { session, posted, cleanup } = buildErrorSession({
    manifest: {
      runId: 'err-run',
      runDir: '/tmp/fake',
      controller: { model: null, config: [] },
      worker: { model: null },
      files: { progress: '/tmp/fake/progress.md' },
      status: 'interrupted',
      waitDelay: '5m',
      nextWakeAt: new Date(Date.now() + 300000).toISOString(),
      errorRetry: false,  // not an error retry, just interrupted
    },
  });
  try {
    await session.reattachRun('err-run');
    posted.length = 0;
    session._restoreWaitTimer();
    const scheduled = posted.filter(m => m.type === 'waitStatus' && m.active === true);
    assert.equal(scheduled.length, 0, 'should NOT restore timer on interrupted manifest without errorRetry');
    assert.equal(session._waitTimer, null, 'timer should not be set');
  } finally {
    cleanup();
  }
});

test('prepareNewRun includes errorRetry field', async () => {
  const tmpDir = path.join(os.tmpdir(), `ccm-test-${Date.now()}`);
  try {
    const { prepareNewRun } = require('../src/state');
    const manifest = await prepareNewRun('test', {
      stateRoot: tmpDir,
      repoRoot: tmpDir,
    });
    assert.equal(manifest.errorRetry, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
