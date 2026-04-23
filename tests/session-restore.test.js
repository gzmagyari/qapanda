const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// session-manager.js lives in extension/ and requires('./src/...').
// We patch those cache entries just like session-manager-config.test.js does.

const extDir = path.resolve(__dirname, '..', 'extension');
const repoSrcDir = path.resolve(__dirname, '..', 'src');
const generatedSrcDir = path.join(extDir, 'src');
fs.mkdirSync(generatedSrcDir, { recursive: true });
fs.cpSync(repoSrcDir, generatedSrcDir, { recursive: true, force: true });

const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');
const sessionCompactionPath = path.join(extDir, 'src', 'session-compaction.js');
const appServerPath = path.join(extDir, 'src', 'codex-app-server.js');
const namedWorkspacesPath = path.join(extDir, 'src', 'named-workspaces.js');
const chromePath = path.join(extDir, 'chrome-manager.js');

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
const origSessionCompaction = require(sessionCompactionPath);
const origAppServer = require(appServerPath);
const origChrome = require(chromePath);

function buildSession({ config = {}, runExists = true, manifest = null, chrome = {}, appServer = {}, sessionOptions = {} } = {}) {
  const posted = [];
  const captured = {
    saveManifestCalls: [],
    reserveChromePortCalls: [],
    attachExistingChromeCalls: [],
    ensureChromeCalls: [],
    startScreencastCalls: [],
    stopScreencastCalls: [],
    setPanelPageBindingCalls: [],
    syncPanelPageTargetCalls: [],
    collapsePanelToSinglePageCalls: [],
    prestartConnectionCalls: [],
  };

  const fakeManifest = manifest || {
    runId: 'existing-run-42',
    controller: { model: null, config: [] },
    worker: { model: null },
  };

  delete require.cache[smPath];
  delete require.cache[namedWorkspacesPath];

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
      saveManifest: async (value) => {
        captured.saveManifestCalls.push(JSON.parse(JSON.stringify(value)));
      },
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

  require.cache[appServerPath] = {
    id: appServerPath,
    filename: appServerPath,
    loaded: true,
    exports: {
      ...origAppServer,
      prestartConnection: async (options) => {
        captured.prestartConnectionCalls.push({
          key: options.key,
          bin: options.bin,
          cwd: options.cwd,
          mcpKeys: Object.keys(options.mcpServers || {}).sort(),
          manifest: options.manifest || null,
        });
        if (appServer.prestartConnection) return appServer.prestartConnection(options);
        return { isConnected: true };
      },
      closeConnectionsWhere: async (predicate) => {
        if (appServer.closeConnectionsWhere) return appServer.closeConnectionsWhere(predicate);
      },
    },
  };

  require.cache[chromePath] = {
    id: chromePath,
    filename: chromePath,
    loaded: true,
    exports: {
      ...origChrome,
      reserveChromePort: async (panelId, preferredPort) => {
        captured.reserveChromePortCalls.push({ panelId, preferredPort: preferredPort == null ? null : preferredPort });
        if (chrome.reserveChromePort) return chrome.reserveChromePort(panelId, preferredPort);
        return preferredPort || 45555;
      },
      attachExistingChrome: async (panelId, port) => {
        captured.attachExistingChromeCalls.push({ panelId, port });
        if (chrome.attachExistingChrome) return chrome.attachExistingChrome(panelId, port);
        return null;
      },
      releaseChromeReservation: (panelId) => {
        if (chrome.releaseChromeReservation) return chrome.releaseChromeReservation(panelId);
      },
      ensureChrome: async (panelId, options) => {
        captured.ensureChromeCalls.push({ panelId, options: options || null });
        if (chrome.ensureChrome) return chrome.ensureChrome(panelId, options);
        return null;
      },
      startScreencast: async (panelId, _onFrame, _onNav) => {
        captured.startScreencastCalls.push({ panelId });
        if (chrome.startScreencast) return chrome.startScreencast(panelId, _onFrame, _onNav);
        return { started: true, targetId: 'target-1', url: 'https://www.google.com/' };
      },
      stopScreencast: (panelId) => {
        captured.stopScreencastCalls.push({ panelId });
        if (chrome.stopScreencast) return chrome.stopScreencast(panelId);
      },
      setPanelPageBinding: (panelId, binding) => {
        captured.setPanelPageBindingCalls.push({
          panelId,
          binding: binding == null ? null : JSON.parse(JSON.stringify(binding)),
        });
        if (chrome.setPanelPageBinding) return chrome.setPanelPageBinding(panelId, binding);
        return true;
      },
      syncPanelPageTarget: async (panelId, selection) => {
        captured.syncPanelPageTargetCalls.push({
          panelId,
          selection: selection == null ? null : JSON.parse(JSON.stringify(selection)),
        });
        if (chrome.syncPanelPageTarget) return chrome.syncPanelPageTarget(panelId, selection);
        return { status: 'already-bound' };
      },
      collapsePanelToSinglePage: async (panelId, options) => {
        captured.collapsePanelToSinglePageCalls.push({
          panelId,
          options: options == null ? null : JSON.parse(JSON.stringify(options)),
        });
        if (chrome.collapsePanelToSinglePage) return chrome.collapsePanelToSinglePage(panelId, options);
        return { status: 'single-page', targetId: 'target-1', targetUrl: 'https://www.google.com/' };
      },
      getChromeDebugState: (panelId) => {
        if (chrome.getChromeDebugState) return chrome.getChromeDebugState(panelId);
        return origChrome.getChromeDebugState(panelId);
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
    ...sessionOptions,
  });

  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    delete require.cache[namedWorkspacesPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
    require.cache[sessionCompactionPath] = {
      id: sessionCompactionPath,
      filename: sessionCompactionPath,
      loaded: true,
      exports: origSessionCompaction,
    };
    require.cache[appServerPath] = { id: appServerPath, filename: appServerPath, loaded: true, exports: origAppServer };
    require.cache[chromePath] = { id: chromePath, filename: chromePath, loaded: true, exports: origChrome };
  };

  return { session, posted, renderer, cleanup, captured };
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

test('reattachRun restores run-scoped agent browser overrides into syncConfig', async () => {
  const { session, posted, cleanup } = buildSession({
    runExists: true,
    manifest: {
      runId: 'existing-run-42',
      chatTarget: 'agent-dev',
      controller: { model: null, config: [], cli: 'codex' },
      worker: { model: null, cli: 'codex', agentSessions: {} },
      agents: { dev: { name: 'Developer', cli: 'codex', enabled: true, mcps: {} } },
      agentRuntimeOverrides: { dev: { enableChromeDevtools: true } },
    },
  });
  try {
    session.setAgents({
      system: { dev: { name: 'Developer', cli: 'codex', enabled: true, mcps: {} } },
      global: {},
      project: {},
    });
    const ok = await session.reattachRun('existing-run-42');
    assert.equal(ok, true);
    assert.equal(session.getConfig().agentBrowserEnabled, true);
    const syncMsg = posted.find((msg) => msg.type === 'syncConfig');
    assert.ok(syncMsg, 'should post syncConfig after reattach');
    assert.equal(syncMsg.config.chatTarget, 'agent-dev');
    assert.equal(syncMsg.config.agentBrowserEnabled, true);
  } finally {
    cleanup();
  }
});

test('/clear preserves a resume alias for the next fresh run', async () => {
  const { session, posted, renderer, cleanup } = buildSession({
    sessionOptions: { preserveResumeAliasOnClear: true },
    runExists: true,
    manifest: {
      runId: 'existing-run-42',
      resumeToken: 'main',
      chatTarget: 'agent-memory',
      controller: { model: null, config: [], cli: 'codex' },
      worker: { model: null, cli: 'codex', agentSessions: { memory: { hasStarted: true } } },
      agents: { memory: { name: 'Memory', cli: 'codex', enabled: true } },
    },
  });
  try {
    session.setAgents({ system: { memory: { name: 'Memory', cli: 'codex', enabled: true } }, global: {}, project: {} });
    await session.reattachRun('existing-run-42');
    posted.length = 0;

    await session.handleMessage({ type: 'userInput', text: '/clear' });

    assert.equal(session.getRunId(), null);
    assert.equal(session.getPanelContext().resume, 'main');
    assert.equal(session._pendingResumeAlias, 'main');
    const panelContextMsg = posted.find((msg) => msg.type === 'panelContext');
    assert.ok(panelContextMsg, 'should sync panel context after clear');
    assert.equal(panelContextMsg.context.resume, 'main');
    const bannerCall = renderer.__calls.find((call) =>
      call.method === 'banner' && /rebind alias "main"/i.test(call.args[0])
    );
    assert.ok(bannerCall, 'should explain that the alias will be rebound on the next message');
  } finally {
    cleanup();
  }
});

test('/clear clears the persisted resume target by default', async () => {
  const { session, posted, renderer, cleanup } = buildSession({
    runExists: true,
    manifest: {
      runId: 'existing-run-42',
      resumeToken: 'main',
      chatTarget: 'agent-memory',
      controller: { model: null, config: [], cli: 'codex' },
      worker: { model: null, cli: 'codex', agentSessions: { memory: { hasStarted: true } } },
      agents: { memory: { name: 'Memory', cli: 'codex', enabled: true } },
    },
  });
  try {
    session.setAgents({ system: { memory: { name: 'Memory', cli: 'codex', enabled: true } }, global: {}, project: {} });
    await session.reattachRun('existing-run-42');
    posted.length = 0;

    await session.handleMessage({ type: 'userInput', text: '/clear' });

    assert.equal(session.getRunId(), null);
    assert.equal(session.getPanelContext().resume, null);
    assert.equal(session._pendingResumeAlias, null);
    const panelContextMsg = posted.find((msg) => msg.type === 'panelContext');
    assert.ok(panelContextMsg, 'default clear should sync panel context');
    assert.equal(panelContextMsg.context.resume, null);
    const bannerCall = renderer.__calls.find((call) =>
      call.method === 'banner' && /Session cleared\./i.test(call.args[0])
    );
    assert.ok(bannerCall, 'should show the default clear banner');
    assert.ok(!/rebind alias/i.test(bannerCall.args[0]), 'default clear should not mention alias rebinding');
  } finally {
    cleanup();
  }
});

test('reattachRun restores persisted chatTarget from manifest and syncs it to the webview', async () => {
  const { session, posted, renderer, cleanup } = buildSession({
    runExists: true,
    config: { chatTarget: 'agent-QA-Browser' },
    manifest: {
      runId: 'existing-run-42',
      chatTarget: 'agent-dev',
      controller: { model: null, config: [], cli: 'codex' },
      worker: { model: null, cli: 'codex', agentSessions: { dev: { hasStarted: true } } },
      agents: { dev: { name: 'Developer', cli: 'codex', enabled: true } },
    },
  });
  try {
    session.setAgents({ system: { dev: { name: 'Developer', cli: 'codex', enabled: true } }, global: {}, project: {} });
    const ok = await session.reattachRun('existing-run-42');
    assert.equal(ok, true);
    assert.equal(session._getConfig().chatTarget, 'agent-dev');
    const syncMsg = posted.find((msg) => msg.type === 'syncConfig');
    assert.ok(syncMsg, 'should post syncConfig on reattach');
    assert.equal(syncMsg.config.chatTarget, 'agent-dev');
    const bannerCall = renderer.__calls.find((call) => call.method === 'banner');
    assert.ok(bannerCall, 'should announce target session restore');
    assert.match(bannerCall.args[0], /Restored target Developer/i);
  } finally {
    cleanup();
  }
});

test('reattachRun restores manifest panelId and reattaches to an existing browser session', async () => {
  const { session, posted, cleanup, captured } = buildSession({
    runExists: true,
    manifest: {
      runId: 'existing-run-42',
      panelId: 'run-panel-123',
      chromeDebugPort: 45555,
      chatTarget: 'agent-QA-Browser',
      controller: { model: null, config: [], cli: 'codex' },
      worker: { model: null, cli: 'codex', agentSessions: { 'QA-Browser': { hasStarted: true } }, workerMcpServers: {} },
      agents: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } },
    },
    chrome: {
      ensureChrome: async (_panelId, options) => ({ port: options.port, status: 'adopted' }),
    },
  });
  try {
    session.setAgents({ system: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } }, global: {}, project: {} });
    const ok = await session.reattachRun('existing-run-42');
    assert.equal(ok, true);
    assert.equal(session.panelId, 'run-panel-123');
    assert.equal(session._chromePort, 45555);
    assert.equal(captured.attachExistingChromeCalls.length, 0);
    assert.deepEqual(captured.ensureChromeCalls, [{ panelId: 'run-panel-123', options: { port: 45555 } }]);
    assert.ok(
      posted.some((msg) => msg.type === 'chromeReady' && msg.chromePort === 45555),
      'should post chromeReady for the adopted browser'
    );
  } finally {
    cleanup();
  }
});

