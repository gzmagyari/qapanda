const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CodexAppServerConnection } = require('../../src/codex-app-server');

describe('CodexAppServerConnection.startTurn', () => {
  it('passes approvalPolicy and sandbox through to thread/start', async () => {
    const conn = new CodexAppServerConnection({ bin: 'codex', cwd: '/test/repo' });

    let capturedMethod = null;
    let capturedParams = null;
    conn.sendRequest = async (method, params) => {
      capturedMethod = method;
      capturedParams = params;
      return { thread: { id: 'thread-456' } };
    };

    const threadId = await conn.startThread({
      cwd: '/test/repo',
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });

    assert.equal(threadId, 'thread-456');
    assert.equal(capturedMethod, 'thread/start');
    assert.equal(capturedParams.cwd, '/test/repo');
    assert.equal(capturedParams.model, 'gpt-5.4');
    assert.equal(capturedParams.approvalPolicy, 'never');
    assert.equal(capturedParams.sandbox, 'danger-full-access');
  });

  it('passes approvalPolicy and sandbox through to thread/fork', async () => {
    const conn = new CodexAppServerConnection({ bin: 'codex', cwd: '/test/repo' });

    let capturedMethod = null;
    let capturedParams = null;
    conn.sendRequest = async (method, params) => {
      capturedMethod = method;
      capturedParams = params;
      return { thread: { id: 'thread-forked' } };
    };

    const threadId = await conn.forkThread('thread-123', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });

    assert.equal(threadId, 'thread-forked');
    assert.equal(capturedMethod, 'thread/fork');
    assert.equal(capturedParams.threadId, 'thread-123');
    assert.equal(capturedParams.approvalPolicy, 'never');
    assert.equal(capturedParams.sandbox, 'danger-full-access');
  });

  it('passes approvalPolicy and sandbox through to turn/start', async () => {
    const conn = new CodexAppServerConnection({ bin: 'codex', cwd: '/test/repo' });
    conn._threadId = 'thread-123';

    let capturedMethod = null;
    let capturedParams = null;
    conn.sendRequest = async (method, params) => {
      capturedMethod = method;
      capturedParams = params;
      return { turn: { id: 'turn-456' } };
    };

    const turnId = await conn.startTurn('hello world', { type: 'object' }, {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });

    assert.equal(turnId, 'turn-456');
    assert.equal(capturedMethod, 'turn/start');
    assert.equal(capturedParams.threadId, 'thread-123');
    assert.deepEqual(capturedParams.input, [{ type: 'text', text: 'hello world' }]);
    assert.equal(capturedParams.approvalPolicy, 'never');
    assert.equal(capturedParams.sandbox, 'danger-full-access');
    assert.deepEqual(capturedParams.outputSchema, { type: 'object' });
  });

  it('defaults approvalPolicy to never when options are omitted', async () => {
    const conn = new CodexAppServerConnection({ bin: 'codex', cwd: '/test/repo' });
    conn._threadId = 'thread-123';

    let capturedParams = null;
    conn.sendRequest = async (_method, params) => {
      capturedParams = params;
      return { turn: { id: 'turn-789' } };
    };

    await conn.startTurn('ping');

    assert.equal(capturedParams.approvalPolicy, 'never');
    assert.ok(!Object.prototype.hasOwnProperty.call(capturedParams, 'sandbox'));
  });

  it('sends thread/compact/start for manual compaction', async () => {
    const conn = new CodexAppServerConnection({ bin: 'codex', cwd: '/test/repo' });
    conn._threadId = 'thread-compact-1';

    let capturedMethod = null;
    let capturedParams = null;
    conn.sendRequest = async (method, params) => {
      capturedMethod = method;
      capturedParams = params;
      return { ok: true };
    };

    const result = await conn.compactThread();

    assert.deepEqual(result, { ok: true });
    assert.equal(capturedMethod, 'thread/compact/start');
    assert.deepEqual(capturedParams, { threadId: 'thread-compact-1' });
  });
});
