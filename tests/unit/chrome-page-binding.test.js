const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseChromeCurrentPageToolResult,
  parseChromePagesText,
  parseChromePagesToolResult,
  resolveChromeTargetByBinding,
  resolveChromeTargetFromSelection,
} = require('../../extension/chrome-page-binding');

test('parseChromePagesText extracts numbered pages and selected page metadata', () => {
  const parsed = parseChromePagesText([
    '## Pages',
    '1: https://app.qapanda.localhost/app',
    '2: https://app.qapanda.localhost/app/settings [selected]',
  ].join('\n'));

  assert.deepEqual(parsed, {
    pages: [
      { pageNumber: 1, url: 'https://app.qapanda.localhost/app', selected: false },
      { pageNumber: 2, url: 'https://app.qapanda.localhost/app/settings', selected: true },
    ],
    selectedPageNumber: 2,
    selectedPageUrl: 'https://app.qapanda.localhost/app/settings',
  });
});

test('parseChromePagesToolResult reads plain-text page lists from MCP result objects', () => {
  const parsed = parseChromePagesToolResult({
    content: [{
      type: 'text',
      text: '## Pages\n1: https://app.qapanda.localhost/app [selected]',
    }],
  });

  assert.equal(parsed.selectedPageNumber, 1);
  assert.equal(parsed.selectedPageUrl, 'https://app.qapanda.localhost/app');
});

test('parseChromeCurrentPageToolResult extracts the live page URL from snapshot-bearing chrome output', () => {
  const parsed = parseChromeCurrentPageToolResult({
    content: [{
      type: 'text',
      text: [
        'Element found.',
        '## Latest page snapshot',
        'uid=1_0 RootWebArea "BacktestLoop Dashboard" url="http://localhost:8001/"',
      ].join('\n'),
    }],
  });

  assert.deepEqual(parsed, {
    currentPageUrl: 'http://localhost:8001/',
    pageNumber: null,
    source: 'snapshot',
  });
});

test('resolveChromeTargetFromSelection prefers an exact unique URL match over a mismatched slot', () => {
  const pages = [
    { id: 'page-1', type: 'page', url: 'https://app.qapanda.localhost/app', webSocketDebuggerUrl: 'ws://page-1' },
    { id: 'page-2', type: 'page', url: 'https://app.qapanda.localhost/app/projects', webSocketDebuggerUrl: 'ws://page-2' },
    { id: 'page-3', type: 'page', url: 'https://app.qapanda.localhost/app/settings', webSocketDebuggerUrl: 'ws://page-3' },
  ];

  const resolved = resolveChromeTargetFromSelection(pages, {
    pageNumber: 2,
    expectedUrl: 'https://app.qapanda.localhost/app/settings',
  });

  assert.equal(resolved.reason, 'url-over-slot');
  assert.equal(resolved.target && resolved.target.id, 'page-3');
});

test('resolveChromeTargetFromSelection fails closed on ambiguous duplicate URLs', () => {
  const pages = [
    { id: 'page-1', type: 'page', url: 'https://app.qapanda.localhost/app/settings', webSocketDebuggerUrl: 'ws://page-1' },
    { id: 'page-2', type: 'page', url: 'https://app.qapanda.localhost/app/settings', webSocketDebuggerUrl: 'ws://page-2' },
  ];

  const resolved = resolveChromeTargetFromSelection(pages, {
    expectedUrl: 'https://app.qapanda.localhost/app/settings',
  });

  assert.equal(resolved.reason, 'ambiguous-url');
  assert.equal(resolved.target, null);
});

test('resolveChromeTargetByBinding restores the bound target by id before falling back', () => {
  const pages = [
    { id: 'page-1', type: 'page', url: 'https://app.qapanda.localhost/app', webSocketDebuggerUrl: 'ws://page-1' },
    { id: 'page-2', type: 'page', url: 'https://app.qapanda.localhost/app/settings', webSocketDebuggerUrl: 'ws://page-2' },
  ];

  const resolved = resolveChromeTargetByBinding(pages, {
    targetId: 'page-2',
    url: 'https://app.qapanda.localhost/app/settings',
  });

  assert.equal(resolved.reason, 'bound-id');
  assert.equal(resolved.target && resolved.target.id, 'page-2');
});
