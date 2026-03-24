const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildClaudeArgs } = require('../../src/claude');
const { lookupAgentConfig } = require('../../src/state');
const { loadSystemAgents } = require('../../extension/agents-store');
const { PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');

// Load real system agents
const { agents: systemAgents } = loadSystemAgents(EXTENSION_DIR);

describe('agent delegation', () => {
  it('dev agent resolves correctly', () => {
    const agent = lookupAgentConfig(systemAgents, 'dev');
    assert.ok(agent, 'should find dev agent');
    assert.equal(agent.name, 'Developer');
    assert.equal(agent.cli, 'claude');
    assert.ok(agent.system_prompt.includes('software developer'));
  });

  it('QA agent resolves correctly', () => {
    const agent = lookupAgentConfig(systemAgents, 'QA');
    assert.ok(agent, 'should find QA agent');
    assert.equal(agent.name, 'QA Engineer (Computer)');
    assert.equal(agent.cli, 'qa-remote-claude');
  });

  it('QA-Browser agent resolves correctly', () => {
    const agent = lookupAgentConfig(systemAgents, 'QA-Browser');
    assert.ok(agent, 'should find QA-Browser agent');
    assert.equal(agent.name, 'QA Engineer (Browser)');
    assert.ok(agent.mcps['chrome-devtools'], 'should have chrome-devtools MCP');
  });

  it('agent lookup is case-insensitive', () => {
    assert.ok(lookupAgentConfig(systemAgents, 'dev'));
    assert.ok(lookupAgentConfig(systemAgents, 'DEV'));
    assert.ok(lookupAgentConfig(systemAgents, 'qa'));
    assert.ok(lookupAgentConfig(systemAgents, 'Qa'));
  });

  it('buildClaudeArgs uses agent system prompt via --system-prompt', () => {
    const agent = lookupAgentConfig(systemAgents, 'dev');
    const manifest = {
      repoRoot: PROJECT_ROOT, extensionDir: EXTENSION_DIR, chromeDebugPort: null,
      files: {}, controller: { cli: 'codex' },
      worker: { cli: 'claude', model: null, sessionId: 'sess', hasStarted: false, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {} },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null, agents: systemAgents, settings: {},
    };
    const args = buildClaudeArgs(manifest, { prompt: 'test', agentConfig: agent });
    assert.ok(args.includes('--system-prompt'), 'should use --system-prompt for agent');
    const idx = args.indexOf('--system-prompt');
    assert.ok(args[idx + 1].includes('software developer'), 'should contain agent prompt');
  });

  it('QA-Browser agent includes chrome-devtools in MCP config', () => {
    const agent = lookupAgentConfig(systemAgents, 'QA-Browser');
    const manifest = {
      repoRoot: PROJECT_ROOT, extensionDir: EXTENSION_DIR, chromeDebugPort: 9222,
      files: {}, controller: { cli: 'codex' },
      worker: { cli: 'claude', model: null, sessionId: 'sess', hasStarted: false, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {} },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null, agents: systemAgents, settings: {},
    };
    const args = buildClaudeArgs(manifest, { prompt: 'test', agentConfig: agent });
    assert.ok(args.includes('--mcp-config'), 'should include MCP config');
    const idx = args.indexOf('--mcp-config');
    const config = JSON.parse(args[idx + 1]);
    assert.ok(config.mcpServers['chrome-devtools'], 'should have chrome-devtools MCP');
    assert.ok(args.includes('--no-chrome'), 'should disable built-in Chrome');
  });

  it('per-agent sessions are tracked independently', () => {
    const agentSessions = {};

    // Create session for dev agent
    agentSessions['dev'] = { sessionId: 'dev-sess-1', hasStarted: true };

    // Create session for QA-Browser agent
    agentSessions['QA-Browser'] = { sessionId: 'qa-sess-1', hasStarted: false };

    assert.notEqual(agentSessions['dev'].sessionId, agentSessions['QA-Browser'].sessionId);
    assert.equal(agentSessions['dev'].hasStarted, true);
    assert.equal(agentSessions['QA-Browser'].hasStarted, false);
  });

  it('setup agents exist for each env', () => {
    const setupBrowser = lookupAgentConfig(systemAgents, 'setup-browser');
    const setupComputer = lookupAgentConfig(systemAgents, 'setup-computer');
    assert.ok(setupBrowser, 'should have setup-browser agent');
    assert.ok(setupComputer, 'should have setup-computer agent');
    assert.equal(setupBrowser.cli, 'claude');
    assert.equal(setupComputer.cli, 'qa-remote-claude');
  });
});
