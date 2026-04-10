const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir } = require('../helpers/test-utils');
const { searchExternalChatSessions } = require('../../src/external-chat-search');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function codexSessionText(repoRoot, sessionId, text) {
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
    '',
  ].join('\n');
}

function claudeSessionText(repoRoot, sessionId, text) {
  return [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
      uuid: 'assistant-1',
      timestamp: '2026-04-09T12:10:01.000Z',
      cwd: repoRoot,
      sessionId,
    }),
    '',
  ].join('\n');
}

test('searchExternalChatSessions finds repo-matching Codex and Claude sessions by message content', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const otherRepo = path.join(tmp.root, 'other-repo');
  fs.mkdirSync(otherRepo, { recursive: true });

  try {
    writeText(
      path.join(homeDir, '.codex', 'sessions', '2026', '04', '09', 'codex-hit-11111111-1111-1111-1111-111111111111.jsonl'),
      codexSessionText(tmp.root, '11111111-1111-1111-1111-111111111111', 'Critical files for implementation'),
    );
    writeText(
      path.join(homeDir, '.claude', 'projects', 'repo-a', '22222222-2222-2222-2222-222222222222.jsonl'),
      claudeSessionText(tmp.root, '22222222-2222-2222-2222-222222222222', 'Need the critical files before coding'),
    );
    writeText(
      path.join(homeDir, '.codex', 'archived_sessions', 'codex-miss-33333333-3333-3333-3333-333333333333.jsonl'),
      codexSessionText(otherRepo, '33333333-3333-3333-3333-333333333333', 'Critical files elsewhere'),
    );

    const matches = await searchExternalChatSessions({
      repoRoot: tmp.root,
      homeDir,
      query: 'critical FILES',
      limit: 10,
    });

    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((entry) => entry.provider).sort(), ['claude', 'codex']);
    assert.ok(matches.every((entry) => path.resolve(entry.cwd) === path.resolve(tmp.root)));
    assert.ok(matches.every((entry) => /critical files/i.test(entry.matchPreview)));
  } finally {
    tmp.cleanup();
  }
});

test('searchExternalChatSessions returns newest-first matches with first-hit preview', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');

  try {
    const olderPath = path.join(homeDir, '.codex', 'sessions', '2026', '04', '08', 'older-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl');
    const newerPath = path.join(homeDir, '.codex', 'sessions', '2026', '04', '09', 'newer-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl');
    writeText(
      olderPath,
      codexSessionText(tmp.root, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'login bug needs triage'),
    );
    writeText(
      newerPath,
      [
        JSON.stringify({
          timestamp: '2026-04-09T12:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
            timestamp: '2026-04-09T12:00:00.000Z',
            cwd: tmp.root,
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'No match here' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-09T12:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Need to reproduce the login bug on staging' }],
          },
        }),
        '',
      ].join('\n'),
    );

    fs.utimesSync(olderPath, new Date('2026-04-08T12:00:00Z'), new Date('2026-04-08T12:00:00Z'));
    fs.utimesSync(newerPath, new Date('2026-04-09T12:00:00Z'), new Date('2026-04-09T12:00:00Z'));

    const matches = await searchExternalChatSessions({
      repoRoot: tmp.root,
      homeDir,
      provider: 'codex',
      query: 'login bug',
      limit: 10,
    });

    assert.equal(matches.length, 2);
    assert.equal(matches[0].sessionId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.equal(matches[1].sessionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.match(matches[0].matchPreview, /login bug/i);
  } finally {
    tmp.cleanup();
  }
});