test('reattachRun starts a replacement browser when the saved browser session is gone', async () => {
  const { session, renderer, cleanup, captured } = buildSession({
    runExists: true,
    manifest: {
      runId: 'existing-run-42',
      panelId: 'run-panel-123',
      chromeDebugPort: 45555,
      chatTarget: 'agent-QA-Browser',
      controller: { model: null, config: [], cli: 'codex' },
      worker: { model: null, cli: 'codex', agentSessions: { 'QA-Browser': { hasStarted: true } }, workerMcpServers: {} },
      agents: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } },
    },
    chrome: {
      ensureChrome: async (_panelId, options) => ({ port: options.port, status: 'started' }),
    },
  });
  try {
    session.setAgents({ system: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } }, global: {}, project: {} });
    const ok = await session.reattachRun('existing-run-42');
    assert.equal(ok, true);
    assert.equal(session.panelId, 'run-panel-123');
    assert.equal(session._chromePort, 45555);
    assert.equal(captured.attachExistingChromeCalls.length, 0);
    assert.deepEqual(captured.ensureChromeCalls, [{ panelId: 'run-panel-123', options: { port: 45555 } }]);
    assert.ok(captured.saveManifestCalls.length >= 1);
    assert.equal(captured.saveManifestCalls[0].panelId, 'run-panel-123');
    assert.equal(captured.saveManifestCalls[0].chromeDebugPort, 45555);
    const browserBanner = renderer.__calls.find((call) =>
      call.method === 'banner' && /restarted chrome on port 45555/i.test(call.args[0])
    );
    assert.ok(browserBanner, 'should announce replacement browser startup');
  } finally {
    cleanup();
  }
});

