const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, writeJson, readJson } = require('../helpers/test-utils');
const { loadModesFile, saveModesFile, loadSystemModes, loadMergedModes, enabledModes } = require('../../extension/modes-store');

let tmp;

beforeEach(() => { tmp = createTempDir(); });
afterEach(() => { tmp.cleanup(); });

describe('modes-store CRUD', () => {
  it('loadModesFile returns empty object for missing file', () => {
    const result = loadModesFile(path.join(tmp.root, 'nonexistent.json'));
    assert.deepEqual(result, {});
  });

  it('saveModesFile creates directories and writes JSON', () => {
    const filePath = path.join(tmp.root, 'sub', 'modes.json');
    const data = { 'test': { name: 'Quick Test', category: 'test' } };
    saveModesFile(filePath, data);
    const loaded = readJson(filePath);
    assert.deepEqual(loaded, data);
  });

  it('loadSystemModes loads bundled modes from extension dir', () => {
    const extDir = path.resolve(__dirname, '../../extension');
    const { modes, meta } = loadSystemModes(extDir);
    assert.ok(modes['test'], 'should have test mode');
    assert.ok(modes['dev'], 'should have dev mode');
    assert.ok(modes['dev-test'], 'should have dev-test mode');
    assert.ok(modes['test-fix'], 'should have test-fix mode');
    assert.equal(Object.keys(modes).length, 4, 'should have exactly 4 system modes');
  });

  it('system modes have required fields', () => {
    const extDir = path.resolve(__dirname, '../../extension');
    const { modes } = loadSystemModes(extDir);
    for (const [id, mode] of Object.entries(modes)) {
      assert.ok(mode.name, `${id} should have name`);
      assert.ok(mode.category, `${id} should have category`);
      assert.ok(typeof mode.useController === 'boolean', `${id} should have useController`);
      assert.ok(typeof mode.requiresTestEnv === 'boolean', `${id} should have requiresTestEnv`);
    }
  });

  it('loadMergedModes merges system + global + project', () => {
    const extDir = path.join(tmp.root, 'ext');
    writeJson(path.join(extDir, 'resources', 'system-modes.json'), {
      'test': { name: 'Quick Test', category: 'test', useController: false, requiresTestEnv: true, enabled: true },
    });
    const repoRoot = path.join(tmp.root, 'repo');
    writeJson(path.join(repoRoot, '.qpanda', 'modes.json'), {
      'custom-mode': { name: 'Custom', category: 'custom', useController: false, requiresTestEnv: false, enabled: true },
    });
    const result = loadMergedModes(repoRoot, extDir);
    assert.ok(result.system['test'], 'should have system mode');
    assert.ok(result.project['custom-mode'], 'should have project mode');
  });

  it('enabledModes filters disabled modes', () => {
    const data = {
      system: {
        'test': { name: 'Quick Test', enabled: true },
        'disabled-mode': { name: 'Disabled', enabled: false },
      },
      global: {},
      project: { 'project-mode': { name: 'Project Mode' } },
    };
    const enabled = enabledModes(data);
    assert.ok(enabled['test']);
    assert.ok(!enabled['disabled-mode']);
    assert.ok(enabled['project-mode']);
  });

  it('enabledModes: project overrides system', () => {
    const data = {
      system: { 'test': { name: 'QT System', category: 'test' } },
      global: {},
      project: { 'test': { name: 'QT Project', category: 'custom' } },
    };
    const enabled = enabledModes(data);
    assert.equal(enabled['test'].name, 'QT Project');
  });

  it('save then load roundtrip', () => {
    const filePath = path.join(tmp.ccDir, 'modes.json');
    const original = {
      'my-mode': {
        name: 'My Mode',
        description: 'A custom mode',
        category: 'test',
        useController: true,
        controllerPrompt: 'You are a coordinator.',
        requiresTestEnv: false,
        enabled: true,
      },
    };
    saveModesFile(filePath, original);
    const loaded = loadModesFile(filePath);
    assert.deepEqual(loaded, original);
  });
});
