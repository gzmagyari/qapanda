const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../src/session-compaction.js');
const apiPath = path.resolve(__dirname, '../../src/api-compaction.js');
const appServerPath = path.resolve(__dirname, '../../src/codex-app-server.js');
const debugPath = path.resolve(__dirname, '../../src/debug-log.js');
const eventsPath = path.resolve(__dirname, '../../src/events.js');
const processUtilsPath = path.resolve(__dirname, '../../src/process-utils.js');
const statePath = path.resolve(__dirname, '../../src/state.js');
const claudePath = path.resolve(__dirname, '../../src/claude.js');
const claudeControllerPath = path.resolve(__dirname, '../../src/claude-controller.js');
const claudeSanitizerPath = path.resolve(__dirname, '../../src/claude-session-sanitizer.js');

const origApi = require(apiPath);
const origAppServer = require(appServerPath);
const origDebug = require(debugPath);
const origEvents = require(eventsPath);
const origProcessUtils = require(processUtilsPath);
const origState = require(statePath);
const origClaude = require(claudePath);
const origClaudeController = require(claudeControllerPath);
const origClaudeSanitizer = require(claudeSanitizerPath);

function installCache(pathName, exportsValue) {
  require.cache[pathName] = {
    id: pathName,
    filename: pathName,
    loaded: true,
    exports: exportsValue,
  };
}

function restoreModules() {
  delete require.cache[modulePath];
  installCache(apiPath, origApi);
  installCache(appServerPath, origAppServer);
  installCache(debugPath, origDebug);
  installCache(eventsPath, origEvents);
  installCache(processUtilsPath, origProcessUtils);
  installCache(statePath, origState);
  installCache(claudePath, origClaude);
  installCache(claudeControllerPath, origClaudeController);
  installCache(claudeSanitizerPath, origClaudeSanitizer);
}

function loadSessionCompaction(stubs = {}) {
  delete require.cache[modulePath];
  installCache(apiPath, { ...origApi, ...(stubs.api || {}) });
  installCache(appServerPath, { ...origAppServer, ...(stubs.appServer || {}) });
  installCache(debugPath, { ...origDebug, ...(stubs.debug || {}) });
  installCache(eventsPath, { ...origEvents, ...(stubs.events || {}) });
  installCache(processUtilsPath, { ...origProcessUtils, ...(stubs.processUtils || {}) });
  installCache(statePath, { ...origState, ...(stubs.state || {}) });
  installCache(claudePath, { ...origClaude, ...(stubs.claude || {}) });
  installCache(claudeControllerPath, { ...origClaudeController, ...(stubs.claudeController || {}) });
  installCache(claudeSanitizerPath, { ...origClaudeSanitizer, ...(stubs.claudeSanitizer || {}) });
  return require(modulePath);
}

test.afterEach(() => {
  restoreModules();
});

test('resolveCurrentCompactionTarget reports unsupported Codex exec worker sessions', () => {
  const { resolveCurrentCompactionTarget } = loadSessionCompaction();
  const manifest = {
    runId: 'run-1',
    controller: { cli: 'codex', codexMode: 'app-server' },
    worker: { cli: 'codex', bin: 'codex', agentSessions: { dev: { sessionId: 'sess-1', hasStarted: true } } },
    agents: { dev: { name: 'Developer', cli: 'codex', codexMode: 'exec' } },
  };

  const target = resolveCurrentCompactionTarget({
    manifest,
    chatTarget: 'agent-dev',
    workerCli: 'codex',
  });

  assert.equal(target.kind, 'unsupported-codex-exec');
  assert.match(target.message, /not supported/i);
});

test('resolveCurrentCompactionTarget uses worker codexMode for the default worker target', () => {
  const { resolveCurrentCompactionTarget } = loadSessionCompaction();
  const manifest = {
    runId: 'run-1',
    controller: { cli: 'codex', codexMode: 'app-server' },
    worker: { cli: 'codex', bin: 'codex', codexMode: 'exec', sessionId: 'sess-1', hasStarted: true },
  };

  const target = resolveCurrentCompactionTarget({
    manifest,
    chatTarget: 'claude',
    workerCli: 'codex',
  });

  assert.equal(target.kind, 'unsupported-codex-exec');
});

