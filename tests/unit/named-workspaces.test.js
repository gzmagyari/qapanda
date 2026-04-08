const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createTempDir, writeJson } = require('../helpers/test-utils');

const originalHomedir = os.homedir;

const {
  DEFAULT_RESUME_ALIAS,
  bindResumeAlias,
  ensureNamedWorkspace,
  listResumeAliases,
  removeResumeAlias,
  removeResumeAliasTarget,
  resolveWorkspaceRoot,
  resolveResumeToken,
  workspacesRoot,
} = require('../../src/named-workspaces');

describe('named workspaces', () => {
  let tmp;

  before(() => {
    os.homedir = () => (tmp ? tmp.root : originalHomedir());
  });

  after(() => {
    os.homedir = originalHomedir;
  });

  beforeEach(() => {
    tmp = createTempDir();
  });

  afterEach(() => {
    tmp.cleanup();
    tmp = null;
  });

  function writeManifest(stateRoot, runId) {
    writeJson(path.join(stateRoot, 'runs', runId, 'manifest.json'), {
      runId,
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  it('creates workspace metadata and alias storage on first use', async () => {
    const descriptor = await ensureNamedWorkspace('Journal');
    assert.equal(descriptor.workspaceName, 'journal');
    assert.equal(descriptor.repoRoot, path.join(workspacesRoot(), 'journal'));

    const meta = require('fs').readFileSync(path.join(descriptor.repoRoot, '.qpanda', 'workspace.json'), 'utf8');
    const aliases = require('fs').readFileSync(path.join(descriptor.repoRoot, '.qpanda', 'resume-aliases.json'), 'utf8');
    assert.match(meta, /"name": "journal"/);
    assert.match(meta, new RegExp(`"defaultResume": "${DEFAULT_RESUME_ALIAS}"`));
    assert.match(aliases, /"aliases": \{\}/);
  });

  it('rejects named workspace launches when the feature is disabled instead of falling back to the repo root', async () => {
    const repoRoot = path.join(tmp.root, 'repo');
    const repoDescriptor = await resolveWorkspaceRoot(repoRoot, null, { enableNamedWorkspaces: false });
    assert.equal(repoDescriptor.kind, 'repo');
    assert.equal(repoDescriptor.repoRoot, path.resolve(repoRoot));

    await assert.rejects(
      () => resolveWorkspaceRoot(repoRoot, 'company', { enableNamedWorkspaces: false }),
      /Named workspaces are disabled/
    );
  });

  it('binds, lists, and removes workspace-local resume aliases', async () => {
    const descriptor = await ensureNamedWorkspace('journal');
    const result = await bindResumeAlias(descriptor.repoRoot, 'Main', 'run-123', { chatTarget: 'agent-memory' });
    assert.equal(result.alias, 'main');

    const aliases = await listResumeAliases(descriptor.repoRoot);
    assert.deepEqual(aliases.map((item) => ({ name: item.name, runId: item.runId, chatTarget: item.chatTarget })), [
      { name: 'main', runId: 'run-123', chatTarget: 'agent-memory' },
    ]);

    const removed = await removeResumeAlias(descriptor.repoRoot, 'main');
    assert.equal(removed.runId, 'run-123');
    assert.deepEqual(await listResumeAliases(descriptor.repoRoot), []);
  });

  it('resolves aliases, run ids, and pending aliases against the current workspace root', async () => {
    const descriptor = await ensureNamedWorkspace('journal');
    writeManifest(descriptor.stateRoot, 'run-123');
    writeManifest(descriptor.stateRoot, 'run-456');
    writeManifest(descriptor.stateRoot, 'can-you-see-the-latest-c-mnjjyry0');
    await bindResumeAlias(descriptor.repoRoot, 'main', 'run-123', {});

    const alias = await resolveResumeToken('main', descriptor.repoRoot, descriptor.stateRoot, { allowPendingAlias: true });
    assert.deepEqual({ kind: alias.kind, alias: alias.alias, runId: alias.runId }, { kind: 'alias', alias: 'main', runId: 'run-123' });

    const run = await resolveResumeToken('run-456', descriptor.repoRoot, descriptor.stateRoot, { allowPendingAlias: true });
    assert.deepEqual({ kind: run.kind, runId: run.runId }, { kind: 'run', runId: 'run-456' });

    const aliasSafeRun = await resolveResumeToken('can-you-see-the-latest-c-mnjjyry0', descriptor.repoRoot, descriptor.stateRoot, {
      allowPendingAlias: true,
      chatTarget: 'agent-dev',
    });
    assert.deepEqual(
      { kind: aliasSafeRun.kind, runId: aliasSafeRun.runId },
      { kind: 'run', runId: 'can-you-see-the-latest-c-mnjjyry0' }
    );

    const pending = await resolveResumeToken('planner', descriptor.repoRoot, descriptor.stateRoot, { allowPendingAlias: true });
    assert.deepEqual({ kind: pending.kind, alias: pending.alias }, { kind: 'pending-alias', alias: 'planner' });
  });

  it('supports target-scoped alias bindings and does not fall back to another agent target', async () => {
    const descriptor = await ensureNamedWorkspace('company');
    writeManifest(descriptor.stateRoot, 'run-dev');
    await bindResumeAlias(descriptor.repoRoot, 'main', 'run-dev', { chatTarget: 'agent-dev' });

    const memoryPending = await resolveResumeToken('main', descriptor.repoRoot, descriptor.stateRoot, {
      allowPendingAlias: true,
      chatTarget: 'agent-memory',
    });
    assert.deepEqual({ kind: memoryPending.kind, alias: memoryPending.alias }, { kind: 'pending-alias', alias: 'main' });

    writeManifest(descriptor.stateRoot, 'run-memory');
    await bindResumeAlias(descriptor.repoRoot, 'main', 'run-memory', { chatTarget: 'agent-memory' });

    const devResolved = await resolveResumeToken('main', descriptor.repoRoot, descriptor.stateRoot, {
      allowPendingAlias: true,
      chatTarget: 'agent-dev',
    });
    const memoryResolved = await resolveResumeToken('main', descriptor.repoRoot, descriptor.stateRoot, {
      allowPendingAlias: true,
      chatTarget: 'agent-memory',
    });
    assert.deepEqual({ kind: devResolved.kind, runId: devResolved.runId, chatTarget: devResolved.chatTarget }, {
      kind: 'alias',
      runId: 'run-dev',
      chatTarget: 'agent-dev',
    });
    assert.deepEqual({ kind: memoryResolved.kind, runId: memoryResolved.runId, chatTarget: memoryResolved.chatTarget }, {
      kind: 'alias',
      runId: 'run-memory',
      chatTarget: 'agent-memory',
    });
  });

  it('can remove one target-specific alias binding without deleting the others', async () => {
    const descriptor = await ensureNamedWorkspace('company');
    writeManifest(descriptor.stateRoot, 'run-dev');
    writeManifest(descriptor.stateRoot, 'run-memory');
    await bindResumeAlias(descriptor.repoRoot, 'main', 'run-dev', { chatTarget: 'agent-dev' });
    await bindResumeAlias(descriptor.repoRoot, 'main', 'run-memory', { chatTarget: 'agent-memory' });

    const removed = await removeResumeAliasTarget(descriptor.repoRoot, 'main', 'agent-memory');
    assert.equal(removed.runId, 'run-memory');

    const aliases = await listResumeAliases(descriptor.repoRoot);
    assert.deepEqual(aliases.map((item) => ({ name: item.name, runId: item.runId, chatTarget: item.chatTarget })), [
      { name: 'main', runId: 'run-dev', chatTarget: 'agent-dev' },
    ]);

    const memoryPending = await resolveResumeToken('main', descriptor.repoRoot, descriptor.stateRoot, {
      allowPendingAlias: true,
      chatTarget: 'agent-memory',
    });
    assert.deepEqual({ kind: memoryPending.kind, alias: memoryPending.alias }, { kind: 'pending-alias', alias: 'main' });
  });
});
