const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

function sampleCloudSession() {
  return {
    loggedIn: true,
    authMode: 'pkce',
    storageMode: 'vscode-secret-storage',
    actor: {
      email: 'dev@example.com',
      displayName: 'Dev User',
    },
    workspace: {
      workspaceId: 'workspace-1',
      slug: 'demo-workspace',
      name: 'Demo Workspace',
      planTier: 'pro',
      roleKey: 'owner',
    },
    session: {
      workspaceId: 'workspace-1',
      updatedAt: '2026-04-08T20:00:00.000Z',
    },
    memberships: [
      {
        workspaceId: 'workspace-1',
        slug: 'demo-workspace',
        name: 'Demo Workspace',
        roleKey: 'owner',
      },
      {
        workspaceId: 'workspace-2',
        slug: 'qa-team',
        name: 'QA Team',
        roleKey: 'admin',
      },
    ],
  };
}

function sampleCloudStatus(overrides = {}) {
  const { sync: ignoredSync, ...restOverrides } = overrides;
  const syncOverrides = overrides.sync || {};
  return {
    sync: {
      contextMode: 'shared',
      explicitContextKey: null,
      contextLabel: null,
      binding: {
        repositoryId: 'repo-1',
        repositoryContextId: 'context-1',
        checkoutId: 'checkout-1',
      },
      objectCounts: {
        tests: 2,
        issues: 1,
        recipes: 1,
      },
      recentObjects: [
        {
          objectType: 'issue',
          objectId: 'issue-7',
          title: 'Checkout fails on login',
          updatedAt: '2026-04-08T19:55:00.000Z',
        },
        {
          objectType: 'test',
          objectId: 'test-4',
          title: 'Verify login flow',
          updatedAt: '2026-04-08T19:50:00.000Z',
        },
      ],
      repository: {
        kind: 'remote',
        displayName: 'cc-manager',
        canonicalRemoteUrl: 'git:github.com/qa-panda/cc-manager',
        repositoryKey: 'git:github.com/qa-panda/cc-manager',
        contextKey: 'ctx:shared',
        instanceKey: 'git:github.com/qa-panda/cc-manager#ctx:shared',
      },
      ...syncOverrides,
      repository: {
        kind: 'remote',
        displayName: 'cc-manager',
        canonicalRemoteUrl: 'git:github.com/qa-panda/cc-manager',
        repositoryKey: 'git:github.com/qa-panda/cc-manager',
        contextKey: 'ctx:shared',
        instanceKey: 'git:github.com/qa-panda/cc-manager#ctx:shared',
        ...(syncOverrides.repository || {}),
      },
      binding: {
        repositoryId: 'repo-1',
        repositoryContextId: 'context-1',
        checkoutId: 'checkout-1',
        ...(syncOverrides.binding || {}),
      },
    },
    notifications: null,
    ...restOverrides,
  };
}

