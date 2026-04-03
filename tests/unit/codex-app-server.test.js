const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CodexAppServerConnection } = require('../../src/codex-app-server');

describe('CodexAppServerConnection.startTurn', () => {
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
});
