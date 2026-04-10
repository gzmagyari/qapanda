const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { createTempDir } = require('../helpers/test-utils');
const { stripAnsi, BIN, PROJECT_ROOT } = require('../helpers/cli-runner');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runCli(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile('node', [BIN, ...args], {
      cwd: cwd || PROJECT_ROOT,
      env: { ...process.env, ...(env || {}) },
      timeout: 20000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code || err.status || 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

test('qapanda import-chat imports the latest matching Codex session', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  try {
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
            content: [{ type: 'input_text', text: 'Imported from CLI test' }],
          },
        }),
        '',
      ].join('\n'),
    );

    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
    };
    const result = await runCli([
      'import-chat',
      '--repo',
      tmp.root,
      '--provider',
      'codex',
      '--latest',
    ], { cwd: tmp.root, env });

    assert.equal(result.code, 0, stripAnsi(result.stderr));
    assert.match(stripAnsi(result.stdout), /Imported codex session/);
    const runsRoot = path.join(tmp.ccDir, 'runs');
    const runDirs = fs.readdirSync(runsRoot);
    assert.equal(runDirs.length, 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(runsRoot, runDirs[0], 'manifest.json'), 'utf8'));
    assert.equal(manifest.importSource.provider, 'codex');
    assert.equal(manifest.importSource.sessionId, sessionId);
  } finally {
    tmp.cleanup();
  }
});

test('qapanda import-chat --query lists matching chats without importing', async () => {
  const tmp = createTempDir();
  const homeDir = path.join(tmp.root, 'home');
  const sessionId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

  try {
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
            content: [{ type: 'input_text', text: 'Need to inspect the login bug carefully' }],
          },
        }),
        '',
      ].join('\n'),
    );

    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
    };
    const result = await runCli([
      'import-chat',
      '--repo',
      tmp.root,
      '--provider',
      'codex',
      '--query',
      'LOGIN BUG',
    ], { cwd: tmp.root, env });

    assert.equal(result.code, 0, stripAnsi(result.stderr));
    assert.match(stripAnsi(result.stdout), /Matching chats for "LOGIN BUG":/);
    assert.match(stripAnsi(result.stdout), /Match: .*login bug/i);
    const runsRoot = path.join(tmp.ccDir, 'runs');
    assert.equal(fs.existsSync(runsRoot), false, 'query mode should not import a run');
  } finally {
    tmp.cleanup();
  }
});

test('qapanda import-chat rejects --query combined with --latest', async () => {
  const tmp = createTempDir();

  try {
    const result = await runCli([
      'import-chat',
      '--repo',
      tmp.root,
      '--provider',
      'codex',
      '--query',
      'login',
      '--latest',
    ], { cwd: tmp.root });

    assert.equal(result.code, 2);
    assert.match(stripAnsi(result.stderr), /--query cannot be combined with --latest or --session-id/i);
  } finally {
    tmp.cleanup();
  }
});
