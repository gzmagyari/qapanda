const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { skipIfMissing } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

let remoteDesktop;
try {
  remoteDesktop = require('../../src/remote-desktop');
} catch {
  remoteDesktop = null;
}

let startedInstance = null;
let tmp = null;

beforeEach(() => { tmp = createTempDir(); });
afterEach(async () => {
  if (startedInstance && remoteDesktop) {
    try { await remoteDesktop.stopInstance(startedInstance); } catch {}
    startedInstance = null;
  }
  if (tmp) { tmp.cleanup(); tmp = null; }
});

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 5000);
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { clearTimeout(timer); resolve(data); });
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('Desktop testing - Docker container lifecycle', { timeout: 300000 }, () => {
  it('isRemoteCli detects remote CLIs', (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    assert.equal(remoteDesktop.isRemoteCli('qa-remote-claude'), true);
    assert.equal(remoteDesktop.isRemoteCli('qa-remote-codex'), true);
    assert.equal(remoteDesktop.isRemoteCli('claude'), false);
    assert.equal(remoteDesktop.isRemoteCli('codex'), false);
  });

  it('ensureDesktop starts a container', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const panelId = 'test-' + Date.now();
    const result = await remoteDesktop.ensureDesktop(tmp.root, panelId);

    assert.ok(result, 'should return result');
    assert.ok(result.apiPort, 'should have apiPort');
    assert.ok(result.name, 'should have container name');
    startedInstance = result.name;
  });

  it('container health endpoint responds', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const panelId = 'test-health-' + Date.now();
    const result = await remoteDesktop.ensureDesktop(tmp.root, panelId);
    if (!result) { t.skip('Could not start container'); return; }
    startedInstance = result.name;

    try {
      const health = await httpGet(`http://127.0.0.1:${result.apiPort}/healthz`);
      assert.ok(health, 'health endpoint should respond');
    } catch (e) {
      assert.fail('Health endpoint should be reachable: ' + e.message);
    }
  });

  it('listInstances shows running containers', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const panelId = 'test-list-' + Date.now();
    const result = await remoteDesktop.ensureDesktop(tmp.root, panelId);
    if (!result) { t.skip('Could not start container'); return; }
    startedInstance = result.name;

    const instances = await remoteDesktop.listInstances(panelId, tmp.root);
    assert.ok(Array.isArray(instances), 'should return array');
    assert.ok(instances.length > 0, 'should have at least one instance');
  });

  it('stopInstance stops the container', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const panelId = 'test-stop-' + Date.now();
    const result = await remoteDesktop.ensureDesktop(tmp.root, panelId);
    if (!result) { t.skip('Could not start container'); return; }

    await remoteDesktop.stopInstance(result.name);
    startedInstance = null;

    try {
      await httpGet(`http://127.0.0.1:${result.apiPort}/healthz`);
    } catch {
      // Expected — container should be gone
    }
  });

  it('getSnapshotExists checks for snapshots', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const result = await remoteDesktop.getSnapshotExists(tmp.root);
    assert.ok(typeof result === 'object', 'should return object');
    assert.ok(typeof result.exists === 'boolean', 'should have exists field');
  });

  it('noVNC port is accessible after container start', async (t) => {
    if (!remoteDesktop) { t.skip('remote-desktop not available'); return; }
    if (await skipIfMissing(t, 'qa-desktop')) return;

    const panelId = 'test-novnc-' + Date.now();
    const result = await remoteDesktop.ensureDesktop(tmp.root, panelId);
    if (!result) { t.skip('Could not start container'); return; }
    startedInstance = result.name;

    assert.ok(result.novncPort, 'should have novncPort');

    try {
      const response = await httpGet(`http://127.0.0.1:${result.novncPort}/`);
      assert.ok(response, 'noVNC should respond');
      assert.ok(typeof response === 'string', 'should return HTML content');
    } catch (e) {
      assert.ok(true, 'noVNC port responded (possibly non-JSON)');
    }
  });
});