test('_restoreBrowserForAttachedRun is single-flight and only starts one replacement browser', async () => {
  let ensureChromeStarted = 0;
  let releaseEnsureChrome;
  const manifest = {
    runId: 'existing-run-42',
    panelId: 'run-panel-123',
    chromeDebugPort: 45555,
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: { 'QA-Browser': { hasStarted: true } } },
    agents: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } },
  };
  const { session, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      ensureChrome: async (_panelId, options) => {
        ensureChromeStarted += 1;
        await new Promise((resolve) => { releaseEnsureChrome = resolve; });
        return { port: options.port, status: 'started' };
      },
    },
  });
  try {
    session.setAgents({ system: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } }, global: {}, project: {} });
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = manifest.panelId;

    const first = session._restoreBrowserForAttachedRun();
    const second = session._restoreBrowserForAttachedRun();
    await new Promise((resolve) => setImmediate(resolve));
    releaseEnsureChrome();
    await Promise.all([first, second]);

    assert.equal(ensureChromeStarted, 1);
    assert.deepEqual(captured.ensureChromeCalls, [{ panelId: 'run-panel-123', options: { port: 45555 } }]);
    assert.equal(session._chromePort, 45555);
  } finally {
    cleanup();
  }
});

test('_restoreBrowserForAttachedRun reapplies the saved chrome page binding before screencast start', async () => {
  const manifest = {
    runId: 'existing-run-bound-page',
    panelId: 'run-panel-bound-page',
    chromeDebugPort: 45555,
    chromePageBinding: {
      targetId: 'target-settings',
      url: 'https://app.qapanda.localhost/app/settings',
      pageNumber: 8,
      boundBy: 'mcp:select_page',
    },
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: { 'QA-Browser': { hasStarted: true } } },
    agents: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } },
  };
  const { session, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      ensureChrome: async (_panelId, options) => ({ port: options.port, status: 'existing' }),
    },
  });
  try {
    session.setAgents({ system: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } }, global: {}, project: {} });
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = manifest.panelId;

    await session._restoreBrowserForAttachedRun();

    assert.deepEqual(captured.setPanelPageBindingCalls, [{
      panelId: 'run-panel-bound-page',
      binding: {
        targetId: 'target-settings',
        url: 'https://app.qapanda.localhost/app/settings',
        pageNumber: 8,
        boundBy: 'mcp:select_page',
      },
    }]);
    assert.deepEqual(captured.collapsePanelToSinglePageCalls, [{
      panelId: 'run-panel-bound-page',
      options: {
        keepTargetId: null,
        reason: 'startup:_restoreBrowserForAttachedRun',
        reconnect: false,
      },
    }]);
  } finally {
    cleanup();
  }
});

