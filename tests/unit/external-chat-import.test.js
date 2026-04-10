const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir } = require('../helpers/test-utils');
const { discoverExternalChatSessions } = require('../../src/external-chat-discovery');
const { importExternalChatSession } = require('../../src/external-chat-import');
const { readTranscriptEntriesSync, buildTranscriptDisplayMessages } = require('../../src/transcript');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function codexSessionText(repoRoot, sessionId, text = 'Imported Codex request') {
  return [
    JSON.stringify({
      timestamp: '2026-04-09T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-04-09T12:00:00.000Z',
        cwd: repoRoot,
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-09T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-04-09T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Imported Codex answer' }],
      },
    }),
    '',
  ].join('\n');
}

function claudeSessionText(repoRoot, sessionId, text = 'Imported Claude request') {
  return [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      uuid: 'user-1',
      timestamp: '2026-04-09T12:10:00.000Z',
      cwd: repoRoot,
      sessionId,
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Imported Claude answer' }],
      },
      uuid: 'assistant-1',
      timestamp: '2026-04-09T12:10:01.000Z',
      cwd: repoRoot,
      sessionId,
    }),
    '',
  ].join('\n');
}

test('discoverExternalChatSessions returns repo-matching Codex and Claude sessions only', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const otherRepo = path.join(tmp.root, 'other-repo');
  fs.mkdirSync(otherRepo, { recursive: true });

  try {
    writeText(
      path.join(homeDir, '.codex', 'sessions', '2026', '04', '09', 'rollout-2026-04-09T12-00-00-11111111-1111-1111-1111-111111111111.jsonl'),
      codexSessionText(tmp.root, '11111111-1111-1111-1111-111111111111'),
    );
    writeText(
      path.join(homeDir, '.codex', 'archived_sessions', 'rollout-2026-04-09T12-00-00-22222222-2222-2222-2222-222222222222.jsonl'),
      codexSessionText(otherRepo, '22222222-2222-2222-2222-222222222222', 'Wrong repo'),
    );
    writeText(
      path.join(homeDir, '.claude', 'projects', 'repo-a', '33333333-3333-3333-3333-333333333333.jsonl'),
      claudeSessionText(tmp.root, '33333333-3333-3333-3333-333333333333'),
    );
    writeText(
      path.join(homeDir, '.claude', 'projects', 'repo-b', '44444444-4444-4444-4444-444444444444.jsonl'),
      claudeSessionText(otherRepo, '44444444-4444-4444-4444-444444444444', 'Wrong repo'),
    );

    const sessions = await discoverExternalChatSessions({
      repoRoot: tmp.root,
      homeDir,
      limit: 10,
    });

    assert.equal(sessions.length, 2);
    assert.deepEqual(
      sessions.map((entry) => entry.provider).sort(),
      ['claude', 'codex'],
    );
    assert.ok(sessions.every((entry) => path.resolve(entry.cwd) === path.resolve(tmp.root)));
  } finally {
    tmp.cleanup();
  }
});

test('importExternalChatSession writes a new Codex-backed run with import metadata and seeded controller state', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  try {
    writeText(
      path.join(homeDir, '.codex', 'sessions', '2026', '04', '09', `rollout-2026-04-09T12-00-00-${sessionId}.jsonl`),
      codexSessionText(tmp.root, sessionId),
    );

    const { manifest } = await importExternalChatSession({
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      homeDir,
      provider: 'codex',
      sessionId,
      runOptions: {
        repoRoot: tmp.root,
        stateRoot: tmp.ccDir,
      },
    });

    assert.equal(manifest.importSource.provider, 'codex');
    assert.equal(manifest.importSource.sessionId, sessionId);
    assert.equal(path.resolve(manifest.repoRoot), path.resolve(tmp.root));
    assert.equal(manifest.chatTarget, 'controller');
    assert.equal(manifest.controller.sessionId, sessionId);
    assert.equal(manifest.controller.appServerThreadId, sessionId);
    assert.ok(manifest.controller.lastSeenTranscriptLine > 0);
    assert.ok(manifest.controller.lastSeenChatLine > 0);
    assert.ok(fs.existsSync(manifest.files.chatLog));
    assert.ok(fs.existsSync(manifest.files.transcript));

    const transcriptEntries = readTranscriptEntriesSync(manifest.files.transcript);
    const displayMessages = buildTranscriptDisplayMessages(transcriptEntries, manifest);
    assert.ok(displayMessages.some((entry) => entry.type === 'banner' && /Imported Codex session/.test(entry.text)));
    assert.ok(displayMessages.some((entry) => entry.type === 'user' && /Imported Codex request/.test(entry.text)));
    assert.ok(displayMessages.some((entry) => entry.type === 'claude' && /Imported Codex answer/.test(entry.text)));
  } finally {
    tmp.cleanup();
  }
});

test('importExternalChatSession writes a new Claude-backed run and leaves continuation state fresh', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  try {
    writeText(
      path.join(homeDir, '.claude', 'projects', 'repo-a', `${sessionId}.jsonl`),
      claudeSessionText(tmp.root, sessionId),
    );

    const { manifest } = await importExternalChatSession({
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      homeDir,
      provider: 'claude',
      sessionId,
      runOptions: {
        repoRoot: tmp.root,
        stateRoot: tmp.ccDir,
      },
    });

    assert.equal(manifest.importSource.provider, 'claude');
    assert.equal(manifest.chatTarget, 'claude');
    assert.equal(manifest.worker.cli, 'claude');
    assert.equal(manifest.worker.hasStarted, false);
    assert.equal(manifest.worker.lastSeenTranscriptLine, 0);
    assert.equal(manifest.worker.lastSeenChatLine, 0);
    assert.equal(manifest.controller.sessionId, null);

    const transcriptEntries = readTranscriptEntriesSync(manifest.files.transcript);
    const displayMessages = buildTranscriptDisplayMessages(transcriptEntries, manifest);
    assert.ok(displayMessages.some((entry) => entry.type === 'user' && /Imported Claude request/.test(entry.text)));
    assert.ok(displayMessages.some((entry) => entry.type === 'claude' && /Imported Claude answer/.test(entry.text)));
  } finally {
    tmp.cleanup();
  }
});
