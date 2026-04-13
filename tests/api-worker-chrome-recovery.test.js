const test = require('node:test');
const assert = require('node:assert/strict');

const {
  probeChromeDebugPort,
  recoverChromeDevtoolsSession,
} = require('../src/api-worker');

test('probeChromeDebugPort reports alive when /json/version responds', async () => {
  const result = await probeChromeDebugPort(38741, {
    httpGet: async (url) => ({ ok: true, url }),
  });
  assert.equal(result.alive, true);
  assert.equal(result.port, 38741);
  assert.deepEqual(result.version, { ok: true, url: 'http://127.0.0.1:38741/json/version' });
});

test('recoverChromeDevtoolsSession reconnects only when the bound port is still alive', async () => {
  const manifest = {
    chromeDebugPort: 38741,
    chromeOwnerPanelId: 'cli-run-1',
    worker: { boundBrowserPort: 38741 },
  };
  const agentSession = { boundBrowserPort: 38741 };
  let ensureChromeCalled = false;
  let killChromeCalled = false;

  const result = await recoverChromeDevtoolsSession(manifest, agentSession, {
    toolName: 'navigate_page',
    httpGet: async () => ({ Browser: 'Chrome/1.0' }),
    chromeManager: {
      killChrome() {
        killChromeCalled = true;
      },
      async ensureChrome() {
        ensureChromeCalled = true;
        return { port: 38741 };
      },
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(result.action, 'reconnect-client');
  assert.equal(killChromeCalled, false);
  assert.equal(ensureChromeCalled, false);
  assert.equal(manifest.chromeDebugPort, 38741);
  assert.equal(agentSession.boundBrowserPort, 38741);
});

test('recoverChromeDevtoolsSession restarts Chrome on the same port when the port is dead', async () => {
  const manifest = {
    chromeDebugPort: 38741,
    chromeOwnerPanelId: 'cli-run-2',
    worker: { boundBrowserPort: 38741 },
  };
  const agentSession = { boundBrowserPort: 38741 };
  const calls = [];

  const result = await recoverChromeDevtoolsSession(manifest, agentSession, {
    toolName: 'take_snapshot',
    httpGet: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    chromeManager: {
      killChrome(panelId) {
        calls.push({ type: 'killChrome', panelId });
      },
      async ensureChrome(panelId, options) {
        calls.push({ type: 'ensureChrome', panelId, options });
        return { port: 38741 };
      },
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(result.action, 'restart-browser');
  assert.deepEqual(calls, [
    { type: 'killChrome', panelId: 'cli-run-2' },
    { type: 'ensureChrome', panelId: 'cli-run-2', options: { port: 38741 } },
  ]);
  assert.equal(manifest.chromeDebugPort, 38741);
  assert.equal(manifest.worker.boundBrowserPort, 38741);
  assert.equal(agentSession.boundBrowserPort, 38741);
});

test('recoverChromeDevtoolsSession does not invent a new port when there is no owner panel', async () => {
  const manifest = {
    chromeDebugPort: 38741,
    chromeOwnerPanelId: null,
    worker: { boundBrowserPort: 38741 },
  };
  const agentSession = { boundBrowserPort: 38741 };
  let ensureChromeCalled = false;

  const result = await recoverChromeDevtoolsSession(manifest, agentSession, {
    toolName: 'navigate_page',
    httpGet: async () => {
      throw new Error('connect ECONNREFUSED');
    },
    chromeManager: {
      async ensureChrome() {
        ensureChromeCalled = true;
        return { port: 49999 };
      },
    },
  });

  assert.equal(result.recovered, false);
  assert.equal(result.action, 'missing-owner-panel');
  assert.equal(ensureChromeCalled, false);
  assert.equal(manifest.chromeDebugPort, 38741);
  assert.equal(agentSession.boundBrowserPort, 38741);
});