test('_restoreBrowserForAttachedRun restores Chrome readiness without starting screencast while hidden', async () => {
  const manifest = {
    runId: 'existing-run-hidden-webview',
    panelId: 'run-panel-hidden-webview',
    chromeDebugPort: 45555,
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: { 'QA-Browser': { hasStarted: true } } },
    agents: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } },
  };
  const { session, posted, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    sessionOptions: { webviewVisible: false },
    chrome: {
      ensureChrome: async (_panelId, options) => ({ port: options.port, status: 'existing' }),
    },
  });
  try {
    session.setAgents({ system: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'codex', enabled: true, mcps: { 'chrome-devtools': {} } } }, global: {}, project: {} });
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = manifest.panelId;

    await session._restoreBrowserForAttachedRun();

    assert.deepEqual(captured.ensureChromeCalls, [{ panelId: 'run-panel-hidden-webview', options: { port: 45555 } }]);
    assert.deepEqual(captured.startScreencastCalls, []);
    assert.ok(posted.some((msg) => msg && msg.type === 'chromeReady' && msg.chromePort === 45555));

    await session.setWebviewVisible(true);

    assert.deepEqual(captured.startScreencastCalls, []);

    await session._requestChromeScreencast('test-explicit-screencast');

    assert.deepEqual(captured.startScreencastCalls, [{ panelId: 'run-panel-hidden-webview' }]);

    await session.setWebviewVisible(false);
    assert.deepEqual(captured.stopScreencastCalls, [{ panelId: 'run-panel-hidden-webview' }]);
  } finally {
    cleanup();
  }
});

