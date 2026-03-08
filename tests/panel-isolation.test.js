const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// session-manager.js lives in extension/ and requires('./src/...').
// We patch those cache entries just like session-restore.test.js does.

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);

function noopRenderer() {
  const renderer = { controllerLabel: null };
  const noop = () => {};
  for (const m of ['write', 'flushStream', 'user', 'controller', 'claude', 'shell',
    'banner', 'line', 'mdLine', 'streamMarkdown', 'launchClaude', 'stop', 'close',
    'requestStarted', 'requestFinished', 'userPrompt', 'progress']) {
    renderer[m] = noop;
  }
  return renderer;
}

function installFakes() {
  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async (runId) => `/fake/runs/${runId}`,
      loadManifestFromDir: async () => ({
        runId: 'run-1',
        controller: { model: null, config: [], cli: 'codex' },
        worker: { model: null },
      }),
      prepareNewRun: async (msg, opts) => ({
        runId: 'new-run',
        controller: { model: opts.controllerModel || null, config: opts.controllerConfig || [], cli: opts.controllerCli || 'codex' },
        worker: { model: opts.workerModel || null },
        files: {},
        status: 'running',
      }),
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
}

function restoreFakes() {
  delete require.cache[smPath];
  require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
  require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
  require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
}

function createSession(initialConfig = {}) {
  installFakes();
  const { SessionManager } = require(smPath);
  const renderer = noopRenderer();
  const posted = [];
  const session = new SessionManager(renderer, {
    repoRoot: '/tmp/fake-repo',
    stateRoot: '/tmp/fake-state',
    initialConfig,
    postMessage: (msg) => posted.push(msg),
  });
  return { session, renderer, posted };
}

// ── Multi-tab isolation tests ─────────────────────────────────────────────────

test('two panels with different configs remain independent', () => {
  try {
    installFakes();
    const { SessionManager } = require(smPath);

    const rendererA = noopRenderer();
    const postedA = [];
    const panelA = new SessionManager(rendererA, {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: { controllerCli: 'claude', workerModel: 'opus' },
      postMessage: (msg) => postedA.push(msg),
    });

    const rendererB = noopRenderer();
    const postedB = [];
    const panelB = new SessionManager(rendererB, {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: { controllerCli: 'codex', workerModel: 'sonnet' },
      postMessage: (msg) => postedB.push(msg),
    });

    // Panel A has claude controller
    const configA = panelA._getConfig();
    assert.equal(configA.controllerCli, 'claude');
    assert.equal(configA.workerModel, 'opus');

    // Panel B has codex controller
    const configB = panelB._getConfig();
    assert.equal(configB.controllerCli, 'codex');
    assert.equal(configB.workerModel, 'sonnet');

    // Renderer labels should differ
    assert.equal(rendererA.controllerLabel, 'Controller (Claude)');
    assert.equal(rendererB.controllerLabel, 'Controller (Codex)');

    panelA.dispose();
    panelB.dispose();
  } finally {
    restoreFakes();
  }
});

test('applyConfig on one panel does not affect another', () => {
  try {
    installFakes();
    const { SessionManager } = require(smPath);

    const rendererA = noopRenderer();
    const panelA = new SessionManager(rendererA, {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: { controllerCli: 'codex' },
      postMessage: () => {},
    });

    const rendererB = noopRenderer();
    const panelB = new SessionManager(rendererB, {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: { controllerCli: 'codex' },
      postMessage: () => {},
    });

    // Switch panel A to claude
    panelA.applyConfig({ controllerCli: 'claude' });

    // Panel A should be claude
    assert.equal(panelA._getConfig().controllerCli, 'claude');
    assert.equal(rendererA.controllerLabel, 'Controller (Claude)');

    // Panel B should still be codex
    assert.equal(panelB._getConfig().controllerCli, 'codex');
    assert.equal(rendererB.controllerLabel, 'Controller (Codex)');

    panelA.dispose();
    panelB.dispose();
  } finally {
    restoreFakes();
  }
});

test('panel created with empty config gets defaults', () => {
  try {
    const { session, renderer } = createSession({});
    const config = session._getConfig();
    assert.equal(config.controllerCli, 'codex');
    assert.equal(config.controllerModel, '');
    assert.equal(config.workerModel, '');
    assert.equal(config.chatTarget, 'controller');
    assert.equal(renderer.controllerLabel, 'Controller (Codex)');
    session.dispose();
  } finally {
    restoreFakes();
  }
});

test('panel restored with saved config uses that config', () => {
  try {
    // Simulates deserialize: state.config is passed as initialConfig
    const restoredConfig = {
      controllerCli: 'claude',
      workerModel: 'opus',
      controllerThinking: 'high',
      chatTarget: 'claude',
    };
    const { session, renderer } = createSession(restoredConfig);
    const config = session._getConfig();
    assert.equal(config.controllerCli, 'claude');
    assert.equal(config.workerModel, 'opus');
    assert.equal(config.chatTarget, 'claude');
    assert.equal(renderer.controllerLabel, 'Controller (Claude)');
    session.dispose();
  } finally {
    restoreFakes();
  }
});

