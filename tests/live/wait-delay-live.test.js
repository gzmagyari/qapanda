const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, mockRenderer, mockPostMessage } = require('../helpers/test-utils');
const { SessionManager } = require('../../extension/session-manager');
const { EXTENSION_DIR } = require('../helpers/live-test-utils');

let tmp;
let session;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => {
  if (session) {
    try { session._clearWaitTimer && session._clearWaitTimer(); } catch {}
    try { session.abort(); } catch {}
    session = null;
  }
  tmp.cleanup();
});

function createSession() {
  const renderer = mockRenderer();
  const postMessage = mockPostMessage();
  session = new SessionManager(renderer, {
    repoRoot: tmp.root,
    postMessage,
    initialConfig: {},
    extensionPath: EXTENSION_DIR,
  });
  return { renderer, postMessage, session };
}

describe('Wait delay scheduling', () => {
  it('applyConfig with waitDelay stores the delay', () => {
    const { session } = createSession();
    session.applyConfig({ waitDelay: '1m' });
    assert.equal(session._waitDelay, '1m');
  });

  it('applyConfig with empty waitDelay clears the delay', () => {
    const { session } = createSession();
    session.applyConfig({ waitDelay: '5m' });
    session.applyConfig({ waitDelay: '' });
    assert.equal(session._waitDelay, '');
  });

  it('waitDelay is persisted to manifest when run is active', async () => {
    const { session } = createSession();
    const { prepareNewRun } = require('../../src/state');

    // Create a run so manifest exists
    const manifest = await prepareNewRun({
      message: 'test',
      repoRoot: tmp.root,
      stateRoot: path.join(tmp.root, '.qpanda'),
      controllerBin: 'codex',
      workerBin: 'claude',
    });
    session._activeManifest = manifest;
    session._running = false;

    session.applyConfig({ waitDelay: '5m' });
    assert.equal(session._waitDelay, '5m');
  });
});