describe('cloud workspace switcher', () => {
  it('renders hosted workspace memberships in settings', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: sampleCloudSession(),
        cloudStatus: sampleCloudStatus(),
      }));
      await wv.flush();
      wv.click('[data-tab="settings"]');
      await wv.flush();

      const select = wv.document.getElementById('cloud-account-workspace-select');
      assert.equal(select.options.length, 2);
      assert.equal(select.value, 'workspace-1');
      assert.match(select.options[1].textContent, /QA Team/);
    } finally {
      wv.cleanup();
    }
  });

  it('renders connected-project identity details in settings and explains local fallback mode', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: sampleCloudSession(),
        cloudStatus: sampleCloudStatus(),
      }));
      await wv.flush();
      wv.click('[data-tab="settings"]');
      await wv.flush();

      assert.match(wv.text('#cloud-repository-state'), /resolves this checkout to the connected project cc-manager across machines/i);
      assert.match(wv.text('#cloud-repository-meta'), /git:github\.com\/qa-panda\/cc-manager/);
      assert.match(wv.text('#cloud-repository-meta'), /ctx:shared/);

      wv.postMessage({
        type: 'cloudStatusData',
        cloudStatus: sampleCloudStatus({
          sync: {
            repository: {
              kind: 'path_fallback',
              displayName: 'cc-manager',
              canonicalRemoteUrl: null,
              repositoryKey: 'path:1234abcd',
              contextKey: 'ctx:shared',
              instanceKey: 'path:1234abcd#ctx:shared',
            },
          },
        }),
      });
      await wv.flush();

      assert.match(wv.text('#cloud-repository-state'), /local path fallback/i);
      assert.match(wv.text('#cloud-repository-meta'), /Project key path:1234abcd/);
    } finally {
      wv.cleanup();
    }
  });

  it('renders synced object counts and recent synced objects in settings', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: sampleCloudSession(),
        cloudStatus: sampleCloudStatus(),
      }));
      await wv.flush();
      wv.click('[data-tab="settings"]');
      await wv.flush();

      assert.match(wv.text('#cloud-objects-state'), /2 tests, 1 issues?, and 1 recipes? are currently mirrored for this connected-project context/i);
      assert.match(wv.text('#cloud-objects-meta'), /Hosted context context-1/);
      assert.match(wv.text('#cloud-objects-list'), /issue-7/);
      assert.match(wv.text('#cloud-objects-list'), /Checkout fails on login/);
      assert.match(wv.text('#cloud-objects-list'), /Verify login flow/);
    } finally {
      wv.cleanup();
    }
  });

  it('posts a workspace switch request when the selection changes', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: sampleCloudSession(),
      }));
      await wv.flush();
      wv.click('[data-tab="settings"]');
      await wv.flush();

      const select = wv.document.getElementById('cloud-account-workspace-select');
      select.value = 'workspace-2';
      select.dispatchEvent(new wv.window.Event('change', { bubbles: true }));
      await wv.flush();

      wv.click('#cloud-account-workspace-switch');
      await wv.flush();

      const switchMessages = wv.messagesOfType('cloudSessionSwitchWorkspace');
      assert.equal(switchMessages.length, 1);
      assert.equal(switchMessages[0].workspaceId, 'workspace-2');
    } finally {
      wv.cleanup();
    }
  });

  it('renders connected-project context controls and posts a save request', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: sampleCloudSession(),
        cloudStatus: sampleCloudStatus({
          sync: {
            contextMode: 'branch',
            explicitContextKey: null,
            contextLabel: 'feature/cloud-sync',
          },
        }),
      }));
      await wv.flush();
      wv.click('[data-tab="settings"]');
      await wv.flush();

      assert.equal(wv.document.getElementById('cloud-context-mode').value, 'branch');
      assert.match(wv.text('#cloud-context-state'), /separates synced objects by git branch/i);
      assert.match(wv.text('#cloud-context-meta'), /Hosted context context-1/);

      const mode = wv.document.getElementById('cloud-context-mode');
      const key = wv.document.getElementById('cloud-context-key');
      const label = wv.document.getElementById('cloud-context-label');
      mode.value = 'custom';
      mode.dispatchEvent(new wv.window.Event('change', { bubbles: true }));
      key.value = 'release-worktree';
      key.dispatchEvent(new wv.window.Event('input', { bubbles: true }));
      label.value = 'Release worktree';
      label.dispatchEvent(new wv.window.Event('input', { bubbles: true }));
      wv.click('#cloud-context-save');
      await wv.flush();

      const messages = wv.messagesOfType('cloudContextSave');
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'cloudContextSave');
      assert.equal(messages[0].contextMode, 'custom');
      assert.equal(messages[0].explicitContextKey, 'release-worktree');
      assert.equal(messages[0].contextLabel, 'Release worktree');
    } finally {
      wv.cleanup();
    }
  });

  it('posts a connected-project open request from settings', async () => {
    const wv = createWebviewDom();
    try {
      wv.postMessage(sampleInitConfig({
        cloud: { target: 'extension' },
        cloudSession: sampleCloudSession(),
        cloudStatus: sampleCloudStatus(),
      }));
      await wv.flush();
      wv.click('[data-tab="settings"]');
      await wv.flush();

      wv.click('#cloud-context-open');
      await wv.flush();

      const messages = wv.messagesOfType('cloudContextOpen');
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'cloudContextOpen');
    } finally {
      wv.cleanup();
    }
  });
});
