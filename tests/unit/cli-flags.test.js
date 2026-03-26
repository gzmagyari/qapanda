const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs, normalizeOptions, loadConfig, applyConfigToOptions } = require('../../src/cli');

const PROJECT_ROOT = path.resolve(__dirname, '../..');

const RUN_SPEC = {
  'mode': { key: 'mode', kind: 'value' },
  'agent': { key: 'agent', kind: 'value' },
  'test-env': { key: 'testEnv', kind: 'value' },
  'print': { key: 'print', kind: 'boolean' },
  'no-mcp-inject': { key: 'noMcpInject', kind: 'boolean' },
  'controller-cli': { key: 'controllerCli', kind: 'value' },
  'controller-model': { key: 'controllerModel', kind: 'value' },
  'controller-thinking': { key: 'controllerThinking', kind: 'value' },
  'worker-cli': { key: 'workerCli', kind: 'value' },
  'worker-model': { key: 'workerModel', kind: 'value' },
  'worker-thinking': { key: 'workerThinking', kind: 'value' },
  'wait': { key: 'wait', kind: 'value' },
  'raw-events': { key: 'rawEvents', kind: 'boolean' },
  'quiet': { key: 'quiet', kind: 'boolean' },
};

describe('CLI flag parsing', () => {
  it('parses --mode flag', () => {
    const { options } = parseArgs(['--mode', 'dev'], RUN_SPEC);
    assert.equal(options.mode, 'dev');
  });

  it('parses --agent flag', () => {
    const { options } = parseArgs(['--agent', 'dev'], RUN_SPEC);
    assert.equal(options.agent, 'dev');
  });

  it('parses --test-env flag', () => {
    const { options } = parseArgs(['--test-env', 'browser'], RUN_SPEC);
    assert.equal(options.testEnv, 'browser');
  });

  it('parses --print flag', () => {
    const { options } = parseArgs(['--print'], RUN_SPEC);
    assert.equal(options.print, true);
  });

  it('parses --controller-cli flag', () => {
    const { options } = parseArgs(['--controller-cli', 'claude'], RUN_SPEC);
    assert.equal(options.controllerCli, 'claude');
  });

  it('parses --controller-thinking flag', () => {
    const { options } = parseArgs(['--controller-thinking', 'high'], RUN_SPEC);
    assert.equal(options.controllerThinking, 'high');
  });

  it('parses --worker-thinking flag', () => {
    const { options } = parseArgs(['--worker-thinking', 'medium'], RUN_SPEC);
    assert.equal(options.workerThinking, 'medium');
  });

  it('parses --wait flag', () => {
    const { options } = parseArgs(['--wait', '5m'], RUN_SPEC);
    assert.equal(options.wait, '5m');
  });

  it('parses --no-mcp-inject flag', () => {
    const { options } = parseArgs(['--no-mcp-inject'], RUN_SPEC);
    assert.equal(options.noMcpInject, true);
  });

  it('parses combination of flags + positional', () => {
    const { options, positionals } = parseArgs(['--mode', 'dev', '--print', '--agent', 'dev', 'hello world'], RUN_SPEC);
    assert.equal(options.mode, 'dev');
    assert.equal(options.print, true);
    assert.equal(options.agent, 'dev');
    assert.deepEqual(positionals, ['hello world']);
  });

  it('throws on unknown flag', () => {
    assert.throws(() => parseArgs(['--unknown-flag', 'val'], RUN_SPEC), /Unknown option/);
  });
});

describe('loadConfig', () => {
  it('loads agents, modes, and MCP data', () => {
    const config = loadConfig(PROJECT_ROOT);
    assert.ok(config.allAgents, 'should have agents');
    assert.ok(config.allAgents.dev, 'should have dev agent');
    assert.ok(config.allModes, 'should have modes');
    assert.ok(config.allModes['dev'], 'should have dev mode');
    assert.ok(config.defaults, 'should have defaults');
  });
});

describe('applyConfigToOptions', () => {
  it('applies onboarding defaults when no CLI specified', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT };
    const { options: enriched } = applyConfigToOptions(options, config);
    assert.ok(enriched.controllerCli, 'should set controller CLI from defaults');
    assert.ok(enriched.workerCli, 'should set worker CLI from defaults');
  });

  it('--mode dev sets direct agent to dev', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, mode: 'dev' };
    const { directAgent } = applyConfigToOptions(options, config);
    assert.equal(directAgent, 'dev');
  });

  it('--mode dev-test sets dev as direct agent (with auto default)', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, mode: 'dev-test', testEnv: 'browser' };
    const { directAgent } = applyConfigToOptions(options, config);
    assert.equal(directAgent, 'dev');
  });

  it('--mode test with --test-env browser sets QA-Browser agent', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, mode: 'test', testEnv: 'browser' };
    const { directAgent } = applyConfigToOptions(options, config);
    assert.equal(directAgent, 'QA-Browser');
  });

  it('--mode test with --test-env computer sets QA agent', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, mode: 'test', testEnv: 'computer' };
    const { directAgent } = applyConfigToOptions(options, config);
    assert.equal(directAgent, 'QA');
  });

  it('--agent overrides mode default agent', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, agent: 'QA-Browser' };
    const { directAgent } = applyConfigToOptions(options, config);
    assert.equal(directAgent, 'QA-Browser');
  });

  it('auto-injects MCPs when no --no-mcp-inject', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT };
    const { options: enriched } = applyConfigToOptions(options, config);
    assert.ok(enriched.workerMcpServers, 'should have worker MCPs');
    assert.ok(enriched.workerMcpServers['detached-command'], 'should have detached-command');
    assert.ok(enriched.workerMcpServers['cc-tasks'], 'should have cc-tasks');
    assert.ok(enriched.controllerMcpServers, 'should have controller MCPs');
  });

  it('--no-mcp-inject skips MCP injection', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, noMcpInject: true };
    const { options: enriched } = applyConfigToOptions(options, config);
    assert.ok(!enriched.workerMcpServers);
    assert.ok(!enriched.controllerMcpServers);
  });

  it('loads all agents into manifest', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT };
    const { options: enriched } = applyConfigToOptions(options, config);
    assert.ok(enriched.agents.dev, 'manifest should have dev agent');
    assert.ok(enriched.agents.QA, 'manifest should have QA agent');
  });

  it('throws on unknown mode', () => {
    const config = loadConfig(PROJECT_ROOT);
    const options = { repoRoot: PROJECT_ROOT, mode: 'nonexistent-mode' };
    assert.throws(() => applyConfigToOptions(options, config), /Unknown mode/);
  });
});
