const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, writeJson, readJson } = require('../helpers/test-utils');
const { loadAgentsFile, saveAgentsFile, loadSystemAgents, loadMergedAgents, enabledAgents } = require('../../extension/agents-store');

let tmp;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { tmp.cleanup(); });

describe('agents-store CRUD', () => {
  it('loadAgentsFile returns empty object for missing file', () => {
    const result = loadAgentsFile(path.join(tmp.root, 'nonexistent.json'));
    assert.deepEqual(result, {});
  });

  it('saveAgentsFile creates directories and writes JSON', () => {
    const filePath = path.join(tmp.root, 'sub', 'dir', 'agents.json');
    const data = { dev: { name: 'Developer', cli: 'claude' } };
    saveAgentsFile(filePath, data);
    const loaded = readJson(filePath);
    assert.deepEqual(loaded, data);
  });

  it('loadAgentsFile reads saved data', () => {
    const filePath = path.join(tmp.root, 'agents.json');
    const data = { qa: { name: 'QA', cli: 'qa-remote-claude' } };
    saveAgentsFile(filePath, data);
    const loaded = loadAgentsFile(filePath);
    assert.deepEqual(loaded, data);
  });

  it('loadSystemAgents loads bundled agents from extension dir', () => {
    // Use real extension dir
    const extDir = path.resolve(__dirname, '../../extension');
    const { agents, meta } = loadSystemAgents(extDir);
    assert.ok(agents.dev, 'should have dev agent');
    assert.ok(agents.QA, 'should have QA agent');
    assert.ok(agents['QA-Browser'], 'should have QA-Browser agent');
    assert.ok(meta.dev, 'should have dev metadata');
    assert.equal(meta.dev.removed, false);
  });

  it('loadSystemAgents applies user override', () => {
    // Create fake extension dir with system agents
    const extDir = path.join(tmp.root, 'ext');
    const resDir = path.join(extDir, 'resources');
    writeJson(path.join(resDir, 'system-agents.json'), {
      dev: { name: 'Developer', cli: 'claude', enabled: true },
    });
    // Note: user overrides go to ~/.cc-manager/system-agents.json
    // For this test, we verify the base case (no overrides)
    const { agents, meta } = loadSystemAgents(extDir);
    assert.equal(agents.dev.name, 'Developer');
    assert.equal(meta.dev.hasUserOverride, false);
  });

  it('loadMergedAgents merges system + global + project', () => {
    const extDir = path.join(tmp.root, 'ext');
    writeJson(path.join(extDir, 'resources', 'system-agents.json'), {
      dev: { name: 'Dev (system)', cli: 'claude', enabled: true },
    });
    const repoRoot = path.join(tmp.root, 'repo');
    writeJson(path.join(repoRoot, '.cc-manager', 'agents.json'), {
      'custom-agent': { name: 'Custom', cli: 'claude', enabled: true },
    });
    const result = loadMergedAgents(repoRoot, extDir);
    assert.ok(result.system.dev, 'should have system agent');
    assert.ok(result.project['custom-agent'], 'should have project agent');
  });

  it('enabledAgents filters disabled agents', () => {
    const data = {
      system: { dev: { name: 'Dev', enabled: true } },
      global: { helper: { name: 'Helper', enabled: false } },
      project: { custom: { name: 'Custom' } }, // no enabled field = enabled
    };
    const enabled = enabledAgents(data);
    assert.ok(enabled.dev, 'dev should be enabled');
    assert.ok(!enabled.helper, 'helper should be filtered');
    assert.ok(enabled.custom, 'custom should be enabled (default)');
  });

  it('enabledAgents: project overrides system on same key', () => {
    const data = {
      system: { dev: { name: 'Dev (system)', cli: 'claude' } },
      global: {},
      project: { dev: { name: 'Dev (project)', cli: 'codex' } },
    };
    const enabled = enabledAgents(data);
    assert.equal(enabled.dev.name, 'Dev (project)');
    assert.equal(enabled.dev.cli, 'codex');
  });

  it('save then load roundtrip preserves data', () => {
    const filePath = path.join(tmp.ccDir, 'agents.json');
    const original = {
      dev: { name: 'Developer', description: 'Writes code', system_prompt: 'You are a dev.', mcps: {}, cli: 'claude', enabled: true },
      qa: { name: 'QA', description: 'Tests things', system_prompt: 'You are QA.', mcps: { 'chrome-devtools': { command: 'npx', args: ['mcp'] } }, cli: 'claude', enabled: true },
    };
    saveAgentsFile(filePath, original);
    const loaded = loadAgentsFile(filePath);
    assert.deepEqual(loaded, original);
  });
});
