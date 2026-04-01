const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// session-manager.js lives in extension/ and requires('./src/...').
// We patch those cache entries just like session-manager-config.test.js does.

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');
const compactionPath = path.join(extDir, 'src', 'api-compaction.js');

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
const origCompaction = require(compactionPath);

function buildSession({ config = {}, runExists = true, manifest = null } = {}) {
  const posted = [];

  const fakeManifest = manifest || {
    runId: 'existing-run-42',
    controller: { model: null, config: [] },
    worker: { model: null },
  };

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async (runId, _stateRoot) => {
        if (!runExists) throw new Error(`Run ${runId} not found`);
        return `/fake/runs/${runId}`;
      },
      loadManifestFromDir: async (_dir) => {
        if (!runExists) throw new Error('Not found');
        return { ...fakeManifest };
      },
      prepareNewRun: async (msg, opts) => ({ ...fakeManifest, runId: 'new-run' }),
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

  const renderer = stubRenderer();
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: config,
    postMessage: (msg) => posted.push(msg),
  });

  const cleanup = () => {
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
    require.cache[compactionPath] = { id: compactionPath, filename: compactionPath, loaded: true, exports: origCompaction };
  };

  return { session, posted, renderer, cleanup };
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('reattachRun succeeds when run exists', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: true });
  try {
    const ok = await session.reattachRun('existing-run-42');
    assert.equal(ok, true);
    assert.equal(session.getRunId(), 'existing-run-42');
    // Should post setRunId to webview
    const setMsg = posted.find(m => m.type === 'setRunId');
    assert.ok(setMsg, 'should post setRunId');
    assert.equal(setMsg.runId, 'existing-run-42');
  } finally {
    cleanup();
  }
});

test('reattachRun fails gracefully when run is missing', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: false });
  try {
    const ok = await session.reattachRun('gone-run');
    assert.equal(ok, false);
    assert.equal(session.getRunId(), null);
    // Should post clearRunId
    const clearMsg = posted.find(m => m.type === 'clearRunId');
    assert.ok(clearMsg, 'should post clearRunId on failed reattach');
  } finally {
    cleanup();
  }
});

test('reattachRun with null/empty runId returns false without error', async () => {
  const { session, cleanup } = buildSession();
  try {
    assert.equal(await session.reattachRun(null), false);
    assert.equal(await session.reattachRun(''), false);
  } finally {
    cleanup();
  }
});

test('getRunId returns null when no run is attached', () => {
  const { session, cleanup } = buildSession();
  try {
    assert.equal(session.getRunId(), null);
  } finally {
    cleanup();
  }
});

test('/clear posts clearRunId to webview', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: true });
  try {
    // Attach a run first
    await session.reattachRun('existing-run-42');
    posted.length = 0; // reset

    await session.handleMessage({ type: 'userInput', text: '/clear' });
    assert.equal(session.getRunId(), null);
    const clearMsg = posted.find(m => m.type === 'clearRunId');
    assert.ok(clearMsg, '/clear should post clearRunId');
    const clearUI = posted.find(m => m.type === 'clear');
    assert.ok(clearUI, '/clear should post clear');
  } finally {
    cleanup();
  }
});

test('/compact compacts the current API agent session locally', async () => {
  let captured = null;
  require.cache[compactionPath] = {
    id: compactionPath,
    filename: compactionPath,
    loaded: true,
    exports: {
      ...origCompaction,
      compactApiSessionHistory: async (opts) => {
        captured = opts;
        return { performed: true, replayMessageCountBefore: 520, replayMessageCountAfter: 80 };
      },
      describeCompactionResult: () => 'Current agent session compacted successfully.',
    },
  };

  const manifest = {
    runId: 'existing-run-42',
    apiConfig: { provider: 'openrouter', model: 'openai/gpt-4.1' },
    controller: { cli: 'codex', model: null, config: [], apiConfig: null },
    worker: { cli: 'api', model: null, apiConfig: { provider: 'openrouter', model: 'openai/gpt-4.1' } },
    agents: {
      'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'api' },
    },
    requests: [{ id: 'req-1', loops: [{ index: 3 }] }],
  };
  const { session, posted, cleanup } = buildSession({
    runExists: true,
    manifest,
    config: { chatTarget: 'agent-QA-Browser', workerCli: 'api' },
  });
  try {
    await session.reattachRun('existing-run-42');
    await session.handleMessage({ type: 'userInput', text: '/compact' });
    assert.ok(captured, 'should invoke local compaction');
    assert.equal(captured.sessionKey, 'worker:agent:QA-Browser');
    assert.equal(captured.backend, 'worker:api');
    assert.equal(captured.force, true);
    assert.ok(
      posted.some((msg) => msg.type === 'running' && msg.value === true && msg.showStop === false),
      'should show an in-progress indicator immediately'
    );
    assert.ok(
      posted.some((msg) => msg.type === 'running' && msg.value === false && msg.showStop === false),
      'should clear the in-progress indicator after compaction'
    );
  } finally {
    cleanup();
  }
});

