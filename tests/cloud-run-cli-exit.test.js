const test = require('node:test');
const assert = require('node:assert/strict');

const { forceTerminateCloudRunProcess } = require('../src/cli');

test('forceTerminateCloudRunProcess flushes stdio before exiting with the provided code', async () => {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExit = process.exit;

  const calls = [];

  process.stdout.write = ((chunk, callback) => {
    calls.push(['stdout', chunk]);
    if (typeof callback === 'function') callback();
    return true;
  });

  process.stderr.write = ((chunk, callback) => {
    calls.push(['stderr', chunk]);
    if (typeof callback === 'function') callback();
    return true;
  });

  process.exit = ((code) => {
    calls.push(['exit', code]);
  });

  try {
    forceTerminateCloudRunProcess(7);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
  }

  assert.deepEqual(calls, [
    ['stdout', ''],
    ['stderr', ''],
    ['exit', 7],
  ]);
});
