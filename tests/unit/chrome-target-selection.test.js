const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _isPlaceholderPageUrl,
  _selectBestPageTarget,
} = require('../../extension/chrome-manager');

test('_isPlaceholderPageUrl identifies default/stale placeholder pages', () => {
  assert.equal(_isPlaceholderPageUrl('https://www.google.com/'), true);
  assert.equal(_isPlaceholderPageUrl('about:blank'), true);
  assert.equal(_isPlaceholderPageUrl('chrome-error://chromewebdata/'), true);
  assert.equal(_isPlaceholderPageUrl('https://app.qapanda.localhost/'), false);
});

test('_selectBestPageTarget prefers a real app page over Google placeholder page', () => {
  const target = _selectBestPageTarget([
    { id: 'google', type: 'page', url: 'https://www.google.com/', webSocketDebuggerUrl: 'ws://google' },
    { id: 'app', type: 'page', url: 'https://app.qapanda.localhost/', webSocketDebuggerUrl: 'ws://app' },
  ], 'google');
  assert.equal(target && target.id, 'app');
});

test('_selectBestPageTarget keeps the current non-placeholder page', () => {
  const target = _selectBestPageTarget([
    { id: 'google', type: 'page', url: 'https://www.google.com/', webSocketDebuggerUrl: 'ws://google' },
    { id: 'app', type: 'page', url: 'https://app.qapanda.localhost/', webSocketDebuggerUrl: 'ws://app' },
  ], 'app');
  assert.equal(target && target.id, 'app');
});