test('/compact no-ops with a banner when current target is not API', async () => {
  let called = false;
  require.cache[compactionPath] = {
    id: compactionPath,
    filename: compactionPath,
    loaded: true,
    exports: {
      ...origCompaction,
      compactApiSessionHistory: async () => {
        called = true;
        return { performed: true };
      },
    },
  };

  const manifest = {
    runId: 'existing-run-42',
    controller: { cli: 'codex', model: null, config: [] },
    worker: { cli: 'codex', model: null },
  };
  const { session, cleanup } = buildSession({ runExists: true, manifest });
  try {
    await session.reattachRun('existing-run-42');
    await session.handleMessage({ type: 'userInput', text: '/compact' });
    assert.equal(called, false, 'should not compact non-API targets');
  } finally {
    cleanup();
  }
});

test('/detach posts clearRunId to webview', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: true });
  try {
    await session.reattachRun('existing-run-42');
    posted.length = 0;

    await session.handleMessage({ type: 'userInput', text: '/detach' });
    assert.equal(session.getRunId(), null);
    const clearMsg = posted.find(m => m.type === 'clearRunId');
    assert.ok(clearMsg, '/detach should post clearRunId');
  } finally {
    cleanup();
  }
});

test('/new posts setRunId to webview', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.handleMessage({ type: 'userInput', text: '/new test task' });
    const setMsg = posted.find(m => m.type === 'setRunId');
    assert.ok(setMsg, '/new should post setRunId');
  } finally {
    cleanup();
  }
});

test('plain text start posts setRunId to webview', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.handleMessage({ type: 'userInput', text: 'do something' });
    const setMsg = posted.find(m => m.type === 'setRunId');
    assert.ok(setMsg, 'plain text start should post setRunId');
  } finally {
    cleanup();
  }
});

test('/resume posts setRunId to webview', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: true });
  try {
    await session.handleMessage({ type: 'userInput', text: '/resume existing-run-42' });
    const setMsg = posted.find(m => m.type === 'setRunId');
    assert.ok(setMsg, '/resume should post setRunId');
    assert.equal(setMsg.runId, 'existing-run-42');
  } finally {
    cleanup();
  }
});

test('reattach then /clear then new run gives correct runId', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: true });
  try {
    await session.reattachRun('existing-run-42');
    assert.equal(session.getRunId(), 'existing-run-42');

    await session.handleMessage({ type: 'userInput', text: '/clear' });
    assert.equal(session.getRunId(), null);

    await session.handleMessage({ type: 'userInput', text: 'fresh start' });
    assert.equal(session.getRunId(), 'new-run');
    const setMsgs = posted.filter(m => m.type === 'setRunId');
    const lastSet = setMsgs[setMsgs.length - 1];
    assert.equal(lastSet.runId, 'new-run');
  } finally {
    cleanup();
  }
});

// ── Transcript rehydration tests ─────────────────────────────────────────────

function buildTranscriptSession(transcriptLines, manifestOverrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, transcriptLines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const posted = [];
  const fakeManifest = {
    runId: 'transcript-run',
    runDir: tmpDir,
    controller: { model: null, config: [] },
    worker: { model: null },
    files: {
      transcript: transcriptFile,
      progress: path.join(tmpDir, 'progress.md'),
    },
    status: 'running',
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
    ...manifestOverrides,
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      prepareNewRun: async (msg) => ({ ...fakeManifest, runId: 'new-run' }),
      saveManifest: async () => {},
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  };
  return { session, posted, cleanup };
}