test('_ensureChromeIfNeeded makes browser MCP ready without starting frame streaming', async () => {
  const manifest = {
    runId: 'browser-enabled-dev-run',
    panelId: 'panel-browser-enabled-dev',
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: { dev: { hasStarted: true } } },
    workerMcpServers: {},
    agents: {
      dev: {
        name: 'Developer',
        cli: 'codex',
        enabled: true,
        mcps: { 'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp'] } },
      },
    },
  };
  const { session, posted, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      ensureChrome: async (_panelId, options) => ({ port: options.port || 45555, status: 'started' }),
    },
  });
  try {
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = manifest.panelId;

    await session._ensureChromeIfNeeded('dev');

    assert.equal(captured.ensureChromeCalls.length, 1);
    assert.equal(captured.ensureChromeCalls[0].panelId, 'panel-browser-enabled-dev');
    assert.deepEqual(captured.startScreencastCalls, []);
    assert.ok(posted.some((msg) => msg && msg.type === 'chromeReady' && msg.chromePort === 45555));
  } finally {
    cleanup();
  }
});

test('chrome devtools tool detection requests screencast for the active turn', async () => {
  const { session, cleanup, captured } = buildSession();
  try {
    session._panelId = 'panel-tool-detected';
    session._chromePort = 53333;

    await session._renderer.handleChromeDevtoolsDetected();

    assert.deepEqual(captured.startScreencastCalls, [{ panelId: 'panel-tool-detected' }]);
  } finally {
    cleanup();
  }
});

test('_startChromeScreencast does not restart an already-active screencast on the same port', async () => {
  const { session, posted, cleanup, captured } = buildSession();
  try {
    session._panelId = 'panel-screencast-dedupe';

    await session._startChromeScreencast(53333, 'first-start');
    await session._startChromeScreencast(53333, 'second-start');

    assert.deepEqual(captured.startScreencastCalls, [{ panelId: 'panel-screencast-dedupe' }]);
    assert.equal(posted.filter((msg) => msg && msg.type === 'chromeReady' && msg.chromePort === 53333).length, 2);
  } finally {
    cleanup();
  }
});

test('_startChromeScreencast does not mark active when chrome-manager fails to attach', async () => {
  const { session, posted, cleanup, captured } = buildSession({
    chrome: {
      startScreencast: async () => ({ started: false, reason: 'no-page-target' }),
    },
  });
  try {
    session._panelId = 'panel-screencast-failed-start';

    await session._startChromeScreencast(53333, 'failed-start-1');
    await session._startChromeScreencast(53333, 'failed-start-2');

    assert.equal(session._screencastActive, false);
    assert.equal(session._screencastPort, null);
    assert.deepEqual(captured.startScreencastCalls, [
      { panelId: 'panel-screencast-failed-start' },
      { panelId: 'panel-screencast-failed-start' },
    ]);
    assert.equal(posted.some((msg) => msg && msg.type === 'chromeReady'), false);
  } finally {
    cleanup();
  }
});

test('_startChromeScreencast does not resurrect streaming if webview is hidden while start is pending', async () => {
  let releaseStart;
  const startPromise = new Promise((resolve) => {
    releaseStart = () => resolve({ started: true, targetId: 'target-1', url: 'https://www.google.com/' });
  });
  const { session, posted, cleanup, captured } = buildSession({
    chrome: {
      startScreencast: async () => startPromise,
    },
  });
  try {
    session._panelId = 'panel-screencast-hide-race';

    const pendingStart = session._startChromeScreencast(53333, 'slow-start');
    await new Promise((resolve) => setImmediate(resolve));
    await session.setWebviewVisible(false);
    releaseStart();
    await pendingStart;

    assert.equal(session._screencastActive, false);
    assert.equal(session._screencastPort, null);
    assert.deepEqual(captured.startScreencastCalls, [{ panelId: 'panel-screencast-hide-race' }]);
    assert.ok(captured.stopScreencastCalls.length >= 1);
    assert.equal(posted.some((msg) => msg && msg.type === 'chromeReady'), false);
  } finally {
    cleanup();
  }
});

