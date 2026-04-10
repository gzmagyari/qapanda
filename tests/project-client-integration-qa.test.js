const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

test('CLI integration QA keeps connected-project auth, workspace, context, notification, and canonical deep-link coverage in place', () => {
  const source = read('unit/cloud-cli-auth.test.js');

  for (const requiredSnippet of [
    "it('falls back to device approval when browser login is unavailable'",
    "it('prints workspace memberships through the workspace list command'",
    "it('switches workspace through the CLI command handler'",
    "it('shows and saves connected-project context through the CLI command handler'",
    "it('opens the current hosted project context through the CLI command handler'",
    "it('prints actionable hosted notifications through the CLI command handler'",
    'https://app.qapanda.localhost/app/projects/repo-1?contextId=context-9',
    'Saved connected-project context for this checkout',
    'Connected project identity: cc-manager',
  ]) {
    assert.match(source, new RegExp(requiredSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('extension integration QA keeps hosted auth, workspace switching, signed-out gate, and connected-project settings coverage in place', () => {
  const authSource = read('unit/cloud-extension-auth.test.js');
  const entrySource = read('unit/cloud-entry-screen.test.js');
  const switcherSource = read('unit/cloud-workspace-switcher.test.js');

  for (const requiredSnippet of [
    "it('defaults extension login to PKCE, stores the session, and resolves hosted identity'",
    "it('refreshes the session before switching workspaces when the access token is stale'",
    "it('clears the stored session when workspace switching fails after refresh'",
    "it('opens the hosted notifications URL through the extension helper'",
  ]) {
    assert.match(authSource, new RegExp(requiredSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.match(entrySource, /connected-project sync/i);
  assert.match(entrySource, /doesNotMatch\(entry\.textContent, \/this repository\/i\)/);

  for (const requiredSnippet of [
    "it('renders connected-project identity details in settings and explains local fallback mode'",
    "it('renders synced object counts and recent synced objects in settings'",
    "it('posts a workspace switch request when the selection changes'",
    "it('renders connected-project context controls and posts a save request'",
    "it('posts a connected-project open request from settings'",
    'cloudContextSave',
    'cloudContextOpen',
  ]) {
    assert.match(switcherSource, new RegExp(requiredSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('connected-project sync integration QA keeps canonical identity and runtime sync coverage in place', () => {
  const repositorySyncSource = read('unit/cloud-repository-sync.test.js');
  const runtimeSource = read('unit/cloud-sync-runtime.test.js');

  for (const requiredSnippet of [
    "it('produces stable repo identity for the same repo/context and splits contexts when configured'",
    "it('normalizes equivalent SSH and HTTPS remotes to the same canonical repository identity'",
    "it('falls back to a stable path-based identity when no shared remote is configured'",
    'ctx:shared',
    'path_fallback',
    'git:github.com/qa-panda/cc-manager',
  ]) {
    assert.match(repositorySyncSource, new RegExp(requiredSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const requiredSnippet of [
    "it('registers the checkout, syncs local objects, and persists conflicts'",
    "it('refreshes and resolves conflicts through the shared sync client'",
    "it('baselines existing unread notifications on start and emits only newly unread items on later ticks'",
    'assert.deepEqual(status.objectCounts, { tests: 1, issues: 1, recipes: 1 });',
    "assert.equal(runtime.getStatus().indicator.status, 'conflict');",
    'notificationBatches[0].items.map((item) => item.notificationId)',
  ]) {
    assert.match(runtimeSource, new RegExp(requiredSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