test('sendTranscript posts transcriptHistory with mapped message types', async () => {
  const { session, posted, cleanup } = buildTranscriptSession([
    { ts: '2025-01-01T00:00:00Z', role: 'user', text: 'Hello', requestId: 'req-0001' },
    { ts: '2025-01-01T00:00:01Z', role: 'controller', text: 'Delegating to Claude', requestId: 'req-0001' },
    { ts: '2025-01-01T00:00:02Z', role: 'claude', text: 'Done editing file.js', requestId: 'req-0001' },
    { ts: '2025-01-01T00:00:03Z', role: 'controller', text: '[STOP]', requestId: 'req-0001' },
  ], {
    worker: {
      model: null,
      cli: 'api',
      agentSessions: {
        'QA-Browser': { hasStarted: true },
      },
    },
    agents: {
      'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'api' },
    },
  });
  try {
    await session.reattachRun('transcript-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should post transcriptHistory');
    assert.equal(hist.messages.length, 4);
    assert.deepEqual(hist.messages[0], { type: 'user', text: 'Hello' });
    assert.deepEqual(hist.messages[1], { type: 'controller', text: 'Delegating to Claude', label: 'Orchestrator (Codex)' });
    assert.deepEqual(hist.messages[2], { type: 'claude', text: 'Done editing file.js', label: 'QA Engineer (Browser)' });
    assert.deepEqual(hist.messages[3], { type: 'stop', label: 'Orchestrator (Codex)' });
  } finally {
    cleanup();
  }
});

test('sendTranscript restores transcript v2 tool calls and screenshots', async () => {
  const { session, posted, cleanup } = buildTranscriptSession([
    {
      v: 2,
      ts: '2025-01-01T00:00:00Z',
      kind: 'controller_message',
      sessionKey: 'controller:main',
      backend: 'controller:codex',
      requestId: 'req-0001',
      loopIndex: 1,
      text: 'Delegating to the browser agent',
    },
    {
      v: 2,
      ts: '2025-01-01T00:00:01Z',
      kind: 'tool_call',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      toolCallId: 'shot-1',
      toolName: 'chrome_devtools__take_screenshot',
      input: {},
      payload: {
        id: 'shot-1',
        type: 'function',
        function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
      },
    },
    {
      v: 2,
      ts: '2025-01-01T00:00:02Z',
      kind: 'tool_result',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      toolCallId: 'shot-1',
      toolName: 'chrome_devtools__take_screenshot',
      result: {
        content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
      },
    },
    {
      v: 2,
      ts: '2025-01-01T00:00:03Z',
      kind: 'assistant_message',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      text: 'The page shows a consent modal.',
      payload: { role: 'assistant', content: 'The page shows a consent modal.' },
    },
  ]);
  try {
    await session.reattachRun('transcript-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should post transcriptHistory');
    assert.ok(hist.messages.some(m => m.type === 'controller'));
    assert.ok(hist.messages.some(m => m.type === 'chatScreenshot'));
    assert.ok(hist.messages.some(m => m.type === 'claude' && m.text === 'The page shows a consent modal.'));
  } finally {
    cleanup();
  }
});

