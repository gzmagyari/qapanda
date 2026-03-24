const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, writeJson, readJson } = require('../helpers/test-utils');
const { getCliDefaults } = require('../../extension/onboarding');

describe('getCliDefaults', () => {
  it('both: codex controller, claude worker', () => {
    const d = getCliDefaults('both');
    assert.equal(d.controllerCli, 'codex');
    assert.equal(d.workerCli, 'claude');
  });

  it('claude-only: claude for both', () => {
    const d = getCliDefaults('claude-only');
    assert.equal(d.controllerCli, 'claude');
    assert.equal(d.workerCli, 'claude');
  });

  it('codex-only: codex for both', () => {
    const d = getCliDefaults('codex-only');
    assert.equal(d.controllerCli, 'codex');
    assert.equal(d.workerCli, 'codex');
  });
});

describe('onboarding persistence', () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  it('save and load roundtrip', () => {
    const filePath = path.join(tmp.ccDir, 'onboarding.json');
    const data = {
      version: 1,
      completedAt: new Date().toISOString(),
      cliPreference: 'both',
      defaults: { controllerCli: 'codex', workerCli: 'claude' },
    };
    writeJson(filePath, data);
    const loaded = readJson(filePath);
    assert.deepEqual(loaded.cliPreference, 'both');
    assert.ok(loaded.completedAt);
  });

  it('missing file returns null', () => {
    const loaded = readJson(path.join(tmp.root, 'nonexistent.json'));
    assert.equal(loaded, null);
  });
});

describe('CLI preference → agent override logic', () => {
  const bundledAgents = {
    dev: { name: 'Developer', cli: 'claude' },
    QA: { name: 'QA Engineer', cli: 'qa-remote-claude' },
    'QA-Browser': { name: 'QA Browser', cli: 'codex' },
    'setup-browser': { name: 'Setup Browser', cli: 'claude' },
    'setup-computer': { name: 'Setup Computer', cli: 'qa-remote-claude' },
  };

  function computeOverrides(preference) {
    const overrides = {};
    for (const [id, agent] of Object.entries(bundledAgents)) {
      let targetCli = agent.cli;
      if (preference === 'claude-only') {
        if (agent.cli === 'codex') targetCli = 'claude';
        if (agent.cli === 'qa-remote-codex') targetCli = 'qa-remote-claude';
      } else if (preference === 'codex-only') {
        if (agent.cli === 'claude') targetCli = 'codex';
        if (agent.cli === 'qa-remote-claude') targetCli = 'qa-remote-codex';
      }
      if (targetCli !== agent.cli) {
        overrides[id] = { cli: targetCli };
      }
    }
    return overrides;
  }

  it('both: no overrides needed', () => {
    const overrides = computeOverrides('both');
    assert.equal(Object.keys(overrides).length, 0);
  });

  it('claude-only: overrides codex agents to claude', () => {
    const overrides = computeOverrides('claude-only');
    assert.equal(overrides['QA-Browser'].cli, 'claude'); // was codex
    assert.ok(!overrides.dev, 'dev already uses claude');
    assert.ok(!overrides.QA, 'QA already uses qa-remote-claude');
  });

  it('codex-only: overrides claude agents to codex', () => {
    const overrides = computeOverrides('codex-only');
    assert.equal(overrides.dev.cli, 'codex'); // was claude
    assert.equal(overrides.QA.cli, 'qa-remote-codex'); // was qa-remote-claude
    assert.equal(overrides['setup-browser'].cli, 'codex'); // was claude
    assert.equal(overrides['setup-computer'].cli, 'qa-remote-codex'); // was qa-remote-claude
    assert.ok(!overrides['QA-Browser'], 'QA-Browser already uses codex');
  });

  it('codex-only: remote agents get qa-remote-codex', () => {
    const overrides = computeOverrides('codex-only');
    assert.equal(overrides.QA.cli, 'qa-remote-codex');
    assert.equal(overrides['setup-computer'].cli, 'qa-remote-codex');
  });

  it('claude-only: local codex agents get claude', () => {
    const overrides = computeOverrides('claude-only');
    assert.equal(overrides['QA-Browser'].cli, 'claude');
  });
});
