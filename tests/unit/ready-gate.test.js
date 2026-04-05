const test = require('node:test');
const assert = require('node:assert/strict');

const { createReadyGate } = require('../../extension/ready-gate');

test('createReadyGate runs only one in-flight init for the same ready session', async () => {
  let calls = 0;
  let release;
  const gate = createReadyGate(async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return async () => {};
  });

  const first = gate({ readySessionId: 'session-a' });
  const second = gate({ readySessionId: 'session-a' });
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});

test('createReadyGate replays instead of reprocessing duplicate ready messages after init', async () => {
  const processed = [];
  const replayed = [];
  const gate = createReadyGate(async (_msg, readySessionId) => {
    processed.push(readySessionId);
    return async () => {
      replayed.push(readySessionId);
    };
  });

  await gate({ readySessionId: 'session-a' });
  await gate({ readySessionId: 'session-a' });

  assert.deepEqual(processed, ['session-a']);
  assert.deepEqual(replayed, ['session-a']);
});

test('createReadyGate treats a new ready session as a fresh init', async () => {
  const processed = [];
  const gate = createReadyGate(async (_msg, readySessionId) => {
    processed.push(readySessionId);
    return async () => {};
  });

  await gate({ readySessionId: 'session-a' });
  await gate({ readySessionId: 'session-b' });

  assert.deepEqual(processed, ['session-a', 'session-b']);
});
