const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

describe('cloud conflicts UI', () => {
  it('renders per-conflict resolution actions and posts explicit resolutions', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: { loggedIn: true, authMode: 'pkce', actor: { email: 'dev@example.com' } },
        cloudStatus: {
          session: { loggedIn: true },
          sync: {
            started: true,
            registered: true,
            indicator: { status: 'conflict', label: 'Conflicts', detail: '1 conflict', tone: 'warning' },
            pendingMutationCount: 1,
            openConflictCount: 1,
            lastSyncedAt: '2026-04-05T10:00:00.000Z',
            lastError: null,
            conflicts: [{
              conflictId: 'conflict-1',
              objectType: 'agent',
              objectId: 'reviewer',
              conflictCode: 'client_remote_conflict',
              updatedAt: '2026-04-05T10:01:00.000Z',
              localPayload: { title: 'Local Reviewer' },
              remotePayload: { title: 'Cloud Reviewer' },
            }],
          },
          notifications: { unreadCount: 0, hasUnread: false, summary: { unreadCount: 0, latest: [] } },
        },
      }));
      await wv.flush();

      wv.click('[data-tab="settings"]');
      await wv.flush();

      const cards = wv.document.querySelectorAll('.cloud-conflict-card');
      assert.equal(cards.length, 1);
      assert.match(cards[0].textContent, /agent:reviewer/);
      assert.match(cards[0].textContent, /Local Reviewer/);
      assert.match(cards[0].textContent, /Cloud Reviewer/);

      wv.click('#cloud-conflicts-refresh');
      await wv.flush();
      assert.equal(wv.messagesOfType('cloudSyncRefreshConflicts').length, 1);

      cards[0].querySelectorAll('button')[0].click();
      await wv.flush();
      assert.deepEqual(
        wv.messagesOfType('cloudSyncResolveConflict').map((msg) => ({ id: msg.conflictId, resolution: msg.resolution })),
        [{ id: 'conflict-1', resolution: 'take_local' }]
      );
    } finally {
      wv.cleanup();
    }
  });
});