test('configChanged updates per-panel config without shared state', () => {
  // Simulates the extension.js pattern: panelConfig is per-panel,
  // configChanged updates panelConfig via Object.assign
  try {
    installFakes();
    const { SessionManager } = require(smPath);

    // Simulate two panels each with their own panelConfig
    const panelConfigA = {};
    const panelConfigB = {};

    const sessionA = new SessionManager(noopRenderer(), {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: panelConfigA,
      postMessage: () => {},
    });

    const sessionB = new SessionManager(noopRenderer(), {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: panelConfigB,
      postMessage: () => {},
    });

    // Simulate configChanged on panel A
    const configA = { controllerCli: 'claude', workerModel: 'opus' };
    sessionA.applyConfig(configA);
    Object.assign(panelConfigA, configA);

    // panelConfigA should have the new values
    assert.equal(panelConfigA.controllerCli, 'claude');
    assert.equal(panelConfigA.workerModel, 'opus');

    // panelConfigB should be untouched
    assert.equal(panelConfigB.controllerCli, undefined);
    assert.equal(panelConfigB.workerModel, undefined);

    // Session configs are independent
    assert.equal(sessionA._getConfig().controllerCli, 'claude');
    assert.equal(sessionB._getConfig().controllerCli, 'codex');

    sessionA.dispose();
    sessionB.dispose();
  } finally {
    restoreFakes();
  }
});

test('syncConfig from SessionManager command updates panelConfig for ready replay', async () => {
  // Simulates the extension.js pattern: SessionManager commands like
  // /controller-model trigger _syncConfig() which posts syncConfig.
  // The postMessage wrapper must update panelConfig so that a subsequent
  // ready handler sends the updated config, not a stale snapshot.
  try {
    installFakes();
    const { SessionManager } = require(smPath);

    const panelConfig = {};
    const posted = [];

    // Wrap postMessage like extension.js does
    function postMessage(msg) {
      if (msg && msg.type === 'syncConfig' && msg.config) {
        Object.assign(panelConfig, msg.config);
      }
      posted.push(msg);
    }

    const session = new SessionManager(noopRenderer(), {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: panelConfig,
      postMessage,
    });

    // panelConfig starts empty (defaults)
    assert.equal(panelConfig.controllerCli, undefined);

    // Simulate /controller-model command which triggers _syncConfig
    await session.handleMessage({ type: 'userInput', text: '/controller-model gpt-5.4' });

    // _syncConfig should have posted a syncConfig message
    const sync = posted.find(m => m.type === 'syncConfig');
    assert.ok(sync, 'should post syncConfig');

    // panelConfig should now reflect the updated config
    assert.equal(panelConfig.controllerModel, 'gpt-5.4');
    assert.equal(panelConfig.controllerCli, 'codex');

    // Simulate a subsequent ready — the initConfig should use the updated panelConfig
    // (In extension.js this is: panel.webview.postMessage({ type: 'initConfig', config: panelConfig }))
    const initConfig = { type: 'initConfig', config: { ...panelConfig } };
    assert.equal(initConfig.config.controllerModel, 'gpt-5.4');

    session.dispose();
  } finally {
    restoreFakes();
  }
});

test('syncConfig from controllerCli switch updates panelConfig', async () => {
  // Switching controllerCli via applyConfig triggers _syncConfig.
  // Verify panelConfig captures the new CLI value.
  try {
    installFakes();
    const { SessionManager } = require(smPath);

    const panelConfig = { controllerCli: 'codex' };
    const posted = [];

    function postMessage(msg) {
      if (msg && msg.type === 'syncConfig' && msg.config) {
        Object.assign(panelConfig, msg.config);
      }
      posted.push(msg);
    }

    const session = new SessionManager(noopRenderer(), {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: panelConfig,
      postMessage,
    });

    // Switch to claude
    session.applyConfig({ controllerCli: 'claude' });

    // panelConfig should be updated
    assert.equal(panelConfig.controllerCli, 'claude');

    // Simulate ready replay: should get claude, not codex
    const readyConfig = { ...panelConfig };
    assert.equal(readyConfig.controllerCli, 'claude');

    session.dispose();
  } finally {
    restoreFakes();
  }
});

test('ready handler on deserialized panel sends panel-specific config', () => {
  // Simulates the deserialize flow: panelConfig comes from state.config,
  // ready handler sends initConfig with that panelConfig
  try {
    installFakes();
    const { SessionManager } = require(smPath);

    // Panel A was serialized with claude config
    const panelConfigA = { controllerCli: 'claude', workerModel: 'opus' };
    const postedA = [];
    const sessionA = new SessionManager(noopRenderer(), {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: panelConfigA,
      postMessage: (msg) => postedA.push(msg),
    });

    // Panel B was serialized with codex config
    const panelConfigB = { controllerCli: 'codex', workerModel: 'sonnet' };
    const postedB = [];
    const sessionB = new SessionManager(noopRenderer(), {
      repoRoot: '/tmp/fake-repo',
      stateRoot: '/tmp/fake-state',
      initialConfig: panelConfigB,
      postMessage: (msg) => postedB.push(msg),
    });

    // Simulate ready: extension host would send initConfig with panelConfig
    // Verify panelConfigs are distinct references with correct values
    assert.equal(panelConfigA.controllerCli, 'claude');
    assert.equal(panelConfigA.workerModel, 'opus');
    assert.equal(panelConfigB.controllerCli, 'codex');
    assert.equal(panelConfigB.workerModel, 'sonnet');

    // Session configs reflect their respective initialConfigs
    assert.equal(sessionA._getConfig().controllerCli, 'claude');
    assert.equal(sessionA._getConfig().workerModel, 'opus');
    assert.equal(sessionB._getConfig().controllerCli, 'codex');
    assert.equal(sessionB._getConfig().workerModel, 'sonnet');

    sessionA.dispose();
    sessionB.dispose();
  } finally {
    restoreFakes();
  }
});
