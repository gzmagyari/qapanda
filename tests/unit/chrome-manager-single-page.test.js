const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  attachExistingChrome,
  bindPanelToTarget,
  collapsePanelToSinglePage,
  getChromeDebugState,
  killChrome,
  setPanelPageBinding,
} = require('../../extension/chrome-manager');

function startFakeChromeServer(initialTargets) {
  let targets = initialTargets.map((target) => ({ ...target }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'FakeChrome/1.0' }));
      return;
    }
    if (url.pathname === '/json' || url.pathname === '/json/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    if (url.pathname.startsWith('/json/close/')) {
      const targetId = decodeURIComponent(url.pathname.slice('/json/close/'.length));
      targets = targets.filter((target) => target.id !== targetId);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Target is closing');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        getTargets: () => targets.map((target) => ({ ...target })),
      });
    });
  });
}

test('collapsePanelToSinglePage closes extra pages and keeps the requested target', async () => {
  const fakeChrome = await startFakeChromeServer([
    { id: 'page-1', type: 'page', url: 'https://www.google.com/', webSocketDebuggerUrl: 'ws://page-1' },
    { id: 'page-2', type: 'page', url: 'https://app.qapanda.localhost/app/settings', webSocketDebuggerUrl: 'ws://page-2' },
    { id: 'page-3', type: 'page', url: 'https://app.qapanda.localhost/app/projects', webSocketDebuggerUrl: 'ws://page-3' },
  ]);
  const panelId = 'panel-single-page-test';
  try {
    const attached = await attachExistingChrome(panelId, fakeChrome.port);
    assert.equal(attached && attached.port, fakeChrome.port);

    const collapseResult = await collapsePanelToSinglePage(panelId, {
      keepTargetId: 'page-2',
      reason: 'test-collapse',
      reconnect: false,
    });

    assert.equal(collapseResult.status, 'collapsed');
    assert.equal(collapseResult.targetId, 'page-2');
    assert.deepEqual(fakeChrome.getTargets().map((target) => target.id), ['page-2']);

    const debugState = getChromeDebugState(panelId);
    assert.equal(debugState.instance.boundTargetId, 'page-2');
    assert.equal(debugState.instance.boundTargetUrl, 'https://app.qapanda.localhost/app/settings');
    assert.equal(debugState.instance.boundBy, 'test-collapse');
  } finally {
    killChrome(panelId);
    await new Promise((resolve) => fakeChrome.server.close(resolve));
  }
});

test('bindPanelToTarget updates the exact bound target without reconnecting when reconnect=false', async () => {
  const fakeChrome = await startFakeChromeServer([
    { id: 'page-1', type: 'page', url: 'https://www.google.com/', webSocketDebuggerUrl: 'ws://page-1' },
    { id: 'page-2', type: 'page', url: 'https://app.qapanda.localhost/app/pricing', webSocketDebuggerUrl: 'ws://page-2' },
  ]);
  const panelId = 'panel-bind-target-test';
  try {
    const attached = await attachExistingChrome(panelId, fakeChrome.port);
    assert.equal(attached && attached.port, fakeChrome.port);
    setPanelPageBinding(panelId, { targetId: 'page-1', url: 'https://www.google.com/', boundBy: 'manifest', pageNumber: 1 });

    const bindResult = await bindPanelToTarget(panelId, {
      targetId: 'page-2',
      reason: 'test-bind',
      reconnect: false,
    });

    assert.equal(bindResult.status, 'bound-only');
    assert.equal(bindResult.targetId, 'page-2');
    const debugState = getChromeDebugState(panelId);
    assert.equal(debugState.instance.boundTargetId, 'page-2');
    assert.equal(debugState.instance.boundTargetUrl, 'https://app.qapanda.localhost/app/pricing');
    assert.equal(debugState.instance.currentTargetId, null);
  } finally {
    killChrome(panelId);
    await new Promise((resolve) => fakeChrome.server.close(resolve));
  }
});

test('collapsePanelToSinglePage prefers a real app page over a stale placeholder-bound Google tab', async () => {
  const fakeChrome = await startFakeChromeServer([
    { id: 'page-google', type: 'page', url: 'https://www.google.com/', webSocketDebuggerUrl: 'ws://page-google' },
    { id: 'page-app', type: 'page', url: 'http://localhost:8001/backtest/new', webSocketDebuggerUrl: 'ws://page-app' },
  ]);
  const panelId = 'panel-collapse-prefers-app';
  try {
    const attached = await attachExistingChrome(panelId, fakeChrome.port);
    assert.equal(attached && attached.port, fakeChrome.port);
    setPanelPageBinding(panelId, {
      targetId: 'page-google',
      url: 'https://www.google.com/',
      boundBy: 'manifest',
      pageNumber: 1,
    });

    const collapseResult = await collapsePanelToSinglePage(panelId, {
      reason: 'startup-test',
      reconnect: false,
    });

    assert.equal(collapseResult.status, 'collapsed');
    assert.equal(collapseResult.targetId, 'page-app');
    assert.equal(collapseResult.resolution, 'best-over-placeholder-binding');
    assert.deepEqual(fakeChrome.getTargets().map((target) => target.id), ['page-app']);
  } finally {
    killChrome(panelId);
    await new Promise((resolve) => fakeChrome.server.close(resolve));
  }
});
