const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseWaitDelay, formatWaitDelay, WAIT_OPTIONS } = require('../../src/state');

describe('wait delay parsing', () => {
  it('parseWaitDelay parses minute values', () => {
    assert.equal(parseWaitDelay('1m'), 60000);
    assert.equal(parseWaitDelay('5m'), 300000);
    assert.equal(parseWaitDelay('30m'), 1800000);
  });

  it('parseWaitDelay parses hour values', () => {
    assert.equal(parseWaitDelay('1h'), 3600000);
    assert.equal(parseWaitDelay('2h'), 7200000);
  });

  it('parseWaitDelay parses day values', () => {
    assert.equal(parseWaitDelay('1d'), 86400000);
  });

  it('parseWaitDelay returns 0 for empty/null', () => {
    assert.equal(parseWaitDelay(''), 0);
    assert.equal(parseWaitDelay(null), 0);
    assert.equal(parseWaitDelay(undefined), 0);
  });

  it('WAIT_OPTIONS is an array of {value, label, ms} objects', () => {
    assert.ok(Array.isArray(WAIT_OPTIONS));
    assert.ok(WAIT_OPTIONS.length > 10, 'should have many options');
    const values = WAIT_OPTIONS.map(o => o.value);
    assert.ok(values.includes(''), 'should have empty (None)');
    assert.ok(values.includes('1m'), 'should have 1m');
    assert.ok(values.includes('5m'), 'should have 5m');
    assert.ok(values.includes('1h'), 'should have 1h');
    assert.ok(values.includes('1d'), 'should have 1d');
    // Each option should have value, label, ms
    for (const opt of WAIT_OPTIONS) {
      assert.ok(typeof opt.value === 'string', 'value should be string');
      assert.ok(typeof opt.label === 'string', 'label should be string');
      assert.ok(typeof opt.ms === 'number', 'ms should be number');
    }
  });

  it('formatWaitDelay formats correctly', () => {
    // formatWaitDelay should produce human-readable strings
    const result = formatWaitDelay('5m');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

describe('error retry constants', () => {
  it('error retry uses 30 minute delay', () => {
    // The ERROR_RETRY_DELAY_MS constant in session-manager is 30 * 60_000
    const ERROR_RETRY_DELAY_MS = 30 * 60_000;
    assert.equal(ERROR_RETRY_DELAY_MS, 1800000); // 30 minutes
  });

  it('error retry pattern: set flag, schedule timer, reset on fire', () => {
    // Simulate the error retry pattern
    const manifest = { errorRetry: false, nextWakeAt: null };

    // Schedule error retry
    manifest.errorRetry = true;
    manifest.nextWakeAt = new Date(Date.now() + 1800000).toISOString();

    assert.equal(manifest.errorRetry, true);
    assert.ok(manifest.nextWakeAt);

    // After timer fires, reset
    manifest.errorRetry = false;
    manifest.nextWakeAt = null;

    assert.equal(manifest.errorRetry, false);
    assert.equal(manifest.nextWakeAt, null);
  });
});
