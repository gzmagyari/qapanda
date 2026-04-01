const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveInitialDirectAgent } = require('../../src/shell');

describe('shell default direct agent', () => {
  it('defaults plain interactive shell messages to QA-Browser', () => {
    assert.equal(resolveInitialDirectAgent({}), 'QA-Browser');
  });

  it('preserves explicit agent selection', () => {
    assert.equal(resolveInitialDirectAgent({ agent: 'dev' }), 'dev');
  });

  it('does not force QA-Browser when a mode is preselected', () => {
    assert.equal(resolveInitialDirectAgent({ mode: 'test' }), null);
  });
});
