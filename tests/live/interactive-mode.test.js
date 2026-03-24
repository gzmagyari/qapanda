const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');

// Interactive mode uses ClaudeSession from claude-parser
// It requires node-pty which may not be installed

let ClaudeSession;
try {
  ClaudeSession = require('../../claude-parser').ClaudeSession;
} catch {
  ClaudeSession = null;
}

describe('Claude interactive mode (live)', { timeout: 90000 }, () => {
  it('starts a session and gets a response', async (t) => {
    if (!ClaudeSession) { t.skip('claude-parser/node-pty not available'); return; }
    if (await skipIfMissing(t, 'claude')) return;

    const session = new ClaudeSession({
      cwd: PROJECT_ROOT,
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      startupTimeout: 30000,
      turnTimeout: 30000,
    });

    try {
      await session.start();

      const events = [];
      const result = await session.send('Say exactly: INTERACTIVE_TEST_OK', {
        onEvent: (evt) => events.push(evt),
      });

      assert.ok(result, 'should return result');
      assert.ok(result.resultText, 'should have result text');
      assert.ok(events.length > 0, 'should receive events');

      const hasTextDelta = events.some(e => e.kind === 'text-delta');
      assert.ok(hasTextDelta, 'should have text-delta events');
    } finally {
      session.close();
    }
  });

  it('maintains session across turns', async (t) => {
    if (!ClaudeSession) { t.skip('claude-parser/node-pty not available'); return; }
    if (await skipIfMissing(t, 'claude')) return;

    const session = new ClaudeSession({
      cwd: PROJECT_ROOT,
      bin: 'claude',
      args: ['--dangerously-skip-permissions'],
      startupTimeout: 30000,
      turnTimeout: 30000,
    });

    try {
      await session.start();

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
