const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, writeJson, readJson } = require('../helpers/test-utils');
const {
  findResourcesDir,
  loadSystemAgents,
  loadMergedAgents,
  loadSystemModes,
  loadMergedModes,
  loadMergedMcpServers,
  enabledAgents,
  enabledModes,
  resolveByEnv,
  getCliDefaults,
} = require('../../src/config-loader');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const RESOURCES_DIR = path.join(PROJECT_ROOT, 'resources');

describe('findResourcesDir', () => {
  it('finds resources/ at project root', () => {
    const dir = findResourcesDir();
    assert.ok(dir, 'should find resources dir');
    assert.ok(dir.endsWith('resources') || dir.includes('resources'));
  });

  it('accepts a hint path', () => {
    const dir = findResourcesDir(RESOURCES_DIR);
    assert.equal(dir, RESOURCES_DIR);
  });
});

describe('loadSystemAgents from shared resources', () => {
  it('loads bundled system agents', () => {
    const { agents, meta } = loadSystemAgents(RESOURCES_DIR);
    assert.ok(agents.dev, 'should have dev agent');
    assert.ok(agents.QA, 'should have QA agent');
    assert.ok(agents['QA-Browser'], 'should have QA-Browser');
    assert.ok(meta.dev, 'should have metadata');
  });
});

describe('loadSystemModes from shared resources', () => {
  it('loads bundled system modes', () => {
    const { modes } = loadSystemModes(RESOURCES_DIR);
    assert.ok(modes['quick-test'], 'should have quick-test');
    assert.ok(modes['quick-dev'], 'should have quick-dev');
    assert.ok(modes['auto-dev'], 'should have auto-dev');
  });
});

describe('loadMergedAgents', () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  it('merges system + project agents', () => {
    writeJson(path.join(tmp.root, '.cc-manager', 'agents.json'), {
      'custom-agent': { name: 'Custom', cli: 'claude', enabled: true },
    });
    const data = loadMergedAgents(tmp.root, RESOURCES_DIR);
    assert.ok(data.system.dev, 'should have system dev');
    assert.ok(data.project['custom-agent'], 'should have project custom agent');
  });
});

describe('loadMergedModes', () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  it('merges system + project modes', () => {
    writeJson(path.join(tmp.root, '.cc-manager', 'modes.json'), {
      'custom-mode': { name: 'Custom', category: 'custom', useController: false, requiresTestEnv: false, enabled: true },
    });
    const data = loadMergedModes(tmp.root, RESOURCES_DIR);
    assert.ok(data.system['quick-test'], 'should have system mode');
    assert.ok(data.project['custom-mode'], 'should have project mode');
  });
});

describe('loadMergedMcpServers', () => {
  let tmp;
  beforeEach(() => { tmp = createTempDir(); });
  afterEach(() => { tmp.cleanup(); });

  it('loads global + project MCP servers', () => {
    writeJson(path.join(tmp.root, '.cc-manager', 'mcp.json'), {
      'my-mcp': { command: 'node', args: ['server.js'], target: 'both' },
    });
    const data = loadMergedMcpServers(tmp.root);
    assert.ok(data.project['my-mcp'], 'should have project MCP');
  });

  it('returns empty objects for missing files', () => {
    const data = loadMergedMcpServers(tmp.root);
    assert.deepEqual(data.global, {});
    assert.deepEqual(data.project, {});
  });
});

describe('enabledAgents', () => {
  it('filters disabled agents', () => {
    const data = {
      system: { dev: { name: 'Dev', enabled: true }, qa: { name: 'QA', enabled: false } },
      global: {},
      project: { custom: { name: 'Custom' } },
    };
    const enabled = enabledAgents(data);
    assert.ok(enabled.dev);
    assert.ok(!enabled.qa);
    assert.ok(enabled.custom);
  });

  it('project overrides system', () => {
    const data = {
      system: { dev: { name: 'Dev System', cli: 'claude' } },
      global: {},
      project: { dev: { name: 'Dev Project', cli: 'codex' } },
    };
    const enabled = enabledAgents(data);
    assert.equal(enabled.dev.name, 'Dev Project');
  });
});

describe('enabledModes', () => {
  it('filters disabled modes', () => {
    const data = {
      system: { 'quick-test': { name: 'QT', enabled: true }, 'disabled': { name: 'Off', enabled: false } },
      global: {},
      project: {},
    };
    const enabled = enabledModes(data);
    assert.ok(enabled['quick-test']);
    assert.ok(!enabled['disabled']);
  });
});

describe('resolveByEnv', () => {
  it('returns string as-is', () => {
    assert.equal(resolveByEnv('dev', 'browser'), 'dev');
  });

  it('resolves env-aware object', () => {
    const val = { browser: 'QA-Browser', computer: 'QA' };
    assert.equal(resolveByEnv(val, 'browser'), 'QA-Browser');
    assert.equal(resolveByEnv(val, 'computer'), 'QA');
  });

  it('falls back to browser for unknown env', () => {
    assert.equal(resolveByEnv({ browser: 'A', computer: 'B' }, 'unknown'), 'A');
  });
});

describe('getCliDefaults', () => {
  it('returns codex/claude defaults when no onboarding', () => {
    const defaults = getCliDefaults();
    assert.ok(defaults.controllerCli);
    assert.ok(defaults.workerCli);
  });
});
