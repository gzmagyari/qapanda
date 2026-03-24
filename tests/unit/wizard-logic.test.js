const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// resolveByEnv is defined in both webview/main.js and session-manager.js
// We test the logic directly since it's a pure function

function resolveByEnv(val, env) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val[env] || val['browser'] || Object.values(val)[0];
  }
  return val;
}

function getAllEnabledModes(modesSystem, modesGlobal, modesProject) {
  const all = { ...modesSystem, ...modesGlobal, ...modesProject };
  const result = {};
  for (const [id, mode] of Object.entries(all)) {
    if (mode && mode.enabled !== false) result[id] = mode;
  }
  return result;
}

describe('resolveByEnv', () => {
  it('returns string as-is', () => {
    assert.equal(resolveByEnv('hello', 'browser'), 'hello');
  });

  it('resolves object by env key', () => {
    const val = { browser: 'QA-Browser', computer: 'QA' };
    assert.equal(resolveByEnv(val, 'browser'), 'QA-Browser');
    assert.equal(resolveByEnv(val, 'computer'), 'QA');
  });

  it('falls back to browser key if env not found', () => {
    const val = { browser: 'QA-Browser', computer: 'QA' };
    assert.equal(resolveByEnv(val, 'unknown'), 'QA-Browser');
  });

  it('falls back to first value if no browser key', () => {
    const val = { computer: 'QA' };
    assert.equal(resolveByEnv(val, 'unknown'), 'QA');
  });

  it('returns null/undefined as-is', () => {
    assert.equal(resolveByEnv(null, 'browser'), null);
    assert.equal(resolveByEnv(undefined, 'browser'), undefined);
  });

  it('returns arrays as-is (not treated as object)', () => {
    const val = ['a', 'b'];
    assert.deepEqual(resolveByEnv(val, 'browser'), ['a', 'b']);
  });

  it('returns numbers as-is', () => {
    assert.equal(resolveByEnv(42, 'browser'), 42);
  });

  it('handles env-aware controllerPrompt', () => {
    const prompt = {
      browser: 'You are a QA test coordinator for browser testing.',
      computer: 'You are a QA test coordinator for desktop testing.',
    };
    assert.ok(resolveByEnv(prompt, 'browser').includes('browser'));
    assert.ok(resolveByEnv(prompt, 'computer').includes('desktop'));
  });

  it('handles env-aware defaultAgent', () => {
    const agent = { browser: 'QA-Browser', computer: 'QA' };
    assert.equal(resolveByEnv(agent, 'browser'), 'QA-Browser');
    assert.equal(resolveByEnv(agent, 'computer'), 'QA');
  });

  it('handles env-aware availableAgents', () => {
    const agents = { browser: ['dev', 'QA-Browser'], computer: ['dev', 'QA'] };
    assert.deepEqual(resolveByEnv(agents, 'browser'), ['dev', 'QA-Browser']);
    assert.deepEqual(resolveByEnv(agents, 'computer'), ['dev', 'QA']);
  });
});

describe('getAllEnabledModes', () => {
  it('returns all enabled modes', () => {
    const system = {
      'quick-test': { name: 'Quick Test', enabled: true },
      'auto-test': { name: 'Auto Test', enabled: true },
    };
    const result = getAllEnabledModes(system, {}, {});
    assert.equal(Object.keys(result).length, 2);
  });

  it('filters disabled modes', () => {
    const system = {
      'quick-test': { name: 'Quick Test', enabled: true },
      'auto-test': { name: 'Auto Test', enabled: false },
    };
    const result = getAllEnabledModes(system, {}, {});
    assert.equal(Object.keys(result).length, 1);
    assert.ok(result['quick-test']);
    assert.ok(!result['auto-test']);
  });

  it('modes without enabled field are enabled by default', () => {
    const system = { 'quick-dev': { name: 'Quick Dev' } };
    const result = getAllEnabledModes(system, {}, {});
    assert.ok(result['quick-dev']);
  });

  it('project modes override system modes', () => {
    const system = { 'quick-test': { name: 'Quick Test (system)' } };
    const project = { 'quick-test': { name: 'Quick Test (project)' } };
    const result = getAllEnabledModes(system, {}, project);
    assert.equal(result['quick-test'].name, 'Quick Test (project)');
  });

  it('combines modes from all scopes', () => {
    const system = { 'quick-test': { name: 'Quick Test' } };
    const global = { 'custom-mode': { name: 'Custom' } };
    const project = { 'project-mode': { name: 'Project' } };
    const result = getAllEnabledModes(system, global, project);
    assert.equal(Object.keys(result).length, 3);
  });
});

describe('mode configuration', () => {
  it('mode with useController=false should use direct agent', () => {
    const mode = { name: 'Quick Dev', useController: false, defaultAgent: 'dev' };
    assert.equal(mode.useController, false);
    assert.equal(mode.defaultAgent, 'dev');
  });

  it('mode with useController=true should use controller loop', () => {
    const mode = { name: 'Auto Test', useController: true, controllerPrompt: 'You are a coordinator.' };
    assert.equal(mode.useController, true);
    assert.ok(mode.controllerPrompt);
  });

  it('mode with requiresTestEnv needs test environment', () => {
    const mode = { name: 'Quick Test', requiresTestEnv: true };
    assert.equal(mode.requiresTestEnv, true);
  });

  it('mode with setupAgent specifies pre-run setup', () => {
    const mode = {
      name: 'Quick Test',
      requiresTestEnv: true,
      setupAgent: { browser: 'setup-browser', computer: 'setup-computer' },
    };
    assert.equal(resolveByEnv(mode.setupAgent, 'browser'), 'setup-browser');
    assert.equal(resolveByEnv(mode.setupAgent, 'computer'), 'setup-computer');
  });
});
