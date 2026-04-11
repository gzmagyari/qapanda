const test = require('node:test');
const assert = require('node:assert/strict');

const {
  workerThreadNeedsRecovery,
  workerThreadNeedsForkOnReconnect,
  ensureWorkerAppServerThread,
  forkImportedCodexWorkerSession,
  seedImportedCodexWorkerThread,
} = require('../../src/codex-worker');
const {
  controllerThreadNeedsForkOnReconnect,
  controllerThreadNeedsRecovery,
  ensureControllerAppServerThread,
} = require('../../src/codex');

test('workerThreadNeedsRecovery flags legacy threads without trusted sandbox metadata', () => {
  assert.equal(workerThreadNeedsRecovery({
    appServerThreadId: 'thread-1',
    approvalPolicy: null,
    threadSandbox: null,
  }), true);
  assert.equal(workerThreadNeedsRecovery({
    appServerThreadId: 'thread-1',
    approvalPolicy: 'never',
    threadSandbox: 'danger-full-access',
  }), false);
});

test('ensureWorkerAppServerThread forks legacy worker threads into writable threads', async () => {
  const calls = [];
  const conn = {
    threadId: 'new-thread',
    async forkThread(threadId, options) {
      calls.push(['forkThread', threadId, options]);
      this.threadId = 'forked-thread';
      return 'forked-thread';
    },
    async resumeThread(threadId) {
      calls.push(['resumeThread', threadId]);
      return threadId;
    },
    async startThread() {
      calls.push(['startThread']);
      return 'started-thread';
    },
  };
  const manifest = {
    repoRoot: '/repo',
    worker: { model: null },
  };
  const agentSession = {
    appServerThreadId: 'legacy-thread',
    approvalPolicy: null,
    threadSandbox: null,
  };
  const banners = [];
  const renderer = { banner: (text) => banners.push(text) };

  const action = await ensureWorkerAppServerThread({
    conn,
    manifest,
    agentConfig: { model: 'gpt-5.4' },
    agentSession,
    renderer,
    sessionLabel: 'Developer',
  });

  assert.equal(action, 'forked');
  assert.deepEqual(calls, [[
    'forkThread',
    'legacy-thread',
    { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  ]]);
  assert.equal(agentSession.appServerThreadId, 'forked-thread');
  assert.equal(agentSession.approvalPolicy, 'never');
  assert.equal(agentSession.threadSandbox, 'danger-full-access');
  assert.equal(banners.length, 1);
  assert.match(banners[0], /Recovered Developer session into a writable Codex thread\./);
});

test('ensureWorkerAppServerThread resumes already-healed worker threads without forking', async () => {
  const calls = [];
  const conn = {
    threadId: 'healthy-thread',
    async resumeThread(threadId) {
      calls.push(['resumeThread', threadId]);
      return threadId;
    },
    async forkThread() {
      calls.push(['forkThread']);
      return 'unexpected';
    },
    async startThread() {
      calls.push(['startThread']);
      return 'unexpected';
    },
  };
  const action = await ensureWorkerAppServerThread({
    conn,
    manifest: { repoRoot: '/repo', worker: { model: null } },
    agentConfig: null,
    agentSession: {
      appServerThreadId: 'healthy-thread',
      approvalPolicy: 'never',
      threadSandbox: 'danger-full-access',
    },
    renderer: {},
    sessionLabel: 'Developer',
  });

  assert.equal(action, 'resumed');
  assert.deepEqual(calls, [['resumeThread', 'healthy-thread']]);
});

test('seedImportedCodexWorkerThread seeds untouched worker sessions from imported Codex runs', () => {
  const session = {
    sessionId: 'random-worker-session',
    hasStarted: false,
    appServerThreadId: null,
    approvalPolicy: 'never',
    threadSandbox: 'danger-full-access',
  };

  const changed = seedImportedCodexWorkerThread(session, 'imported-thread-1');

  assert.equal(changed, true);
  assert.equal(session.sessionId, 'imported-thread-1');
  assert.equal(session.appServerThreadId, 'imported-thread-1');
  assert.equal(session.approvalPolicy, null);
  assert.equal(session.threadSandbox, null);
});

test('forkImportedCodexWorkerSession forks imported Codex sessions for CLI-backed agents', async () => {
  const calls = [];
  const sessionState = {
    sessionId: 'temporary-worker-session',
    hasStarted: false,
    appServerThreadId: null,
  };
  const manifest = {
    runId: 'run-1',
    repoRoot: '/repo',
    worker: { model: 'gpt-5.4' },
    importSource: {
      provider: 'codex',
      sessionId: 'imported-thread-1',
    },
  };
  const banners = [];
  const renderer = { banner: (text) => banners.push(text) };
  const fakeConn = {
    async ensureConnected() {
      calls.push(['ensureConnected']);
    },
    async forkThread(threadId, options) {
      calls.push(['forkThread', threadId, options]);
      return 'forked-thread-1';
    },
  };

  const forked = await forkImportedCodexWorkerSession({
    manifest,
    agentConfig: { model: 'gpt-5.4' },
    sessionState,
    sessionKey: 'dev',
    sessionLabel: 'Developer',
    renderer,
    connectionFactory: (connManifest) => {
      calls.push(['connectionFactory', connManifest.runId, connManifest.controller.bin, connManifest.controller.model]);
      return fakeConn;
    },
    closeConnectionFn: async (connectionKey) => {
      calls.push(['closeConnection', connectionKey]);
    },
  });

  assert.equal(forked, 'forked-thread-1');
  assert.deepEqual(calls, [
    ['connectionFactory', 'run-1-import-fork-dev', 'codex', 'gpt-5.4'],
    ['ensureConnected'],
    ['forkThread', 'imported-thread-1', { approvalPolicy: 'never', sandbox: 'danger-full-access' }],
    ['closeConnection', 'run-1-import-fork-dev'],
  ]);
  assert.equal(sessionState.sessionId, 'forked-thread-1');
  assert.equal(sessionState.appServerThreadId, 'forked-thread-1');
  assert.equal(sessionState.hasStarted, true);
  assert.equal(sessionState.approvalPolicy, 'never');
  assert.equal(sessionState.threadSandbox, 'danger-full-access');
  assert.equal(banners.length, 1);
  assert.match(banners[0], /Recovered Developer session into a writable Codex thread\./);
});

test('workerThreadNeedsForkOnReconnect flags trusted threads when the app-server connection changed', () => {
  assert.equal(workerThreadNeedsForkOnReconnect(
    { threadId: null },
    { appServerThreadId: 'thread-1', approvalPolicy: 'never', threadSandbox: 'danger-full-access' },
  ), true);
  assert.equal(workerThreadNeedsForkOnReconnect(
    { threadId: 'thread-1' },
    { appServerThreadId: 'thread-1', approvalPolicy: 'never', threadSandbox: 'danger-full-access' },
  ), false);
});

test('ensureWorkerAppServerThread forks trusted worker threads after app-server reconnect', async () => {
  const calls = [];
  const conn = {
    threadId: null,
    async forkThread(threadId, options) {
      calls.push(['forkThread', threadId, options]);
      this.threadId = 'forked-after-reconnect';
      return 'forked-after-reconnect';
    },
    async resumeThread(threadId) {
      calls.push(['resumeThread', threadId]);
      return threadId;
    },
    async startThread() {
      calls.push(['startThread']);
      return 'unexpected';
    },
  };
  const agentSession = {
    appServerThreadId: 'trusted-thread',
    approvalPolicy: 'never',
    threadSandbox: 'danger-full-access',
  };

  const action = await ensureWorkerAppServerThread({
    conn,
    manifest: { repoRoot: '/repo', worker: { model: null } },
    agentConfig: null,
    agentSession,
    renderer: {},
    sessionLabel: 'Developer',
  });

  assert.equal(action, 'forked');
  assert.deepEqual(calls, [[
    'forkThread',
    'trusted-thread',
    { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  ]]);
  assert.equal(agentSession.appServerThreadId, 'forked-after-reconnect');
});

test('controllerThreadNeedsRecovery flags legacy controller threads without trusted sandbox metadata', () => {
  assert.equal(controllerThreadNeedsRecovery({
    appServerThreadId: 'thread-1',
    approvalPolicy: null,
    threadSandbox: null,
  }), true);
  assert.equal(controllerThreadNeedsRecovery({
    appServerThreadId: 'thread-1',
    approvalPolicy: 'never',
    threadSandbox: 'danger-full-access',
  }), false);
});

test('controllerThreadNeedsForkOnReconnect flags trusted controller threads when the app-server connection changed', () => {
  assert.equal(controllerThreadNeedsForkOnReconnect(
    { threadId: null },
    { appServerThreadId: 'thread-1', approvalPolicy: 'never', threadSandbox: 'danger-full-access' },
  ), true);
  assert.equal(controllerThreadNeedsForkOnReconnect(
    { threadId: 'thread-1' },
    { appServerThreadId: 'thread-1', approvalPolicy: 'never', threadSandbox: 'danger-full-access' },
  ), false);
});

test('ensureControllerAppServerThread forks legacy controller threads into writable threads', async () => {
  const calls = [];
  const conn = {
    async forkThread(threadId, options) {
      calls.push(['forkThread', threadId, options]);
      return 'forked-controller';
    },
    async resumeThread(threadId) {
      calls.push(['resumeThread', threadId]);
      return threadId;
    },
    async startThread() {
      calls.push(['startThread']);
      return 'started-controller';
    },
  };
  const manifest = {
    repoRoot: '/repo',
    controller: {
      model: 'gpt-5.4',
      appServerThreadId: 'legacy-controller',
      approvalPolicy: null,
      threadSandbox: null,
    },
  };
  const banners = [];
  const renderer = { banner: (text) => banners.push(text) };

  const action = await ensureControllerAppServerThread(conn, manifest, renderer);

  assert.equal(action, 'forked');
  assert.deepEqual(calls, [[
    'forkThread',
    'legacy-controller',
    { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  ]]);
  assert.equal(manifest.controller.appServerThreadId, 'forked-controller');
  assert.equal(manifest.controller.approvalPolicy, 'never');
  assert.equal(manifest.controller.threadSandbox, 'danger-full-access');
  assert.equal(banners.length, 1);
  assert.match(banners[0], /Recovered controller session into a writable Codex thread\./);
});

test('ensureControllerAppServerThread forks trusted controller threads after app-server reconnect', async () => {
  const calls = [];
  const conn = {
    threadId: null,
    async forkThread(threadId, options) {
      calls.push(['forkThread', threadId, options]);
      return 'forked-controller-after-reconnect';
    },
    async resumeThread(threadId) {
      calls.push(['resumeThread', threadId]);
      return threadId;
    },
    async startThread() {
      calls.push(['startThread']);
      return 'unexpected';
    },
  };
  const manifest = {
    repoRoot: '/repo',
    controller: {
      model: 'gpt-5.4',
      appServerThreadId: 'trusted-controller',
      approvalPolicy: 'never',
      threadSandbox: 'danger-full-access',
    },
  };

  const action = await ensureControllerAppServerThread(conn, manifest, {});

  assert.equal(action, 'forked');
  assert.deepEqual(calls, [[
    'forkThread',
    'trusted-controller',
    { approvalPolicy: 'never', sandbox: 'danger-full-access' },
  ]]);
  assert.equal(manifest.controller.appServerThreadId, 'forked-controller-after-reconnect');
});
