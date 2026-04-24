const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createTempDir, writeJson } = require('../helpers/test-utils');

const srcFlags = require('../../src/feature-flags');
const extFlags = require('../../extension/src/feature-flags');
const { loadMergedAgents } = require('../../extension/agents-store');

const originalHomedir = os.homedir;

describe('feature flag secret overrides', () => {
  let tmp;

  before(() => {
    os.homedir = () => tmp ? tmp.root : originalHomedir();
  });

  after(() => {
    os.homedir = originalHomedir;
  });

  beforeEach(() => {
    tmp = createTempDir();
    srcFlags._resetCache();
    extFlags._resetCache();
  });

  afterEach(() => {
    srcFlags._resetCache();
    extFlags._resetCache();
    tmp.cleanup();
    tmp = null;
  });

  it('loads project secret-features.json over bundled defaults', () => {
    const repoRoot = path.join(tmp.root, 'repo');
    writeJson(path.join(repoRoot, '.qpanda', 'secret-features.json'), {
      enableRemoteDesktop: true,
      enableClaudeCli: true,
      ignoredFlag: true,
    });

    const flags = srcFlags.loadFeatureFlags(null, repoRoot);
    assert.equal(flags.enableRemoteDesktop, true);
    assert.equal(flags.enableClaudeCli, true);
    assert.deepEqual(
      Object.keys(flags).sort(),
      ['enableClaudeCli', 'enableExtensionCloud', 'enablePersonalWorkspaces', 'enableRemoteDesktop']
    );
  });

  it('project secret-features.json overrides global secret-features.json', () => {
    const repoRoot = path.join(tmp.root, 'repo');
    writeJson(path.join(tmp.root, '.qpanda', 'secret-features.json'), {
      enableRemoteDesktop: false,
      enableClaudeCli: false,
    });
    writeJson(path.join(repoRoot, '.qpanda', 'secret-features.json'), {
      enableRemoteDesktop: true,
      enableClaudeCli: true,
    });

    const flags = srcFlags.loadFeatureFlags(null, repoRoot);
    assert.equal(flags.enableRemoteDesktop, true);
    assert.equal(flags.enableClaudeCli, true);
  });

  it('extension agent loading respects project secret feature flags', () => {
    const repoRoot = path.join(tmp.root, 'repo');
    const extensionDir = path.join(tmp.root, 'extension');
    writeJson(path.join(extensionDir, 'resources', 'system-agents.json'), {
      QA: { name: 'QA', cli: 'qa-remote-codex', enabled: true, featureFlag: 'enableRemoteDesktop' },
      dev: { name: 'Developer', cli: 'codex', enabled: true },
    });
    writeJson(path.join(extensionDir, 'resources', 'feature-flags.json'), {
      enableRemoteDesktop: false,
      enableClaudeCli: false,
      enableExtensionCloud: false,
    });

    let agents = loadMergedAgents(repoRoot, extensionDir);
    assert.ok(!agents.system.QA, 'feature-gated QA agent should stay hidden by default');
    assert.ok(agents.system.dev, 'ungated agents should still load');

    extFlags._resetCache();
    writeJson(path.join(repoRoot, '.qpanda', 'secret-features.json'), {
      enableRemoteDesktop: true,
    });

    agents = loadMergedAgents(repoRoot, extensionDir);
    assert.ok(agents.system.QA, 'project secret feature should unhide the QA agent');
  });
});