test('sendTranscript does not duplicate v2 tool cards or mirrored screenshots', async () => {
  const { session, posted, cleanup } = buildTranscriptSession([
    {
      v: 2,
      ts: '2025-01-01T00:00:01Z',
      kind: 'tool_call',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      toolCallId: 'shot-1',
      toolName: 'chrome_devtools__take_screenshot',
      input: {},
      payload: {
        id: 'shot-1',
        type: 'function',
        function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
      },
    },
    {
      v: 2,
      ts: '2025-01-01T00:00:02Z',
      kind: 'tool_result',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      toolCallId: 'shot-1',
      toolName: 'chrome_devtools__take_screenshot',
      result: {
        content: [{ type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' }],
      },
    },
    {
      v: 2,
      ts: '2025-01-01T00:00:02.500Z',
      kind: 'ui_message',
      sessionKey: 'worker:default',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      payload: {
        type: 'chatScreenshot',
        data: 'data:image/jpeg;base64,anBlZw==',
        alt: 'Browser screenshot',
      },
    },
  ]);
  try {
    await session.reattachRun('transcript-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should post transcriptHistory');
    assert.equal(hist.messages.filter(m => m.type === 'mcpCardStart').length, 1);
    assert.equal(hist.messages.filter(m => m.type === 'mcpCardComplete').length, 1);
    assert.equal(hist.messages.filter(m => m.type === 'chatScreenshot').length, 1);
  } finally {
    cleanup();
  }
});

test('sendTranscript does nothing when transcript file is empty', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, '');

  const posted = [];
  const fakeManifest = {
    runId: 'empty-run',
    runDir: tmpDir,
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { transcript: transcriptFile },
    status: 'running',
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async () => {},
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

  try {
    await session.reattachRun('empty-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.equal(hist, undefined, 'should not post transcriptHistory for empty transcript');
  } finally {
    session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

test('sendTranscript does nothing when no manifest is attached', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.equal(hist, undefined, 'should not post transcriptHistory with no manifest');
  } finally {
    cleanup();
  }
});

test('/resume sends transcript history before progress', async () => {
  const { session, posted, cleanup } = buildTranscriptSession([
    { ts: '2025-01-01T00:00:00Z', role: 'user', text: 'Hello' },
    { ts: '2025-01-01T00:00:01Z', role: 'controller', text: 'OK' },
  ]);
  try {
    posted.length = 0;
    await session.handleMessage({ type: 'userInput', text: '/resume transcript-run' });
    const histIdx = posted.findIndex(m => m.type === 'transcriptHistory');
    const progressIdx = posted.findIndex(m => m.type === 'progressFull');
    assert.ok(histIdx >= 0, 'should post transcriptHistory on /resume');
    assert.ok(progressIdx >= 0, 'should post progressFull on /resume');
    assert.ok(histIdx < progressIdx, 'transcriptHistory should come before progressFull');
  } finally {
    cleanup();
  }
});

test('sendTranscript skips malformed JSONL lines gracefully', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, [
    JSON.stringify({ ts: '2025-01-01T00:00:00Z', role: 'user', text: 'Hello' }),
    'this is not json',
    JSON.stringify({ ts: '2025-01-01T00:00:01Z', role: 'claude', text: 'World' }),
  ].join('\n') + '\n');

  const posted = [];
  const fakeManifest = {
    runId: 'malformed-run',
    runDir: tmpDir,
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { transcript: transcriptFile },
    status: 'running',
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async () => {},
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

  try {
    await session.reattachRun('malformed-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should post transcriptHistory even with malformed lines');
    assert.equal(hist.messages.length, 2, 'should skip malformed line and include valid ones');
    assert.deepEqual(hist.messages[0], { type: 'user', text: 'Hello' });
    assert.deepEqual(hist.messages[1], { type: 'claude', text: 'World' });
  } finally {
    session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

// ── Minimal persisted state tests (extension-host side) ──────────────────────
// NOTE: The browser-side vscode.setState/getState behavior cannot be unit-tested
// from Node.js. These tests verify the extension-host restore contract: that
// only a runId is needed from webview state to fully restore a session, and that
// sendTranscript() provides the authoritative chat history from disk.

test('serializer restore: reattach + sendTranscript works with only runId (no messageLog)', async () => {
  // Simulates the serializer path: state = { runId: '...' } with no messageLog.
  // Extension host should reattach successfully and send full transcript.
  const { session, posted, cleanup } = buildTranscriptSession([
    { ts: '2025-01-01T00:00:00Z', role: 'user', text: 'First' },
    { ts: '2025-01-01T00:00:01Z', role: 'claude', text: 'Second' },
  ]);
  try {
    // Simulate serializer: reattach with just runId
    const ok = await session.reattachRun('transcript-run');
    assert.equal(ok, true, 'reattach should succeed');
    assert.equal(session.getRunId(), 'transcript-run');

    posted.length = 0;
    await session.sendTranscript();

    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'sendTranscript should produce transcriptHistory');
    assert.equal(hist.messages.length, 2);
    assert.deepEqual(hist.messages[0], { type: 'user', text: 'First' });
    assert.deepEqual(hist.messages[1], { type: 'claude', text: 'Second' });
  } finally {
    cleanup();
  }
});

test('serializer restore: failed reattach posts clearRunId and skips transcript', async () => {
  const { session, posted, cleanup } = buildSession({ runExists: false });
  try {
    const ok = await session.reattachRun('gone-run');
    assert.equal(ok, false);

    posted.length = 0;
    await session.sendTranscript();

    // No manifest attached, so sendTranscript should be a no-op
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.equal(hist, undefined, 'should not post transcriptHistory after failed reattach');
  } finally {
    cleanup();
  }
});

// ── Controller-label regression tests ─────────────────────────────────────────

test('sendTranscript uses manifest CLI for old entries without controllerCli', async () => {
  // Older transcript entries lack controllerCli. The fallback should use the
  // manifest's controller.cli (claude), NOT the session default (codex).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, [
    JSON.stringify({ ts: '2025-01-01T00:00:00Z', role: 'user', text: 'Hello' }),
    // No controllerCli field — simulates older transcript
    JSON.stringify({ ts: '2025-01-01T00:00:01Z', role: 'controller', text: 'Delegating' }),
    JSON.stringify({ ts: '2025-01-01T00:00:02Z', role: 'claude', text: 'Done' }),
    JSON.stringify({ ts: '2025-01-01T00:00:03Z', role: 'controller', text: '[STOP]' }),
  ].join('\n') + '\n');

  const posted = [];
  const fakeManifest = {
    runId: 'old-transcript-run',
    runDir: tmpDir,
    controller: { model: null, config: [], cli: 'claude' },
    worker: { model: null },
    files: { transcript: transcriptFile, progress: path.join(tmpDir, 'progress.md') },
    status: 'idle',
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async () => {},
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
  // Session default is codex, but manifest says claude
  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: { controllerCli: 'codex' },
    postMessage: (msg) => posted.push(msg),
  });

  try {
    await session.reattachRun('old-transcript-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should post transcriptHistory');
    // Controller entries should use manifest's CLI (claude), not session default (codex)
    assert.deepEqual(hist.messages[1], { type: 'controller', text: 'Delegating', label: 'Orchestrator (Claude)' });
    assert.deepEqual(hist.messages[3], { type: 'stop', label: 'Orchestrator (Claude)' });
  } finally {
    session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

test('reattachRun updates renderer.controllerLabel from manifest', async () => {
  const fakeManifest = {
    runId: 'claude-run',
    controller: { model: null, config: [], cli: 'claude' },
    worker: { model: null },
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => '/fake/runs/claude-run',
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async () => {},
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
  // Use a plain object renderer so we can read controllerLabel back
  const renderer = { controllerLabel: null };
  const noop = () => {};
  for (const m of ['write','flushStream','user','controller','claude','shell','banner','line','mdLine','streamMarkdown','launchClaude','stop','close','requestStarted','requestFinished','userPrompt','progress']) {
    renderer[m] = noop;
  }
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: { controllerCli: 'codex' },
    postMessage: () => {},
  });

  try {
    assert.equal(renderer.controllerLabel, 'Orchestrator (Codex)');
    await session.reattachRun('claude-run');
    assert.equal(renderer.controllerLabel, 'Orchestrator (Claude)');
  } finally {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

test('/resume updates renderer.controllerLabel from manifest', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, JSON.stringify({ role: 'user', text: 'Hi' }) + '\n');

  const posted = [];
  const fakeManifest = {
    runId: 'claude-resume-run',
    runDir: tmpDir,
    controller: { model: null, config: [], cli: 'claude' },
    worker: { model: null },
    files: { transcript: transcriptFile, progress: path.join(tmpDir, 'progress.md') },
    status: 'idle',
    waitDelay: null,
    nextWakeAt: null,
    errorRetry: false,
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async () => {},
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
  // Use a plain object renderer so we can read controllerLabel back
  const renderer = { controllerLabel: null };
  const noop = () => {};
  for (const m of ['write','flushStream','user','controller','claude','shell','banner','line','mdLine','streamMarkdown','launchClaude','stop','close','requestStarted','requestFinished','userPrompt','progress']) {
    renderer[m] = noop;
  }
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig: { controllerCli: 'codex' },
    postMessage: (msg) => posted.push(msg),
  });

  try {
    assert.equal(renderer.controllerLabel, 'Orchestrator (Codex)');
    await session.handleMessage({ type: 'userInput', text: '/resume claude-resume-run' });
    assert.equal(renderer.controllerLabel, 'Orchestrator (Claude)');
  } finally {
    session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});

test('sendTranscript does not include saveManifest side effects', async () => {
  // Verify sendTranscript is read-only: it reads the transcript file and posts
  // a message, but does not call saveManifest or modify the manifest.
  let saveCalled = false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transcript-'));
  const transcriptFile = path.join(tmpDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptFile, JSON.stringify({ role: 'user', text: 'Hi' }) + '\n');

  const fakeManifest = {
    runId: 'readonly-run',
    runDir: tmpDir,
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { transcript: transcriptFile },
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
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      saveManifest: async () => { saveCalled = true; },
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
  const posted = [];
  const session = new SessionManager(stubRenderer(), {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    postMessage: (msg) => posted.push(msg),
  });

  try {
    await session.reattachRun('readonly-run');
    saveCalled = false; // reset after reattach
    posted.length = 0;

    await session.sendTranscript();

    assert.equal(saveCalled, false, 'sendTranscript should not call saveManifest');
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should still post transcriptHistory');
  } finally {
    session.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
  }
});
