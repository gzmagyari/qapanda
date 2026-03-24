const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lookupAgentConfig } = require('../../src/state');

describe('lookupAgentConfig', () => {
  const agents = {
    dev: { name: 'Developer', cli: 'claude' },
    QA: { name: 'QA Engineer (Computer)', cli: 'qa-remote-claude' },
    'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'claude' },
  };

  it('finds agent by exact ID', () => {
    const result = lookupAgentConfig(agents, 'dev');
    assert.equal(result.name, 'Developer');
  });

  it('finds agent case-insensitively', () => {
    const result = lookupAgentConfig(agents, 'DEV');
    assert.equal(result.name, 'Developer');
  });

  it('finds QA agent case-insensitively', () => {
    const result = lookupAgentConfig(agents, 'qa');
    assert.equal(result.name, 'QA Engineer (Computer)');
  });

  it('finds QA-Browser by exact ID', () => {
    const result = lookupAgentConfig(agents, 'QA-Browser');
    assert.equal(result.name, 'QA Engineer (Browser)');
  });

  it('returns null for unknown agent', () => {
    const result = lookupAgentConfig(agents, 'nonexistent');
    assert.equal(result, null);
  });

  it('returns null for null agents', () => {
    assert.equal(lookupAgentConfig(null, 'dev'), null);
  });

  it('returns null for null agentId', () => {
    assert.equal(lookupAgentConfig(agents, null), null);
  });

  it('returns null for empty agentId', () => {
    assert.equal(lookupAgentConfig(agents, ''), null);
  });
});

describe('agent/mode/MCP merging logic', () => {
  // Test the merge patterns used in agents-store.js and modes-store.js
  // These are the same patterns that will be extracted to config-loader.js

  it('project overrides global on same key', () => {
    const global = { dev: { name: 'Dev (global)', cli: 'claude' } };
    const project = { dev: { name: 'Dev (project)', cli: 'codex' } };
    const merged = { ...global, ...project };
    assert.equal(merged.dev.name, 'Dev (project)');
    assert.equal(merged.dev.cli, 'codex');
  });

  it('global and project keys combine', () => {
    const global = { dev: { name: 'Developer' } };
    const project = { qa: { name: 'QA' } };
    const merged = { ...global, ...project };
    assert.ok(merged.dev, 'should have global key');
    assert.ok(merged.qa, 'should have project key');
  });

  it('system + global + project merge (project wins)', () => {
    const system = { dev: { name: 'Dev (sys)', priority: 1 } };
    const global = { dev: { name: 'Dev (global)', priority: 2 }, extra: { name: 'Extra' } };
    const project = { dev: { name: 'Dev (proj)', priority: 3 } };
    const merged = { ...system, ...global, ...project };
    assert.equal(merged.dev.name, 'Dev (proj)');
    assert.equal(merged.dev.priority, 3);
    assert.ok(merged.extra, 'should keep global-only keys');
  });

  it('disabled agents are filtered', () => {
    const agents = {
      dev: { name: 'Dev', enabled: true },
      qa: { name: 'QA', enabled: false },
      setup: { name: 'Setup' }, // no enabled field = enabled by default
    };
    const enabled = {};
    for (const [id, agent] of Object.entries(agents)) {
      if (agent.enabled !== false) enabled[id] = agent;
    }
    assert.ok(enabled.dev, 'dev should be enabled');
    assert.ok(!enabled.qa, 'qa should be filtered out');
    assert.ok(enabled.setup, 'setup (no field) should be enabled');
  });

  it('MCP target filtering', () => {
    const mcps = {
      'mcp-both': { command: 'node', args: ['a.js'], target: 'both' },
      'mcp-controller': { command: 'node', args: ['b.js'], target: 'controller' },
      'mcp-worker': { command: 'node', args: ['c.js'], target: 'worker' },
      'mcp-none': { command: 'node', args: ['d.js'], target: 'none' },
      'mcp-default': { command: 'node', args: ['e.js'] }, // no target = both
    };

    const forController = {};
    const forWorker = {};
    for (const [name, server] of Object.entries(mcps)) {
      const target = server.target || 'both';
      if (target === 'none') continue;
      if (target === 'both' || target === 'controller') forController[name] = server;
      if (target === 'both' || target === 'worker') forWorker[name] = server;
    }

    assert.ok(forController['mcp-both'], 'controller should have both');
    assert.ok(forController['mcp-controller'], 'controller should have controller-only');
    assert.ok(!forController['mcp-worker'], 'controller should NOT have worker-only');
    assert.ok(!forController['mcp-none'], 'controller should NOT have none');
    assert.ok(forController['mcp-default'], 'controller should have default (both)');

    assert.ok(forWorker['mcp-both'], 'worker should have both');
    assert.ok(!forWorker['mcp-controller'], 'worker should NOT have controller-only');
    assert.ok(forWorker['mcp-worker'], 'worker should have worker-only');
    assert.ok(forWorker['mcp-default'], 'worker should have default (both)');
  });
});
