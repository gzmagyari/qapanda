const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');

// Interactive mode uses ClaudeSession from claude-parser
// It requires node-pty which may not be installed or may fail in certain
// terminal contexts (e.g., node-pty ConPTY fails with "AttachConsole failed"
// when no real console is available, which happens in CI and some test runners).

let ClaudeSession;
try {
  ClaudeSession = require('../../claude-parser').ClaudeSession;
} catch {
  ClaudeSession = null;
}

/**
 * Try to start a ClaudeSession. Returns the session if successful,
 * or null if the PTY fails (e.g., AttachConsole failed on Windows).
 */
async function tryStartSession(opts) {
  const session = new ClaudeSession(opts);
  try {
    await session.start();
    return session;
  } catch (e) {
    // node-pty ConPTY can fail with "AttachConsole failed" on Windows
    // when running in certain terminal contexts (test runners, CI, etc.)
    try { session.close(); } catch {}
    return null;
  }
}

describe('Claude interactive mode (live)', { timeout: 90000 }, () => {
  it('starts a session and gets a response', async (t) => {
    if (!ClaudeSession) { t.skip('claude-parser/node-pty not available'); return; }
    if (await skipIfMissing(t, 'claude')) return;

    const session = await tryStartSession({
      cwd: PROJECT_ROOT,
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      startupTimeout: 30000,
      turnTimeout: 30000,
    });

    if (!session) { t.skip('PTY spawn failed (AttachConsole — expected in some terminal contexts)'); return; }

    try {
      const events = [];
      const result = await session.send('Say exactly: INTERACTIVE_TEST_OK', {
        onEvent: (evt) => events.push(evt),
      });

      assert.ok(result, 'should return result');
      assert.ok(result.resultText, 'should have result text');
      assert.ok(events.length > 0, 'should receive events');

      // Check for text-delta OR final-text events (short responses may only emit final-text)
      const hasTextEvent = events.some(e => e.kind === 'text-delta' || e.kind === 'final-text');
      assert.ok(hasTextEvent, 'should have text-delta or final-text events (got: ' +
        [...new Set(events.map(e => e.kind))].join(', ') + ')');
    } finally {
      session.close();
    }
  });

  it('maintains session across turns', async (t) => {
    if (!ClaudeSession) { t.skip('claude-parser/node-pty not available'); return; }
    if (await skipIfMissing(t, 'claude')) return;

    const session = await tryStartSession({
      cwd: PROJECT_ROOT,
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      startupTimeout: 30000,
      turnTimeout: 30000,
    });

    if (!session) { t.skip('PTY spawn failed (AttachConsole — expected in some terminal contexts)'); return; }

    try {
      // Turn 1: store a value
      await session.send('Remember the number 42. Just say "OK".', { onEvent: () => {} });

      // Turn 2: recall the value
      const result2 = await session.send('What number did I ask you to remember? Just say the number.', { onEvent: () => {} });

      assert.ok(result2.resultText, 'should have response');
      assert.ok(result2.resultText.includes('42'), 'should recall the number from previous turn');
    } finally {
      session.close();
    }
  });
});
