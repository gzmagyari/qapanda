const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execForText } = require('../../src/process-utils');

describe('execForText', () => {
  it('captures stdout from a simple command', async () => {
    const result = await execForText('node', ['-e', 'console.log("hello")']);
    assert.ok(result.stdout.includes('hello'), 'should capture stdout');
    assert.equal(result.code, 0);
  });

  it('captures stderr', async () => {
    const result = await execForText('node', ['-e', 'console.error("oops")']);
    assert.ok(result.stderr.includes('oops'), 'should capture stderr');
    assert.equal(result.code, 0);
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await execForText('node', ['-e', 'process.exit(42)']);
    assert.equal(result.code, 42);
  });

  it('passes cwd option', async () => {
    const result = await execForText('node', ['-e', 'console.log(process.cwd())'], { cwd: process.cwd() });
    assert.ok(result.stdout.trim().length > 0, 'should print cwd');
    assert.equal(result.code, 0);
  });
});
