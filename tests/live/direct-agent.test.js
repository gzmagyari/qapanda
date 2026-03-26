const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildClaudeArgs } = require('../../src/claude');
const { lookupAgentConfig } = require('../../src/state');
const { loadSystemAgents } = require('../../extension/agents-store');
const { skipIfMissing, PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');
const { spawnStreamingProcess } = require('../../src/process-utils');

const { agents: systemAgents } = loadSystemAgents(EXTENSION_DIR);

function agentManifest(agentConfig) {
  const crypto = require('node:crypto');
  return {
    repoRoot: PROJECT_ROOT, extensionDir: EXTENSION_DIR, chromeDebugPort: null,
    files: {}, controller: { cli: 'codex' },
    worker: { cli: agentConfig.cli || 'claude', model: null, sessionId: crypto.randomUUID(), hasStarted: false, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: 1, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {} },
    mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
    agents: systemAgents, settings: {},
  };
}

describe('direct agent mode (no controller)', { timeout: 60000 }, () => {
  it('dev agent responds directly to a prompt', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const agent = lookupAgentConfig(systemAgents, 'dev');
    const manifest = agentManifest(agent);
    const args = buildClaudeArgs(manifest, { prompt: 'Say exactly: DEV_DIRECT_OK', agentConfig: agent });

    let resultText = '';
    await spawnStreamingProcess({
      command: 'claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say exactly: DEV_DIRECT_OK',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') resultText = evt.result || '';
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(resultText.length > 0, 'dev agent should respond');
    assert.ok(resultText.includes('DEV_DIRECT_OK'), 'should contain requested text');
  });

  it('direct mode skips controller entirely', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const agent = lookupAgentConfig(systemAgents, 'dev');
    const manifest = agentManifest(agent);
    const args = buildClaudeArgs(manifest, { prompt: 'Say hi', agentConfig: agent });

    // In direct mode, we don't spawn a controller at all
    // We just spawn the worker with the agent config
    // Verify the args don't include any controller-specific flags
    assert.ok(!args.includes('--output-schema'), 'should not have controller schema');
    assert.ok(args.includes('-p'), 'should have print mode flag');
    assert.ok(args.includes('--system-prompt'), 'should have agent system prompt');
  });

  it('agent-specific CLI is used for remote agents', () => {
    const qaAgent = lookupAgentConfig(systemAgents, 'QA');
    // CLI may be qa-remote-claude or qa-remote-codex depending on user config
    assert.ok(qaAgent.cli.startsWith('qa-remote-'), `QA CLI should be qa-remote-*, got: ${qaAgent.cli}`);
  });
});