test('_startChromeDirect refreshes the screencast target when Chrome is already running', async () => {
  const { session, cleanup, captured } = buildSession({
    chrome: {
      ensureChrome: async (_panelId, options) => ({ port: options.port, status: 'existing' }),
    },
  });
  try {
    session._panelId = 'panel-refresh-1';
    session._chromePort = 53333;
    session._chromePortReservation = 53333;
    await session._startChromeDirect();
    assert.deepEqual(captured.ensureChromeCalls, [{ panelId: 'panel-refresh-1', options: { port: 53333 } }]);
    assert.deepEqual(captured.startScreencastCalls, [{ panelId: 'panel-refresh-1' }]);
  } finally {
    cleanup();
  }
});

test('_handleMcpToolCompletion syncs the browser binding from chrome page-management results', async () => {
  const manifest = {
    runId: 'browser-binding-sync',
    panelId: 'panel-sync-1',
    chromeDebugPort: 45555,
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: {} },
    agents: {},
  };
  const { session, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      syncPanelPageTarget: async () => ({
        status: 'switched',
        targetId: 'target-settings',
        targetUrl: 'https://app.qapanda.localhost/app/settings',
      }),
      getChromeDebugState: () => ({
        panelId: 'panel-sync-1',
        reservedPort: 45555,
        pendingEnsure: false,
        instance: {
          boundTargetId: 'target-settings',
          boundTargetUrl: 'https://app.qapanda.localhost/app/settings',
          boundBy: 'mcp:select_page',
          boundPageNumber: 8,
        },
      }),
    },
  });
  try {
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = 'panel-sync-1';
    session._chromePortReservation = 45555;
    await session._handleMcpToolCompletion({
      serverName: 'chrome_devtools',
      toolName: 'select_page',
      output: {
        content: [{
          type: 'text',
          text: '## Pages\n1: https://app.qapanda.localhost/app\n2: https://app.qapanda.localhost/app/projects\n8: https://app.qapanda.localhost/app/settings [selected]',
        }],
      },
    });

    assert.deepEqual(captured.syncPanelPageTargetCalls, [{
      panelId: 'panel-sync-1',
      selection: {
        pageNumber: 8,
        expectedUrl: 'https://app.qapanda.localhost/app/settings',
        reason: 'mcp:select_page',
      },
    }]);
    assert.equal(session._activeManifest.chromePageBinding.targetId, 'target-settings');
    assert.equal(session._activeManifest.chromePageBinding.url, 'https://app.qapanda.localhost/app/settings');
    assert.equal(captured.saveManifestCalls.length, 1);
  } finally {
    cleanup();
  }
});

test('_handleMcpToolCompletion collapses extra tabs after new_page and keeps the selected target', async () => {
  const manifest = {
    runId: 'browser-new-page-collapse',
    panelId: 'panel-new-page-1',
    chromeDebugPort: 45555,
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: {} },
    agents: {},
  };
  const { session, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      syncPanelPageTarget: async () => ({
        status: 'switched',
        targetId: 'target-new',
        targetUrl: 'https://app.qapanda.localhost/app/pricing',
      }),
      collapsePanelToSinglePage: async () => ({
        status: 'collapsed',
        targetId: 'target-new',
        targetUrl: 'https://app.qapanda.localhost/app/pricing',
      }),
      getChromeDebugState: () => ({
        panelId: 'panel-new-page-1',
        reservedPort: 45555,
        pendingEnsure: false,
        instance: {
          boundTargetId: 'target-new',
          boundTargetUrl: 'https://app.qapanda.localhost/app/pricing',
          boundBy: 'mcp:new_page',
          boundPageNumber: 2,
        },
      }),
    },
  });
  try {
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = 'panel-new-page-1';
    session._chromePortReservation = 45555;
    await session._handleMcpToolCompletion({
      serverName: 'chrome_devtools',
      toolName: 'new_page',
      output: {
        content: [{
          type: 'text',
          text: '## Pages\n1: https://www.google.com/\n2: https://app.qapanda.localhost/app/pricing [selected]',
        }],
      },
    });

    assert.deepEqual(captured.syncPanelPageTargetCalls, [{
      panelId: 'panel-new-page-1',
      selection: {
        pageNumber: 2,
        expectedUrl: 'https://app.qapanda.localhost/app/pricing',
        reason: 'mcp:new_page',
      },
    }]);
    assert.deepEqual(captured.collapsePanelToSinglePageCalls, [{
      panelId: 'panel-new-page-1',
      options: {
        keepTargetId: 'target-new',
        reason: 'mcp:new_page',
        reconnect: true,
      },
    }]);
    assert.equal(captured.saveManifestCalls.length, 1);
    assert.equal(session._activeManifest.chromePageBinding.targetId, 'target-new');
  } finally {
    cleanup();
  }
});

