const test = require('node:test');
const assert = require('node:assert/strict');

const appServer = require('../../src/codex-app-server');

const originalConnect = appServer.CodexAppServerConnection.prototype.connect;
const originalDisconnect = appServer.CodexAppServerConnection.prototype.disconnect;

test.beforeEach(async () => {
  appServer.CodexAppServerConnection.prototype.connect = async function connectStub() {
    this._proc = { killed: false };
    this._initialized = true;
  };
  appServer.CodexAppServerConnection.prototype.disconnect = async function disconnectStub() {
    this._proc = null;
    this._initialized = false;
  };
  await appServer.closeAllConnections();
});

test.after(async () => {
  appServer.CodexAppServerConnection.prototype.connect = originalConnect;
  appServer.CodexAppServerConnection.prototype.disconnect = originalDisconnect;
  await appServer.closeAllConnections();
});

test('panel-scoped prestart keys are adopted only for the matching prestart key', async () => {
  const mcpServers = {
    'chrome-devtools': {
      command: 'node',
      args: ['bridge.js', '--port', '{CHROME_DEBUG_PORT}'],
    },
  };

  const prestarted = await appServer.prestartConnection({
    key: 'panel:panel-1:worker:9222',
    bin: 'codex',
    cwd: '/tmp/repo',
    mcpServers,
    manifest: {
      panelId: 'panel-1',
      repoRoot: '/tmp/repo',
      chromeDebugPort: 9222,
    },
  });

  const adopted = appServer.getOrCreateConnection({
    runId: 'run-1-worker-dev',
    panelId: 'panel-1',
    repoRoot: '/tmp/repo',
    chromeDebugPort: 9222,
    controllerMcpServers: mcpServers,
    controller: { bin: 'codex', model: null },
    prestartKeys: ['panel:panel-1:worker:9222'],
  });

  assert.strictEqual(adopted, prestarted);
});

test('browser-capable connection fingerprint includes the resolved chrome debug port', async () => {
  const mcpServers = {
    'chrome-devtools': {
      command: 'node',
      args: ['bridge.js', '--port', '{CHROME_DEBUG_PORT}'],
    },
  };

  const prestarted = await appServer.prestartConnection({
    key: 'panel:panel-1:worker:9222',
    bin: 'codex',
    cwd: '/tmp/repo',
    mcpServers,
    manifest: {
      panelId: 'panel-1',
      repoRoot: '/tmp/repo',
      chromeDebugPort: 9222,
    },
  });

  const fresh = appServer.getOrCreateConnection({
    runId: 'run-2-worker-dev',
    panelId: 'panel-1',
    repoRoot: '/tmp/repo',
    chromeDebugPort: 9333,
    controllerMcpServers: mcpServers,
    controller: { bin: 'codex', model: null },
    prestartKeys: ['panel:panel-1:worker:9222'],
  });

  assert.notStrictEqual(fresh, prestarted);
});
