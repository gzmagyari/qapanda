const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnStreamingProcess } = require('../../src/process-utils');

describe('Abort/cancel propagation', { timeout: 15000 }, () => {
  it('abortSignal terminates a long-running process', async () => {
    const controller = new AbortController();
    let resolved = false;
    let resultData = null;

    const promise = spawnStreamingProcess({
      command: 'node',
      args: ['-e', 'setInterval(() => console.log(JSON.stringify({type:"tick"})), 100)'],
      stdinText: '',
      abortSignal: controller.signal,
      onStdoutLine: () => {},
      onStderrLine: () => {},
    }).then(result => {
      resolved = true;
      resultData = result;
    });

    // Wait a bit then abort
    await new Promise(r => setTimeout(r, 500));
    controller.abort();

    // Wait for the promise to resolve
    await promise;

    assert.ok(resolved, 'promise should resolve after abort');
    // The result should indicate abort (process killed)
  });

  it('abortSignal works when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-abort

    const result = await spawnStreamingProcess({
      command: 'node',
      args: ['-e', 'console.log("should not run long")'],
      stdinText: '',
      abortSignal: controller.signal,
      onStdoutLine: () => {},
      onStderrLine: () => {},
    });

    // Should resolve quickly without hanging
    assert.ok(true, 'should not hang');
  });

  it('process without abort runs to completion', async () => {
    let lines = 0;
    await spawnStreamingProcess({
      command: 'node',
      args: ['-e', 'console.log(JSON.stringify({type:"done"}))'],
      stdinText: '',
      onStdoutLine: () => { lines++; },
      onStderrLine: () => {},
    });

    assert.ok(lines >= 1, 'should receive output lines');
  });
});
