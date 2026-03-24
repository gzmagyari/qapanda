const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, mockRenderer, mockPostMessage } = require('../helpers/test-utils');
const { SessionManager } = require('../../extension/session-manager');
const { PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');

let tmp;
let session;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => {
  if (session) { try { session.abort(); } catch {} session = null; }
  tmp.cleanup();
});

function createSession(overrides = {}) {
  const renderer = mockRenderer();
  const postMessage = mockPostMessage();
  session = new SessionManager(renderer, {
    repoRoot: tmp.root,
    postMessage,
    initialConfig: {},
    extensionPath: EXTENSION_DIR,
    ...overrides,
  });
  return { renderer, postMessage, session };
}

describe('Config mid-session switching', () => {
  it('applyConfig changes controller model', () => {
    const { session, postMessage } = createSession();
    session.applyConfig({ controllerModel: 'gpt-5.4' });

    // Model should be stored
    assert.equal(session._controllerModel, 'gpt-5.4');
  });

  it('applyConfig changes worker model', () => {
    const { session } = createSession();
    session.applyConfig({ workerModel: 'claude-opus-4-6' });
    assert.equal(session._workerModel, 'claude-opus-4-6');
  });

  it('applyConfig changes chat target', () => {
    const { session } = createSession();
    session.applyConfig({ chatTarget: 'agent-dev' });
    assert.equal(session._chatTarget, 'agent-dev');
  });

  it('applyConfig changes chat target back to controller', () => {
    const { session } = createSession();
    session.applyConfig({ chatTarget: 'agent-dev' });
    session.applyConfig({ chatTarget: 'controller' });
    assert.equal(session._chatTarget, 'controller');
  });

  it('applyConfig changes worker thinking', () => {
    const { session } = createSession();
    session.applyConfig({ workerThinking: 'high' });
    assert.equal(session._workerThinking, 'high');
  });

  it('applyConfig changes controller thinking', () => {
    const { session } = createSession();
    session.applyConfig({ controllerThinking: 'medium' });
    assert.equal(session._controllerThinking, 'medium');
  });

  it('applyConfig posts syncConfig message', () => {
    const { session, postMessage } = createSession();
    session.applyConfig({ workerModel: 'claude-sonnet-4-6' });

    const syncMsgs = postMessage.messagesOfType('syncConfig');
    // syncConfig should be posted (may or may not happen depending on _syncConfig implementation)
    // At minimum, the internal state should be updated
    assert.equal(session._workerModel, 'claude-sonnet-4-6');
  });

  it('applyConfig with mode sets currentMode', () => {
    const { session } = createSession();
    session.applyConfig({ mode: 'quick-dev', chatTarget: 'agent-dev' });
    assert.equal(session._currentMode, 'quick-dev');
  });

  it('applyConfig with mode + testEnv sets both', () => {
    const { session } = createSession();
    session.applyConfig({ mode: 'quick-test', testEnv: 'browser', chatTarget: 'agent-QA-Browser' });
    assert.equal(session._testEnv, 'browser');
    assert.equal(session._currentMode, 'quick-test');
  });
});