test('_handleMcpToolCompletion does not collapse tabs when new_page target resolution fails', async () => {
  const manifest = {
    runId: 'browser-new-page-no-collapse',
    panelId: 'panel-new-page-2',
    chromeDebugPort: 45555,
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: {} },
    agents: {},
  };
  const { session, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      syncPanelPageTarget: async () => ({ status: 'ambiguous-url' }),
    },
  });
  try {
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = 'panel-new-page-2';
    session._chromePortReservation = 45555;
    await session._handleMcpToolCompletion({
      serverName: 'chrome_devtools',
      toolName: 'new_page',
      output: {
        content: [{
          type: 'text',
          text: '## Pages\n1: https://app.qapanda.localhost/app\n2: https://app.qapanda.localhost/app/pricing [selected]',
        }],
      },
    });

    assert.equal(captured.collapsePanelToSinglePageCalls.length, 0);
    assert.equal(captured.saveManifestCalls.length, 0);
  } finally {
    cleanup();
  }
});

test('_handleMcpToolCompletion syncs and collapses to the live page from chrome snapshot output', async () => {
  const manifest = {
    runId: 'browser-snapshot-sync',
    panelId: 'panel-snapshot-1',
    chromeDebugPort: 45555,
    controller: { model: null, config: [], cli: 'codex' },
    worker: { model: null, cli: 'codex', agentSessions: {} },
    agents: {},
  };
  const { session, cleanup, captured } = buildSession({
    runExists: true,
    manifest,
    chrome: {
      syncPanelPageTarget: async () => ({
        status: 'switched',
        targetId: 'target-app',
        targetUrl: 'http://localhost:8001/',
      }),
      collapsePanelToSinglePage: async () => ({
        status: 'collapsed',
        targetId: 'target-app',
        targetUrl: 'http://localhost:8001/',
      }),
      getChromeDebugState: () => ({
        panelId: 'panel-snapshot-1',
        reservedPort: 45555,
        pendingEnsure: false,
        instance: {
          boundTargetId: 'target-app',
          boundTargetUrl: 'http://localhost:8001/',
          boundBy: 'mcp:wait_for:current-page',
          boundPageNumber: 1,
        },
      }),
    },
  });
  try {
    session._activeManifest = JSON.parse(JSON.stringify(manifest));
    session._panelId = 'panel-snapshot-1';
    session._chromePortReservation = 45555;
    await session._handleMcpToolCompletion({
      serverName: 'chrome_devtools',
      toolName: 'wait_for',
      output: {
        content: [{
          type: 'text',
          text: [
            'Element found.',
            '## Latest page snapshot',
            'uid=1_0 RootWebArea "BacktestLoop Dashboard" url="http://localhost:8001/"',
          ].join('\n'),
        }],
      },
    });

    assert.deepEqual(captured.syncPanelPageTargetCalls, [{
      panelId: 'panel-snapshot-1',
      selection: {
        pageNumber: null,
        expectedUrl: 'http://localhost:8001/',
        reason: 'mcp:wait_for',
      },
    }]);
    assert.deepEqual(captured.collapsePanelToSinglePageCalls, [{
      panelId: 'panel-snapshot-1',
      options: {
        keepTargetId: 'target-app',
        reason: 'mcp:wait_for:current-page',
        reconnect: true,
      },
    }]);
    assert.equal(session._activeManifest.chromePageBinding.targetId, 'target-app');
    assert.equal(session._activeManifest.chromePageBinding.url, 'http://localhost:8001/');
    assert.equal(captured.saveManifestCalls.length, 1);
  } finally {
    cleanup();
  }
});

test('prestart on an unattached panel does not reserve or start Chrome just because a browser-capable agent exists', async () => {
  const { session, cleanup, captured } = buildSession({
    config: { chatTarget: 'agent-QA-Browser' },
    appServer: {
      prestartConnection: async () => ({ isConnected: true }),
    },
  });
  try {
    session.setAgents({
      system: {
        'QA-Browser': {
          name: 'QA Engineer (Browser)',
          cli: 'codex',
          enabled: true,
          mcps: { 'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp'] } },
        },
        dev: {
          name: 'Developer',
          cli: 'codex',
          enabled: true,
        },
      },
      global: {},
      project: {},
    });

    session.prestart();
    await session._prestartPromise;

    assert.equal(captured.reserveChromePortCalls.length, 0);
    assert.equal(captured.ensureChromeCalls.length, 0);
    assert.ok(captured.prestartConnectionCalls.length >= 1, 'should still prestart app-server connections');
    for (const call of captured.prestartConnectionCalls) {
      assert.ok(!call.mcpKeys.some((name) => name.includes('chrome-devtools') || name.includes('chrome_devtools')));
      assert.equal(call.manifest.chromeDebugPort, null);
    }
  } finally {
    cleanup();
  }
});

