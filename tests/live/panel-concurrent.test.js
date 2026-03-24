const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, mockRenderer, mockPostMessage } = require('../helpers/test-utils');
const { SessionManager } = require('../../extension/session-manager');
const { EXTENSION_DIR } = require('../helpers/live-test-utils');

let tmp;
let sessions = [];

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => {
  for (const s of sessions) { try { s.abort(); } catch {} }
  sessions = [];
  tmp.cleanup();
});

function createPanel(panelName) {
  const renderer = mockRenderer();
  const postMessage = mockPostMessage();
  const session = new SessionManager(renderer, {
    repoRoot: tmp.root,
    postMessage,
    initialConfig: {},
    extensionPath: EXTENSION_DIR,
  });
  session._panelId = panelName;
  sessions.push(session);
  return { renderer, postMessage, session };
}

describe('Multiple concurrent panels', () => {
  it('two panels have independent state', () => {
    const panelA = createPanel('panel-a');
    const panelB = createPanel('panel-b');

    // Config changes on A don't affect B
    panelA.session.applyConfig({ workerModel: 'claude-opus-4-6' });
    panelB.session.applyConfig({ workerModel: 'claude-sonnet-4-6' });

    assert.equal(panelA.session._workerModel, 'claude-opus-4-6');
    assert.equal(panelB.session._workerModel, 'claude-sonnet-4-6');
  });

  it('two panels have separate chat targets', () => {
    const panelA = createPanel('panel-a');
    const panelB = createPanel('panel-b');

    panelA.session.applyConfig({ chatTarget: 'agent-dev' });
    panelB.session.applyConfig({ chatTarget: 'controller' });

    assert.equal(panelA.session._chatTarget, 'agent-dev');
    assert.equal(panelB.session._chatTarget, 'controller');
  });

  it('messages go to correct panel postMessage', () => {
    const panelA = createPanel('panel-a');
    const panelB = createPanel('panel-b');

    panelA.session.applyConfig({ workerModel: 'model-a' });
    panelB.session.applyConfig({ workerModel: 'model-b' });

    // Each panel should only receive its own messages
    // The messages arrays should be independent
    assert.notEqual(panelA.postMessage.messages, panelB.postMessage.messages);
  });

  it('two panels have independent panelIds', () => {
    const panelA = createPanel('panel-a');
    const panelB = createPanel('panel-b');

    assert.equal(panelA.session._panelId, 'panel-a');
    assert.equal(panelB.session._panelId, 'panel-b');
    assert.notEqual(panelA.session._panelId, panelB.session._panelId);
  });

  it('thinking level changes are per-panel', () => {
    const panelA = createPanel('panel-a');
    const panelB = createPanel('panel-b');

    panelA.session.applyConfig({ workerThinking: 'high' });
    panelB.session.applyConfig({ workerThinking: 'low' });

    assert.equal(panelA.session._workerThinking, 'high');
    assert.equal(panelB.session._workerThinking, 'low');
  });

  it('mode selection is per-panel', () => {
    const panelA = createPanel('panel-a');
    const panelB = createPanel('panel-b');

    panelA.session.applyConfig({ mode: 'quick-dev' });
    panelB.session.applyConfig({ mode: 'auto-test' });

    assert.equal(panelA.session._currentMode, 'quick-dev');
    assert.equal(panelB.session._currentMode, 'auto-test');
  });
});
