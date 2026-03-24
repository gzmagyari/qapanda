const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
  it('quick-test mode: no controller, requires test env', () => {
    const mode = allModes['quick-test'];
    assert.ok(mode, 'quick-test should exist');
    assert.equal(mode.useController, false);
    assert.equal(mode.requiresTestEnv, true);
    assert.equal(mode.category, 'test');
  });

  it('quick-test browser: uses QA-Browser agent', () => {
    const mode = allModes['quick-test'];
    const agent = resolveByEnv(mode.defaultAgent, 'browser');
    assert.equal(agent, 'QA-Browser');
    assert.ok(allAgents[agent], 'QA-Browser agent should exist');
  });

  it('quick-test computer: uses QA agent', () => {
    const mode = allModes['quick-test'];
    const agent = resolveByEnv(mode.defaultAgent, 'computer');
    assert.equal(agent, 'QA');
    assert.ok(allAgents[agent], 'QA agent should exist');
  });

  it('auto-test mode: uses controller, requires test env', () => {
    const mode = allModes['auto-test'];
    assert.ok(mode, 'auto-test should exist');
    assert.equal(mode.useController, true);
    assert.equal(mode.requiresTestEnv, true);
  });

  it('auto-test has env-aware controller prompt', () => {
    const mode = allModes['auto-test'];
    const browserPrompt = resolveByEnv(mode.controllerPrompt, 'browser');
    const computerPrompt = resolveByEnv(mode.controllerPrompt, 'computer');
    assert.ok(browserPrompt, 'should have browser prompt');
    assert.ok(computerPrompt, 'should have computer prompt');
    assert.ok(browserPrompt.includes('QA-Browser') || browserPrompt.includes('QA'), 'browser prompt should reference browser agent');
  });

  it('quick-dev mode: no controller, no test env', () => {
    const mode = allModes['quick-dev'];
    assert.ok(mode, 'quick-dev should exist');
    assert.equal(mode.useController, false);
    assert.equal(mode.requiresTestEnv, false);
    assert.equal(mode.defaultAgent, 'dev');
    assert.equal(mode.category, 'develop');
  });

  it('auto-dev mode: uses controller, no test env', () => {
    const mode = allModes['auto-dev'];
    assert.ok(mode, 'auto-dev should exist');
    assert.equal(mode.useController, true);
    assert.equal(mode.requiresTestEnv, false);
    assert.ok(mode.controllerPrompt, 'should have controller prompt');
  });

  it('auto-dev-test mode: uses controller, requires test env', () => {
    const mode = allModes['auto-dev-test'];
    assert.ok(mode, 'auto-dev-test should exist');
    assert.equal(mode.useController, true);
    assert.equal(mode.requiresTestEnv, true);
  });

  it('auto-dev-test has both dev and QA agents available', () => {
    const mode = allModes['auto-dev-test'];
    const browserAgents = resolveByEnv(mode.availableAgents, 'browser');
    const computerAgents = resolveByEnv(mode.availableAgents, 'computer');
    assert.ok(Array.isArray(browserAgents));
    assert.ok(Array.isArray(computerAgents));
    assert.ok(browserAgents.includes('dev'), 'browser should have dev agent');
    assert.ok(computerAgents.includes('dev'), 'computer should have dev agent');
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

  it('all default agents reference valid agents', () => {
    for (const [id, mode] of Object.entries(allModes)) {
      if (mode.defaultAgent) {
        const browserAgent = resolveByEnv(mode.defaultAgent, 'browser');
        const computerAgent = resolveByEnv(mode.defaultAgent, 'computer');
        if (typeof mode.defaultAgent === 'string') {
          assert.ok(allAgents[mode.defaultAgent], `${id} default agent "${mode.defaultAgent}" should exist`);
        } else {
          if (browserAgent) assert.ok(allAgents[browserAgent], `${id} browser agent "${browserAgent}" should exist`);
          if (computerAgent) assert.ok(allAgents[computerAgent], `${id} computer agent "${computerAgent}" should exist`);
        }
      }
    }
  });

  it('all available agents reference valid agents', () => {
    for (const [id, mode] of Object.entries(allModes)) {
      if (mode.availableAgents) {
        const browserAgents = resolveByEnv(mode.availableAgents, 'browser') || [];
        const computerAgents = resolveByEnv(mode.availableAgents, 'computer') || [];
        for (const agentId of [...browserAgents, ...computerAgents]) {
          assert.ok(allAgents[agentId], `${id} available agent "${agentId}" should exist`);
        }
      }
    }
  });
});
