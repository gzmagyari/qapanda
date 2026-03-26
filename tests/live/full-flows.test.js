const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadSystemAgents, enabledAgents } = require('../../extension/agents-store');
const { loadSystemModes, enabledModes } = require('../../extension/modes-store');
const { lookupAgentConfig } = require('../../src/state');
const { buildClaudeArgs } = require('../../src/claude');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { controllerLabelFor, workerLabelFor } = require('../../src/render');
const { skipIfMissing, PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');

const { agents: sysAgents } = loadSystemAgents(EXTENSION_DIR);
const { modes: sysModes } = loadSystemModes(EXTENSION_DIR);
const allAgents = enabledAgents({ system: sysAgents, global: {}, project: {} });
const allModes = enabledModes({ system: sysModes, global: {}, project: {} });

function resolveByEnv(val, env) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val[env] || val['browser'] || Object.values(val)[0];
  }
  return val;
}

describe('End-to-end flow: Dev', { timeout: 60000 }, () => {
  it('complete dev flow: select mode → direct agent → response', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    // Step 1: Select mode
    const mode = allModes['dev'];
    assert.ok(mode);
    assert.equal(mode.useController, false);

    // Step 2: Resolve agent
    const agentId = resolveByEnv(mode.defaultAgent, 'browser');
    assert.equal(agentId, 'dev');
    const agent = allAgents[agentId];
    assert.ok(agent);

    // Step 3: Build args
    const manifest = {
      repoRoot: PROJECT_ROOT, extensionDir: EXTENSION_DIR, chromeDebugPort: null,
      files: {}, controller: { cli: 'codex' },
      worker: { cli: agent.cli || 'claude', model: null, sessionId: require('node:crypto').randomUUID(), hasStarted: false, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: 1, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {} },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null, agents: allAgents, settings: {},
    };
    const args = buildClaudeArgs(manifest, { prompt: 'Say exactly: QUICKDEV_FLOW_OK', agentConfig: agent });

    // Step 4: Run agent
    let resultText = '';
    let sessionId = null;
    await spawnStreamingProcess({
      command: 'claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say exactly: QUICKDEV_FLOW_OK',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') {
            resultText = evt.result || '';
            sessionId = evt.session_id;
          }
        } catch {}
      },
      onStderrLine: () => {},
    });

    // Step 5: Verify
    assert.ok(resultText.includes('QUICKDEV_FLOW_OK'), 'should get expected response');
    assert.ok(sessionId, 'should get session ID');

    // Step 6: Verify label
    const label = workerLabelFor(agent.cli, agent.name);
    assert.equal(label, 'Developer');
  });
});

describe('End-to-end flow: Session restore', () => {
  it('transcript restore produces correct labels', () => {
    // Simulate what happens after a run completes and is restored
    const transcript = [
      { role: 'user', text: 'Fix the bug' },
      { role: 'claude', text: '\n\nI fixed the bug in main.js' },
    ];

    const manifest = {
      worker: { cli: 'claude', agentSessions: { dev: { sessionId: 'sess-1', hasStarted: true } } },
      controller: { cli: 'codex' },
      agents: allAgents,
    };

    // Reconstruct worker label (same logic as reattachRun)
    let agentName = null;
    const sessions = manifest.worker.agentSessions;
    if (sessions) {
      const agId = Object.keys(sessions).find(id => sessions[id] && sessions[id].hasStarted);
      if (agId && manifest.agents && manifest.agents[agId]) {
        agentName = manifest.agents[agId].name;
      }
    }
    const wLabel = workerLabelFor(manifest.worker.cli, agentName);
    const cLabel = controllerLabelFor(manifest.controller.cli);

    // Map transcript
    const messages = transcript.map(entry => {
      if (entry.role === 'user') return { type: 'user', text: entry.text };
      if (entry.role === 'claude') return { type: 'claude', text: (entry.text || '').trim(), label: wLabel };
      if (entry.role === 'controller') return { type: 'controller', text: entry.text, label: cLabel };
      return null;
    }).filter(Boolean);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[1].type, 'claude');
    assert.equal(messages[1].label, 'Developer');
    assert.equal(messages[1].text, 'I fixed the bug in main.js'); // trimmed
  });
});

describe('End-to-end flow: Mode → Agent → MCP chain', () => {
  it('test browser: mode resolves to QA-Browser with chrome-devtools MCP', () => {
    const mode = allModes['test'];
    const agentId = resolveByEnv(mode.defaultAgent, 'browser');
    const agent = allAgents[agentId];

    assert.equal(agentId, 'QA-Browser');
    assert.ok(agent.mcps['chrome-devtools'], 'agent should have chrome-devtools MCP');
    assert.ok(agent.cli === 'claude' || agent.cli === 'codex', 'should use local CLI (claude or codex)');

    // Build args — verify MCP is included
    const manifest = {
      repoRoot: PROJECT_ROOT, extensionDir: EXTENSION_DIR, chromeDebugPort: 9222,
      files: {}, controller: { cli: 'codex' },
      worker: { cli: 'claude', model: null, sessionId: null, hasStarted: false, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: 1, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {} },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null, agents: allAgents, settings: {},
    };
    const args = buildClaudeArgs(manifest, { prompt: 'test', agentConfig: agent });
    const mcpIdx = args.indexOf('--mcp-config');
    assert.ok(mcpIdx >= 0, 'should have --mcp-config');
    const config = JSON.parse(args[mcpIdx + 1]);
    assert.ok(config.mcpServers['chrome-devtools'], 'should include chrome-devtools');
    // Verify port placeholder was replaced
    const cdArgs = config.mcpServers['chrome-devtools'].args;
    assert.ok(cdArgs.some(a => a.includes('9222')), 'should have chrome port');
  });

  it('test computer: mode resolves to QA with remote CLI', () => {
    const mode = allModes['test'];
    const agentId = resolveByEnv(mode.defaultAgent, 'computer');
    const agent = allAgents[agentId];

    assert.equal(agentId, 'QA');
    assert.ok(agent.cli.startsWith('qa-remote-'), `should use remote CLI, got: ${agent.cli}`);
  });

  it('dev-test: dev agent with auto default and copilot prompt', () => {
    const mode = allModes['dev-test'];
    assert.equal(mode.defaultAgent, 'dev');
    assert.equal(mode.autoDefault, true);
    assert.ok(mode.controllerPrompt, 'should have controller prompt for copilot');
    const browserPrompt = resolveByEnv(mode.controllerPrompt, 'browser');
    assert.ok(browserPrompt.includes('dev') || browserPrompt.includes('QA'), 'prompt should reference agents');
  });
});
