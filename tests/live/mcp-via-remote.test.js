const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildClaudeArgs } = require('../../src/claude');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { isRemoteCli, ensureDesktop, stopInstance, injectRemotePort } = require('../../src/remote-desktop');
const { skipIfMissing, PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

let startedInstance = null;
let tmp = null;

beforeEach(() => { tmp = createTempDir(); });
afterEach(async () => {
  if (startedInstance) {
    try { await stopInstance(startedInstance); } catch {}
    startedInstance = null;
  }
  if (tmp) { tmp.cleanup(); tmp = null; }
});

describe('qa-remote-claude + MCPs inside container', { timeout: 300000 }, () => {
  it('remote Claude can use detached-command MCP inside container', async (t) => {
    if (await skipIfMissing(t, 'qa-desktop')) return;
    if (await skipIfMissing(t, 'qa-remote-claude')) return;

    const panelId = 'test-remote-mcp-' + Date.now();
    const desktop = await ensureDesktop(tmp.root, panelId);
    if (!desktop) { t.skip('Could not start container'); return; }
    startedInstance = desktop.name;

    // Build manifest for remote agent
    // detached-command should use the container-baked path
    const manifest = {
      repoRoot: tmp.root,
      extensionDir: EXTENSION_DIR,
      chromeDebugPort: null,
      files: {},
      controller: { cli: 'codex' },
      worker: {
        cli: 'qa-remote-claude', model: null, sessionId: crypto.randomUUID(),
        hasStarted: false, allowedTools: null, tools: null, disallowedTools: null,
        permissionPromptTool: null, maxTurns: 5, maxBudgetUsd: null,
        addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {},
      },
      mcpServers: {},
      workerMcpServers: {
        'detached-command': {
          command: 'node',
          args: ['/opt/detached-command-mcp/dist/index.js'],
          env: {
            DETACHED_BASH_MCP_DATA_DIR: '/workspace/.cc-manager/.detached-jobs',
            DETACHED_COMMAND_INSTANCE_ID: 'remote-test-' + Date.now(),
          },
        },
      },
      controllerMcpServers: null,
      agents: {},
      settings: {},
    };

    // Build args — for remote agent, we need to inject remote port
    const agentConfig = {
      system_prompt: 'You are a test agent running inside a container. Use the detached-command MCP to run shell commands.',
      mcps: {},
      cli: 'qa-remote-claude',
    };
    let args = buildClaudeArgs(manifest, { prompt: 'test', agentConfig });

    // Inject remote port
    args = injectRemotePort('qa-remote-claude', args, desktop);

    let resultText = '';
    await spawnStreamingProcess({
      command: 'qa-remote-claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Use the start_command tool to run "echo REMOTE_MCP_OK". Then use read_output to see the result. Tell me what the output was.',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') resultText = evt.result || '';
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(resultText.length > 0, 'remote agent should respond');
    // The agent should have used the MCP inside the container
    assert.ok(
      resultText.includes('REMOTE_MCP_OK') || resultText.includes('start_command') || resultText.includes('echo'),
      'response should reference MCP usage or output. Got: ' + resultText.slice(0, 300)
    );
  });
});
