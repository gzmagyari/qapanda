const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const extDir = path.join(repoRoot, 'extension');
const repoSrcDir = path.join(repoRoot, 'src');
const generatedSrcDir = path.join(extDir, 'src');
fs.mkdirSync(generatedSrcDir, { recursive: true });
fs.cpSync(repoSrcDir, generatedSrcDir, { recursive: true, force: true });

const smPath = path.join(extDir, 'session-manager.js');

const { createTempDir } = require('./helpers/test-utils');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function stubRenderer() {
  const calls = [];
  return new Proxy({ __calls: calls }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { calls.push({ method: prop, args }); };
    },
  });
}

test('session-manager /import-chat lists and imports matching Codex chats', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  delete require.cache[smPath];

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeText(
      path.join(homeDir, '.codex', 'sessions', '2026', '04', '09', `rollout-2026-04-09T12-00-00-${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-04-09T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: sessionId,
            timestamp: '2026-04-09T12:00:00.000Z',
            cwd: tmp.root,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Import this Codex chat' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Imported assistant text' }],
          },
        }),
        '',
      ].join('\n'),
    );

    const { SessionManager } = require(smPath);
    const posted = [];
    const renderer = stubRenderer();
    const session = new SessionManager(renderer, {
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      postMessage: (msg) => posted.push(msg),
      extensionPath: extDir,
    });

    try {
      await session.handleMessage({ type: 'userInput', text: '/import-chat codex' });
      const picker = posted.find((msg) => msg.type === 'importChatHistory');
      assert.ok(picker, 'should post importChatHistory');
      assert.equal(picker.sessions.length, 1);
      assert.equal(picker.sessions[0].sessionId, sessionId);

      posted.length = 0;
      await session.handleMessage({ type: 'userInput', text: `/import-chat codex ${sessionId}` });

      assert.ok(session.getRunId(), 'import should attach a run');
      assert.equal(session._activeManifest.importSource.provider, 'codex');
      assert.equal(session._activeManifest.importSource.sessionId, sessionId);
      assert.equal(session._activeManifest.controller.sessionId, sessionId);
      assert.ok(posted.some((msg) => msg.type === 'setRunId'));
      assert.ok(posted.some((msg) => msg.type === 'transcriptHistory'));
    } finally {
      session.dispose();
    }
  } finally {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    tmp.cleanup();
    delete require.cache[smPath];
  }
});

test('session-manager searchImportChats searches inside repo-matching chat messages', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  delete require.cache[smPath];

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeText(
      path.join(homeDir, '.claude', 'projects', 'repo-a', `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Critical files for implementation live under server/src and client/src.' }],
          },
          uuid: 'assistant-1',
          timestamp: '2026-04-09T12:10:01.000Z',
          cwd: tmp.root,
          sessionId,
        }),
        '',
      ].join('\n'),
    );

    const { SessionManager } = require(smPath);
    const posted = [];
    const renderer = stubRenderer();
    const session = new SessionManager(renderer, {
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      postMessage: (msg) => posted.push(msg),
      extensionPath: extDir,
    });

    try {
      await session.handleMessage({ type: 'searchImportChats', provider: 'claude', query: 'critical files', requestId: 'req-1' });
      const picker = posted.find((msg) => msg.type === 'importChatHistory');
      assert.ok(picker, 'should post importChatHistory search results');
      assert.equal(picker.provider, 'claude');
      assert.equal(picker.query, 'critical files');
      assert.equal(picker.requestId, 'req-1');
      assert.equal(picker.sessions.length, 1);
      assert.equal(picker.sessions[0].sessionId, sessionId);
      assert.match(picker.sessions[0].matchPreview, /critical files/i);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    tmp.cleanup();
    delete require.cache[smPath];
  }
});

test('session-manager preserves a Codex-backed agent target for imported Codex chats', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  delete require.cache[smPath];

  try {
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    writeText(
      path.join(homeDir, '.codex', 'sessions', '2026', '04', '09', `rollout-2026-04-09T12-00-00-${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: '2026-04-09T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: sessionId,
            timestamp: '2026-04-09T12:00:00.000Z',
            cwd: tmp.root,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Continue this as Developer' }],
          },
        }),
        '',
      ].join('\n'),
    );

    const { SessionManager } = require(smPath);
    const posted = [];
    const renderer = stubRenderer();
    const session = new SessionManager(renderer, {
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      postMessage: (msg) => posted.push(msg),
      extensionPath: extDir,
    });
    session.setAgents({
      system: {},
      global: {},
      project: {
        dev: { name: 'Developer', cli: 'codex' },
      },
    });
    session.applyConfig({ chatTarget: 'agent-dev' });

    try {
      await session.handleMessage({ type: 'userInput', text: `/import-chat codex ${sessionId}` });

      assert.ok(session.getRunId(), 'import should attach a run');
      assert.equal(session._activeManifest.chatTarget, 'agent-dev');
      assert.equal(session._hasExistingSessionForTarget('agent-dev'), true);
    } finally {
      session.dispose();
    }
  } finally {
    if (previousHome == null) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    tmp.cleanup();
    delete require.cache[smPath];
  }
});