test('/compact compacts the current API agent session locally', async () => {
  let captured = null;
  require.cache[sessionCompactionPath] = {
    id: sessionCompactionPath,
    filename: sessionCompactionPath,
    loaded: true,
    exports: {
      ...origSessionCompaction,
      compactCurrentSession: async (opts) => {
        captured = opts;
        return { performed: true, message: 'Current agent session compacted successfully.' };
      },
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
    session.setAgents({ system: { 'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'api', enabled: true } }, global: {}, project: {} });
    await session.reattachRun('existing-run-42');
    await session.handleMessage({ type: 'userInput', text: '/compact' });
    assert.ok(captured, 'should invoke local compaction');
    assert.equal(captured.chatTarget, 'agent-QA-Browser');
    assert.equal(captured.workerCli, 'api');
    assert.equal(captured.manifest.runId, 'existing-run-42');
    assert.ok(
      posted.some((msg) =>
        msg.type === 'running' &&
        msg.value === true &&
        msg.showStop === false &&
        msg.statusKind === 'compaction' &&
        msg.statusText === 'Compacting chat context...'
      ),
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

test('/compact reports an explicit unsupported banner for plain Codex exec targets', async () => {
  let called = false;
  require.cache[sessionCompactionPath] = {
    id: sessionCompactionPath,
    filename: sessionCompactionPath,
    loaded: true,
    exports: {
      ...origSessionCompaction,
      compactCurrentSession: async () => {
        called = true;
        return {
          performed: false,
          message: 'Manual compact is not supported by the current Codex exec backend. Use Codex app-server or wait for auto-compaction.',
        };
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
    assert.equal(called, true, 'should route through the shared compaction dispatcher');
    const bannerCall = session._renderer.__calls.find((call) =>
      call.method === 'banner' && /not supported by the current Codex exec backend/i.test(call.args[0])
    );
    assert.ok(bannerCall, 'should show an explicit unsupported-backend banner');
  } finally {
    cleanup();
  }
});

test('/compact surfaces a failure banner when compaction throws', async () => {
  require.cache[sessionCompactionPath] = {
    id: sessionCompactionPath,
    filename: sessionCompactionPath,
    loaded: true,
    exports: {
      ...origSessionCompaction,
      compactCurrentSession: async () => {
        throw new Error('thread not found');
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
    const bannerCall = session._renderer.__calls.find((call) =>
      call.method === 'banner' && /Compaction failed: thread not found/i.test(call.args[0])
    );
    assert.ok(bannerCall, 'should show a failure banner when compaction throws');
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
    const screenshots = hist.messages.filter(m => m.type === 'chatScreenshot');
    assert.equal(screenshots.length, 2);
    assert.ok(screenshots.some((message) => message.alt === 'Tool screenshot'));
    assert.ok(screenshots.some((message) => message.alt === 'Browser screenshot'));
  } finally {
    cleanup();
  }
});

test('sendTranscript restores only the latest visible transcript tail for large runs', async () => {
  const transcriptLines = [];
  for (let index = 0; index < 120; index += 1) {
    transcriptLines.push({
      v: 2,
      ts: `2025-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      kind: 'assistant_message',
      sessionKey: 'worker:agent:dev',
      backend: 'worker:api',
      requestId: 'req-0001',
      loopIndex: 1,
      agentId: 'dev',
      text: `entry-${index} ` + 'x'.repeat(700),
      payload: { role: 'assistant', content: `entry-${index} ` + 'x'.repeat(700) },
    });
  }

  const { session, posted, cleanup } = buildTranscriptSession(transcriptLines, {
    worker: {
      model: null,
      cli: 'api',
      agentSessions: { dev: { hasStarted: true } },
    },
    agents: {
      dev: { name: 'Developer', cli: 'api' },
    },
  });

  try {
    await session.reattachRun('transcript-run');
    posted.length = 0;
    await session.sendTranscript();
    const hist = posted.find(m => m.type === 'transcriptHistory');
    assert.ok(hist, 'should post transcriptHistory');
    assert.equal(hist.messages[0].type, 'banner');
    assert.match(hist.messages[0].text, /latest chat tail/i);
    assert.ok(hist.messages.some((m) => m.type === 'claude' && m.text.includes('entry-119')));
    assert.ok(!hist.messages.some((m) => m.type === 'claude' && m.text.includes('entry-0 ')));
    assert.ok(hist.messages.length < transcriptLines.length);
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
    assert.deepEqual(hist.messages[1], { type: 'claude', text: 'World', label: 'Worker (Codex)' });
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
    assert.deepEqual(hist.messages[1], { type: 'claude', text: 'Second', label: 'Worker (Codex)' });
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
