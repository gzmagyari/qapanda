const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildDeviceMetadata,
  cloudSyncDbPath,
  createCloudBoundary,
  loadCloudSyncProjectConfig,
  resolveRepositoryIdentity,
  saveCloudSyncProjectConfig,
} = require('../../src/cloud');

function makeTempRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-sync-'));
}

describe('buildDeviceMetadata', () => {
  it('builds deterministic CLI and extension device metadata', () => {
    const cliDevice = buildDeviceMetadata({
      target: 'cli',
      hostLabel: 'devbox',
      username: 'alex',
      platform: 'win32',
      release: '11.0',
      arch: 'x64',
    });
    const extensionDevice = buildDeviceMetadata({
      target: 'extension',
      hostLabel: 'devbox',
      username: 'alex',
      appName: 'VS Code',
      appVersion: '1.99.0',
      platform: 'win32',
      release: '11.0',
      arch: 'x64',
    });

    assert.equal(cliDevice.deviceName, 'devbox (alex)');
    assert.equal(extensionDevice.deviceName, 'devbox (VS Code)');
    assert.equal(extensionDevice.platformLabel, 'VS Code 1.99.0 on win32 11.0');
    assert.equal(
      extensionDevice.machineFingerprint,
      buildDeviceMetadata({
        target: 'extension',
        hostLabel: 'devbox',
        username: 'alex',
        appName: 'VS Code',
        appVersion: '1.99.0',
        platform: 'win32',
        release: '11.0',
        arch: 'x64',
      }).machineFingerprint
    );
  });
});

describe('cloud sync project config', () => {
  it('persists context-mode settings in .qpanda/config.json', () => {
    const repoRoot = makeTempRepoRoot();

    assert.deepEqual(loadCloudSyncProjectConfig(repoRoot), {
      contextMode: 'shared',
      explicitContextKey: null,
      contextLabel: null,
    });

    const saved = saveCloudSyncProjectConfig(repoRoot, {
      contextMode: 'custom',
      explicitContextKey: 'release-preview',
      contextLabel: 'Release Preview',
    });

    assert.deepEqual(saved, {
      contextMode: 'custom',
      explicitContextKey: 'release-preview',
      contextLabel: 'Release Preview',
    });
  });

  it('preserves unspecified sync settings when saving a partial update', () => {
    const repoRoot = makeTempRepoRoot();

    saveCloudSyncProjectConfig(repoRoot, {
      contextMode: 'custom',
      explicitContextKey: 'release-preview',
      contextLabel: 'Release Preview',
    });

    const saved = saveCloudSyncProjectConfig(repoRoot, {
      explicitContextKey: 'release-candidate',
    });

    assert.deepEqual(saved, {
      contextMode: 'custom',
      explicitContextKey: 'release-candidate',
      contextLabel: 'Release Preview',
    });
  });
});

describe('resolveRepositoryIdentity', () => {
  it('produces stable repo identity for the same repo/context and splits contexts when configured', async () => {
    const repoRoot = makeTempRepoRoot();
    const boundary = createCloudBoundary({ target: 'cli', repoRoot, env: {} });
    const baseGit = {
      localPath: repoRoot,
      remoteUrl: 'https://github.com/QA-Panda/cc-manager.git',
      branchName: 'main',
    };

    const first = await resolveRepositoryIdentity(boundary, { git: baseGit });
    const second = await resolveRepositoryIdentity(boundary, { git: baseGit });
    const branch = await resolveRepositoryIdentity(boundary, {
      git: { ...baseGit, branchName: 'release/v1' },
      contextMode: 'branch',
    });
    const worktree = await resolveRepositoryIdentity(boundary, {
      git: { ...baseGit, localPath: path.join(repoRoot, '..', 'cc-manager-worktree') },
      contextMode: 'worktree',
    });
    const custom = await resolveRepositoryIdentity(boundary, {
      git: baseGit,
      contextMode: 'custom',
      explicitContextKey: 'release-preview',
      contextLabel: 'Release Preview',
    });

    assert.equal(first.identity.instanceKey, second.identity.instanceKey);
    assert.equal(first.identity.contextKey, 'ctx:shared');
    assert.notEqual(branch.identity.contextKey, first.identity.contextKey);
    assert.notEqual(worktree.identity.contextKey, first.identity.contextKey);
    assert.match(custom.identity.contextKey, /^ctx:custom:/);
    assert.equal(custom.identity.contextLabel, 'Release Preview');
    assert.equal(first.syncDbPath, cloudSyncDbPath(repoRoot));
  });
});

describe('createLocalSyncStore', () => {
  it('persists sync state under .qpanda/runtime/cloud-sync.sqlite', async () => {
    const repoRoot = makeTempRepoRoot();
    const boundary = createCloudBoundary({ target: 'cli', repoRoot, env: {} });
    const dbPath = cloudSyncDbPath(repoRoot);
    const repository = (await resolveRepositoryIdentity(boundary, {
      git: {
        localPath: repoRoot,
        remoteUrl: 'https://github.com/QA-Panda/cc-manager.git',
        branchName: 'main',
      },
    })).identity;

    const { store } = await boundary.createLocalSyncStore();
    store.bindCloudContext({
      repository,
      repositoryId: 'repo-1',
      repositoryContextId: 'context-1',
      checkoutId: 'checkout-1',
    });
    store.setLastSyncCursor(42);
    store.queueMutation('test', 'test-1', 'upsert', { id: 'test-1', status: 'ready' }, { title: 'Cloud Test' });
    store.close();

    const reopened = await boundary.createLocalSyncStore();
    assert.equal(reopened.dbPath, dbPath);
    assert.equal(reopened.store.getLastSyncCursor(), 42);
    assert.equal(reopened.store.getBinding().repositoryContextId, 'context-1');
    assert.equal(reopened.store.listPendingMutations().length, 1);
    reopened.store.close();
    assert.equal(fs.existsSync(dbPath), true);
  });
});
