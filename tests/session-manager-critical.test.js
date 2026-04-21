const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
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
const origChrome = require(chromePath);

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

function buildSession({ manifest = null, runManagerLoopImpl = null, chrome = {} } = {}) {
  const posted = [];
  const captured = {
    saveManifestCalls: [],
    runManagerLoopCalls: [],
    capturePanelScreenshotCalls: [],
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

  require.cache[chromePath] = {
    id: chromePath,
    filename: chromePath,
    loaded: true,
    exports: {
      ...origChrome,
      capturePanelScreenshot: async (panelId, options) => {
        captured.capturePanelScreenshotCalls.push({ panelId, options: options || null });
        if (chrome.capturePanelScreenshot) return chrome.capturePanelScreenshot(panelId, options);
        return {
          dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
          targetId: 'target-1',
          targetUrl: 'https://app.qapanda.localhost/app',
          format: 'jpeg',
        };
      },
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
    require.cache[chromePath] = { id: chromePath, filename: chromePath, loaded: true, exports: origChrome };
  };

  return { session, captured, posted, cleanup };
}

test('_runControllerContinue saves the restored controller state, not the temporary continue state', async () => {
  const { session, captured, posted, cleanup } = buildSession({
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
  const { session, captured, posted, cleanup } = buildSession({
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
  const { session, captured, posted, cleanup } = buildSession({
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

test('captureTurnBrowserScreenshot captures from Chrome manager and posts one anchored chat screenshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-browser-shot-'));
  const transcriptFile = path.join(tempDir, 'transcript.jsonl');
  const chatLogFile = path.join(tempDir, 'chat.jsonl');
  const { session, captured, posted, cleanup } = buildSession({
    manifest: {
      runId: 'browser-shot-run',
      status: 'running',
      controllerSystemPrompt: 'prompt',
      controller: { model: null, config: [], sessionId: 'controller-session-1' },
      worker: { model: null, cli: 'codex' },
      files: {
        progress: path.join(tempDir, 'progress.md'),
        transcript: transcriptFile,
        chatLog: chatLogFile,
      },
      requests: [{ id: 'req-1', loops: [{ index: 1 }] }],
    },
    chrome: {
      capturePanelScreenshot: async () => ({
        dataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
        targetId: 'target-1',
        targetUrl: 'https://app.qapanda.localhost/app/settings',
        format: 'jpeg',
      }),
    },
  });

  try {
    session._chromePort = 9222;
    session._chatTarget = 'agent-dev';
    await session.handleMessage({ type: 'captureTurnBrowserScreenshot', token: 'anchor-1' });

    assert.equal(captured.capturePanelScreenshotCalls.length, 1);
    assert.equal(captured.capturePanelScreenshotCalls[0].panelId, session.panelId);
    const postedMessage = posted.find((msg) => msg.type === 'chatScreenshot');
    assert.ok(postedMessage, 'expected chatScreenshot to be posted to the webview');
    assert.equal(postedMessage._anchorToken, 'anchor-1');
    assert.equal(postedMessage.data, 'data:image/jpeg;base64,ZmFrZQ==');

    const chatLogText = fs.readFileSync(chatLogFile, 'utf8');
    assert.match(chatLogText, /"type":"chatScreenshot"/);
    assert.doesNotMatch(chatLogText, /_anchorToken/);

    const transcriptText = fs.readFileSync(transcriptFile, 'utf8');
    assert.match(transcriptText, /chatScreenshot/);
    assert.match(transcriptText, /app\/settings/);
  } finally {
    cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('_handleMcpToolCompletion posts and persists live tool screenshots for image-bearing output', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-tool-shot-'));
  const transcriptFile = path.join(tempDir, 'transcript.jsonl');
  const chatLogFile = path.join(tempDir, 'chat.jsonl');
  const { session, posted, cleanup } = buildSession({
    manifest: {
      runId: 'tool-shot-run',
      status: 'running',
      controllerSystemPrompt: 'prompt',
      controller: { model: null, config: [], sessionId: 'controller-session-1' },
      worker: { model: null, cli: 'api' },
      files: {
        progress: path.join(tempDir, 'progress.md'),
        transcript: transcriptFile,
        chatLog: chatLogFile,
      },
      requests: [{ id: 'req-1', loops: [{ index: 1 }] }],
    },
  });

  try {
    session._chatTarget = 'agent-dev';
    await session._handleMcpToolCompletion({
      serverName: 'chrome-devtools',
      toolName: 'take_screenshot',
      output: {
        content: [
          { type: 'text', text: 'Captured the page.' },
          { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
        ],
      },
    });

    const postedMessage = posted.find((msg) => msg.type === 'chatScreenshot');
    assert.ok(postedMessage, 'expected tool screenshot to be posted to the webview');
    assert.equal(postedMessage.alt, 'Tool screenshot');
    assert.equal(postedMessage.data, 'data:image/png;base64,ZmFrZQ==');
    assert.equal(postedMessage.closeAfter, undefined);

    const chatLogText = fs.readFileSync(chatLogFile, 'utf8');
    assert.match(chatLogText, /"alt":"Tool screenshot"/);
    assert.match(chatLogText, /"closeAfter":false/);

    const transcriptText = fs.readFileSync(transcriptFile, 'utf8');
    assert.match(transcriptText, /Tool screenshot/);
    assert.match(transcriptText, /take_screenshot/);
  } finally {
    cleanup();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('_handleMcpToolCompletion supports Claude-style tool_result image blocks', async () => {
  const { session, posted, cleanup } = buildSession();

  try {
    session._chatTarget = 'agent-dev';
    await session._handleMcpToolCompletion({
      toolName: 'mcp__chrome-devtools__take_screenshot',
      output: [
        { type: 'text', text: 'Captured the page.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
      ],
    });

    const postedMessage = posted.find((msg) => msg.type === 'chatScreenshot');
    assert.ok(postedMessage, 'expected Claude-style screenshot output to be posted to the webview');
    assert.equal(postedMessage.alt, 'Tool screenshot');
    assert.equal(postedMessage.data, 'data:image/png;base64,ZmFrZQ==');
  } finally {
    cleanup();
  }
});

test('_handleMcpToolCompletion does not emit screenshots for non-image tool output', async () => {
  const { session, posted, cleanup } = buildSession();

  try {
    session._chatTarget = 'agent-dev';
    await session._handleMcpToolCompletion({
      serverName: 'chrome-devtools',
      toolName: 'evaluate_script',
      output: {
        content: [{ type: 'text', text: '42' }],
      },
    });

    assert.equal(posted.some((msg) => msg.type === 'chatScreenshot'), false);
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
