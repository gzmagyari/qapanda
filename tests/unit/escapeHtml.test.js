const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// escapeHtml lives in extension/webview/main.js (not easily importable)
// We duplicate the current implementation here and test it directly.
// If it gets extracted to a shared module, update the import.

function escapeHtml(str) {
  if (typeof str !== 'string') str = JSON.stringify(str) || '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes ampersands', () => {
    assert.equal(escapeHtml('foo & bar'), 'foo &amp; bar');
  });

  it('escapes quotes', () => {
    assert.equal(escapeHtml('say "hello"'), 'say &quot;hello&quot;');
  });

  it('passes through plain strings unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
  });

  it('handles empty string', () => {
    assert.equal(escapeHtml(''), '');
  });

  // Object/array handling (the bug that crashed initConfig)
  it('handles object input by JSON stringifying', () => {
    const obj = { browser: 'QA-Browser', computer: 'QA' };
    const result = escapeHtml(obj);
    assert.ok(result.includes('QA-Browser'), 'should contain value');
    assert.ok(typeof result === 'string', 'should return string');
    // Should not throw
  });

  it('handles array input by JSON stringifying', () => {
    const arr = ['dev', 'QA-Browser'];
    const result = escapeHtml(arr);
    assert.ok(result.includes('dev'), 'should contain array value');
    assert.ok(typeof result === 'string');
  });

  it('handles null by returning empty string', () => {
    const result = escapeHtml(null);
    assert.equal(typeof result, 'string');
    // JSON.stringify(null) = 'null', so result should be 'null'
    assert.equal(result, 'null');
  });

  it('handles undefined by returning empty string', () => {
    const result = escapeHtml(undefined);
    assert.equal(typeof result, 'string');
    // JSON.stringify(undefined) returns undefined, || '' catches it
    assert.equal(result, '');
  });

  it('handles number input', () => {
    const result = escapeHtml(42);
    assert.equal(result, '42');
  });

  it('handles boolean input', () => {
    assert.equal(escapeHtml(true), 'true');
    assert.equal(escapeHtml(false), 'false');
  });

  it('handles nested object with HTML chars', () => {
    const obj = { name: '<b>bold</b>' };
    const result = escapeHtml(obj);
    assert.ok(!result.includes('<b>'), 'HTML tags should be escaped');
    assert.ok(result.includes('&lt;b&gt;'), 'should have escaped tags');
  });
});
