const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadSystemModes, enabledModes } = require('../../extension/modes-store');
const { loadSystemAgents, enabledAgents } = require('../../extension/agents-store');
const { EXTENSION_DIR } = require('../helpers/live-test-utils');

const { modes: systemModes } = loadSystemModes(EXTENSION_DIR);
const { agents: systemAgents } = loadSystemAgents(EXTENSION_DIR);
const allModes = enabledModes({ system: systemModes, global: {}, project: {} });
const allAgents = enabledAgents({ system: systemAgents, global: {}, project: {} });

function resolveByEnv(val, env) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val[env] || val['browser'] || Object.values(val)[0];
  }
  return val;
}

describe('mode configuration (system modes)', () => {
  it('has exactly 4 system modes', () => {
    assert.equal(Object.keys(allModes).length, 4);
    assert.ok(allModes['test']);
    assert.ok(allModes['dev']);
    assert.ok(allModes['dev-test']);
    assert.ok(allModes['test-fix']);
  });

  it('test mode: no controller, requires test env', () => {
    const mode = allModes['test'];
    assert.equal(mode.useController, false);
    assert.equal(mode.requiresTestEnv, true);
    assert.equal(mode.category, 'test');
    assert.equal(mode.autoDefault, false);
  });

  it('test mode: QA-Browser for browser, QA for computer', () => {
    const mode = allModes['test'];
    assert.equal(resolveByEnv(mode.defaultAgent, 'browser'), 'QA-Browser');
    assert.equal(resolveByEnv(mode.defaultAgent, 'computer'), 'QA');
  });

  it('dev mode: no controller, no test env', () => {
    const mode = allModes['dev'];
    assert.equal(mode.useController, false);
    assert.equal(mode.requiresTestEnv, false);
    assert.equal(mode.defaultAgent, 'dev');
    assert.equal(mode.category, 'develop');
    assert.equal(mode.autoDefault, false);
  });

  it('dev-test mode: auto default on, requires test env', () => {
    const mode = allModes['dev-test'];
    assert.equal(mode.useController, false);
    assert.equal(mode.requiresTestEnv, true);
    assert.equal(mode.autoDefault, true);
    assert.equal(mode.defaultAgent, 'dev');
  });

  it('dev-test mode: has controller prompt for copilot', () => {
    const mode = allModes['dev-test'];
    const browserPrompt = resolveByEnv(mode.controllerPrompt, 'browser');
    const computerPrompt = resolveByEnv(mode.controllerPrompt, 'computer');
    assert.ok(browserPrompt, 'should have browser prompt');
    assert.ok(computerPrompt, 'should have computer prompt');
  });

  it('test-fix mode: QA agent, auto default on', () => {
    const mode = allModes['test-fix'];
    assert.equal(mode.useController, false);
    assert.equal(mode.requiresTestEnv, true);
    assert.equal(mode.autoDefault, true);
    assert.equal(resolveByEnv(mode.defaultAgent, 'browser'), 'QA-Browser');
    assert.equal(resolveByEnv(mode.defaultAgent, 'computer'), 'QA');
  });

  it('all default agents reference valid agents', () => {
    for (const [id, mode] of Object.entries(allModes)) {
      if (mode.defaultAgent) {
        if (typeof mode.defaultAgent === 'string') {
          assert.ok(allAgents[mode.defaultAgent], `${id} default agent "${mode.defaultAgent}" should exist`);
        } else {
          const browser = resolveByEnv(mode.defaultAgent, 'browser');
          const computer = resolveByEnv(mode.defaultAgent, 'computer');
          if (browser) assert.ok(allAgents[browser], `${id} browser agent "${browser}" should exist`);
          if (computer) assert.ok(allAgents[computer], `${id} computer agent "${computer}" should exist`);
        }
      }
    }
  });

  it('modes with requiresTestEnv have setupAgent', () => {
    for (const [id, mode] of Object.entries(allModes)) {
      if (mode.requiresTestEnv && mode.setupAgent) {
        const browserSetup = resolveByEnv(mode.setupAgent, 'browser');
        const computerSetup = resolveByEnv(mode.setupAgent, 'computer');
        if (browserSetup) assert.ok(allAgents[browserSetup], `${id} browser setup agent "${browserSetup}" should exist`);
        if (computerSetup) assert.ok(allAgents[computerSetup], `${id} computer setup agent "${computerSetup}" should exist`);
      }
    }
  });
});
