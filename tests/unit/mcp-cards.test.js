const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { renderCompleteCard } = require('../../src/mcp-cards');

function makeRenderer() {
  const output = [];
  return {
    output,
    _post(msg) {
      output.push(msg);
    },
  };
}

describe('mcp-cards', () => {
  it('does not render a permanent test card for update_step_result but does emit a live card', () => {
    const renderer = makeRenderer();
    const suppressed = renderCompleteCard(
      'update_step_result',
      { test_id: 'test-1', run_id: 1, step_id: 1, status: 'pass' },
      {
        content: [{
          type: 'text',
          text: JSON.stringify({
            step_id: 1,
            status: 'pass',
            _testCard: {
              title: 'Consent dialog',
              test_id: 'test-1',
              passed: 1,
              failed: 0,
              skipped: 0,
              steps: [{ name: 'Open page', status: 'pass' }],
            },
          }),
        }],
      },
      renderer,
      'QA Engineer (Browser)',
      'card-1'
    );

    assert.equal(suppressed, true);
    assert.equal(renderer.output.filter((msg) => msg.type === 'testCard').length, 0);
    assert.equal(renderer.output.filter((msg) => msg.type === 'liveEntityCard').length, 1);
    assert.equal(renderer.output.find((msg) => msg.type === 'liveEntityCard').data.test_id, 'test-1');
    assert.equal(renderer.output.filter((msg) => msg.type === 'mcpCardComplete').length, 1);
  });

  it('still renders a permanent test card for display_test_summary and clears any live card', () => {
    const renderer = makeRenderer();
    const suppressed = renderCompleteCard(
      'display_test_summary',
      {
        title: 'Consent dialog',
        passed: 1,
        failed: 0,
        skipped: 0,
        steps: [{ name: 'Open page', status: 'pass' }],
      },
      { content: [{ type: 'text', text: 'Displayed test summary card.' }] },
      renderer,
      'QA Engineer (Browser)',
      'card-2'
    );

    assert.equal(suppressed, true);
    assert.equal(renderer.output.filter((msg) => msg.type === 'clearLiveEntityCard').length, 1);
    assert.equal(renderer.output.filter((msg) => msg.type === 'testCard').length, 1);
    assert.equal(renderer.output.filter((msg) => msg.type === 'mcpCardComplete').length, 0);
  });
});
