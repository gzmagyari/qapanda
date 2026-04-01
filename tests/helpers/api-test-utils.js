/**
 * Shared test utilities for API mode tests.
 * Provides manifest builders, renderer mocks, and mock server helpers.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Create a temporary directory with test files for tool testing.
 * @returns {{ dir, cleanup }}
 */
function createApiTestDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-api-live-'));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'Hello world\nSecond line\nThird line\n');
  fs.writeFileSync(path.join(dir, 'code.js'), 'const x = 1;\nconst y = 2;\nconsole.log(x + y);\n');
  fs.mkdirSync(path.join(dir, 'subdir'));
  fs.writeFileSync(path.join(dir, 'subdir', 'nested.txt'), 'nested content\n');
  fs.mkdirSync(path.join(dir, '.qpanda', 'runs', 'test-run'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.qpanda', 'runs', 'test-run', 'events.jsonl'), '');
  return {
    dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/**
 * Build a manifest configured for API mode with a mock server URL.
 * @param {string} mockUrl - Mock server base URL (e.g. http://127.0.0.1:PORT)
 * @param {string} tmpDir - Temporary directory for state files
 * @param {object} [overrides] - Override any manifest fields
 */
function createApiTestManifest(mockUrl, tmpDir, overrides = {}) {
  const apiConfig = {
    provider: 'custom',
    apiKey: 'test-key',
    baseURL: mockUrl + '/v1',
    model: 'test-model',
    ...(overrides.apiConfig || {}),
  };
  return {
    runId: 'test-run',
    repoRoot: tmpDir,
    stateRoot: path.join(tmpDir, '.qpanda'),
    runDir: path.join(tmpDir, '.qpanda', 'runs', 'test-run'),
    controller: {
      cli: 'api',
      bin: 'api',
      model: null,
      sessionId: null,
      claudeSessionId: null,
      lastSeenChatLine: 0,
      lastSeenTranscriptLine: 0,
      codexMode: 'app-server',
      appServerThreadId: null,
      config: [],
      apiConfig,
      ...(overrides.controller || {}),
    },
    worker: {
      cli: 'api',
      bin: 'api',
      model: null,
      sessionId: 'test-session',
      allowedTools: 'Bash,Read,Edit',
      runMode: 'print',
      agentSessions: {},
      apiConfig,
      ...(overrides.worker || {}),
    },
    apiConfig,
    agents: {
      dev: { name: 'Developer', description: 'Dev agent', system_prompt: 'You are a developer.', mcps: {}, cli: 'api', enabled: true },
      'QA-Browser': { name: 'QA Engineer', description: 'QA agent', system_prompt: 'You are a QA engineer.', mcps: {}, cli: 'api', enabled: true },
      ...(overrides.agents || {}),
    },
    settings: { rawEvents: false, quiet: false, color: true },
    mcpServers: {},
    controllerMcpServers: {},
    workerMcpServers: overrides.workerMcpServers || {},
    controllerSystemPrompt: null,
    selfTesting: false,
    panelId: 'test-panel',
    files: {
      events: path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'events.jsonl'),
      transcript: path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'transcript.jsonl'),
      schema: path.join(tmpDir, '.qpanda', 'runs', 'test-run', 'schema.json'),
    },
    counters: { request: 1, loop: 1, controllerTurn: 0, workerTurn: 0 },
    requests: [],
    ...(overrides.manifest || {}),
  };
}

/**
 * Create a mock renderer that records all calls.
 * @returns {{ output: Array, claude, controller, streamMarkdown, flushStream, banner, user, shell, launchClaude, stop, close }}
 */
function createApiTestRenderer() {
  const output = [];
  return {
    output,
    _post: (msg) => output.push(msg),
    claude: (text) => output.push({ type: 'claude', text }),
    controller: (text) => output.push({ type: 'controller', text }),
    streamMarkdown: (label, text) => output.push({ type: 'stream', label, text }),
    flushStream: () => output.push({ type: 'flush' }),
    banner: (text) => output.push({ type: 'banner', text }),
    user: (text) => output.push({ type: 'user', text }),
    shell: (text) => output.push({ type: 'shell', text }),
    launchClaude: () => {},
    stop: () => {},
    close: () => {},
    controllerEvent: () => {},
    claudeEvent: () => {},
    controllerLabel: 'Controller (API)',
    workerLabel: 'Worker (API)',
    write: () => {},
  };
}

/**
 * Create a stateful mock handler that simulates multi-turn tool call conversations.
 * The handler inspects the messages array to decide whether to return tool calls or final text.
 * @param {Array} turns - Array of response configs, one per API call
 * @returns {function} Handler for createMockServer
 */
function createMultiTurnHandler(turns) {
  let callIndex = 0;
  return (_req, body) => {
    const turn = turns[callIndex] || turns[turns.length - 1];
    callIndex++;
    return turn;
  };
}

/**
 * Helper to collect all events from emitEvent calls.
 */
function createEventCollector() {
  const events = [];
  return {
    events,
    emit: (event) => events.push(event),
  };
}

module.exports = {
  createApiTestDir,
  createApiTestManifest,
  createApiTestRenderer,
  createMultiTurnHandler,
  createEventCollector,
};