test('compactCurrentSession uses Codex app-server thread compaction and waits for completion', async () => {
  let observedThreadId = null;
  let resumedThreadId = null;
  let notificationHandler = null;
  const fakeConn = {
    ensureConnected: async () => {},
    resumeThread: async (threadId) => {
      resumedThreadId = threadId;
      return threadId;
    },
    onNotification: (handler) => {
      notificationHandler = handler;
    },
    compactThread: async (threadId) => {
      observedThreadId = threadId;
      setImmediate(() => {
        notificationHandler({
          method: 'thread/compacted',
          params: { threadId },
        });
      });
      return { ok: true };
    },
  };

  const { compactCurrentSession } = loadSessionCompaction({
    appServer: {
      getOrCreateConnection: () => fakeConn,
    },
    debug: {
      appendWizardDebug: () => {},
      summarizeForDebug: () => '',
    },
    state: {
      lookupAgentConfig: (agents, agentId) => agents[agentId] || null,
    },
  });

  const manifest = {
    runId: 'run-1',
    repoRoot: '/repo',
    controller: { cli: 'codex', codexMode: 'app-server' },
    worker: {
      cli: 'codex',
      bin: 'codex',
      model: 'gpt-5.4',
      agentSessions: {
        dev: { appServerThreadId: 'thread-worker-1', hasStarted: true },
      },
    },
    agents: {
      dev: { name: 'Developer', cli: 'codex', codexMode: 'app-server', mcps: {} },
    },
  };

  const result = await compactCurrentSession({
    manifest,
    chatTarget: 'agent-dev',
    workerCli: 'codex',
  });

  assert.equal(resumedThreadId, 'thread-worker-1');
  assert.equal(observedThreadId, 'thread-worker-1');
  assert.equal(result.performed, true);
  assert.equal(result.message, 'Current agent session compaction completed.');
});

test('compactCurrentSession sends native /compact through Claude sessions', async () => {
  let capturedSpawn = null;
  let sanitized = null;

  const { compactCurrentSession } = loadSessionCompaction({
    processUtils: {
      spawnStreamingProcess: async (options) => {
        capturedSpawn = options;
        options.onStdoutLine(JSON.stringify({
          session_id: 'sess-2',
          type: 'assistant_message',
          content: [{ type: 'text', text: 'Compacted.' }],
        }));
        return { code: 0, aborted: false };
      },
    },
    debug: {
      appendWizardDebug: () => {},
      summarizeForDebug: () => '',
    },
    state: {
      lookupAgentConfig: (agents, agentId) => agents[agentId] || null,
    },
    claude: {
      buildClaudeArgs: () => ['-p'],
    },
    claudeSanitizer: {
      isClaudeCliCommand: () => true,
      sanitizeClaudeSessionImagesForResume: async (options) => {
        sanitized = options;
      },
    },
  });

  const manifest = {
    runId: 'run-1',
    repoRoot: '/repo',
    controller: { cli: 'codex' },
    worker: {
      cli: 'claude',
      bin: 'claude',
      agentSessions: {
        dev: { sessionId: 'sess-1', hasStarted: true },
      },
    },
    agents: {
      dev: { name: 'ClaudeDev', cli: 'claude', bin: 'claude' },
    },
  };

  const result = await compactCurrentSession({
    manifest,
    chatTarget: 'agent-dev',
    workerCli: 'claude',
  });

  assert.equal(capturedSpawn.command, 'claude');
  assert.deepEqual(capturedSpawn.args, ['-p']);
  assert.equal(capturedSpawn.stdinText, '/compact');
  assert.equal(sanitized.sessionId, 'sess-1');
  assert.equal(manifest.worker.agentSessions.dev.sessionId, 'sess-2');
  assert.equal(manifest.worker.agentSessions.dev.hasStarted, true);
  assert.equal(result.performed, true);
  assert.equal(result.message, 'Current agent session compaction completed.');
});
