const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { isRemoteCli, injectRemotePort, ensureDesktop, stopInstance } = require('../../src/remote-desktop');
const { buildClaudeArgs } = require('../../src/claude');
const { buildCodexWorkerArgs } = require('../../src/codex-worker');
const { spawnStreamingProcess } = require('../../src/process-utils');
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

describe('Remote agent utilities', () => {
  it('isRemoteCli identifies remote CLIs', () => {
    assert.equal(isRemoteCli('qa-remote-claude'), true);
    assert.equal(isRemoteCli('qa-remote-codex'), true);
    assert.equal(isRemoteCli('claude'), false);
    assert.equal(isRemoteCli('codex'), false);
    assert.equal(isRemoteCli(null), false);
    assert.equal(isRemoteCli(undefined), false);
  });

  it('injectRemotePort adds --remote-port and --remote-cwd for qa-remote-claude', () => {
    const args = ['exec', '--cd', '/test', '-p'];
    const desktop = { apiPort: 8080, name: 'test', vncPort: 5900, novncPort: 6080 };
    const result = injectRemotePort('qa-remote-claude', args, desktop);
    assert.ok(Array.isArray(result), 'should return array');
    const joined = result.join(' ');
    assert.ok(joined.includes('--remote-port=8080'), 'should have --remote-port');
    assert.ok(joined.includes('--remote-cwd=/workspace'), 'should have --remote-cwd');
  });

  it('injectRemotePort adds --remote-port and --remote-cwd for qa-remote-codex', () => {
    const args = ['exec', '--cd', '/test'];
    const desktop = { apiPort: 9090, name: 'test', vncPort: 5900, novncPort: 6080 };
    const result = injectRemotePort('qa-remote-codex', args, desktop);
    assert.ok(Array.isArray(result));
    const joined = result.join(' ');
    assert.ok(joined.includes('--remote-port=9090'));
    assert.ok(joined.includes('--remote-cwd=/workspace'));
  });

  it('injectRemotePort returns args unchanged for non-remote CLI', () => {
    const args = ['-p', '--output-format', 'stream-json'];
    const desktop = { apiPort: 8080 };
    const result = injectRemotePort('claude', args, desktop);
    assert.deepEqual(result, args, 'should return args unchanged');
  });
});

// ── Live: qa-remote-claude as plain worker (no MCPs) ─────────────

describe('qa-remote-claude plain worker (live)', { timeout: 300000 }, () => {
  it('responds to a simple prompt inside container', async (t) => {
    if (await skipIfMissing(t, 'qa-desktop')) return;
    if (await skipIfMissing(t, 'qa-remote-claude')) return;

    const panelId = 'test-remote-claude-plain-' + Date.now();
    const desktop = await ensureDesktop(tmp.root, panelId);
    if (!desktop) { t.skip('Could not start container'); return; }
    startedInstance = desktop.name;

    const manifest = {
      repoRoot: tmp.root, extensionDir: EXTENSION_DIR, chromeDebugPort: null,
      files: {}, controller: { cli: 'codex' },
      worker: {
        cli: 'qa-remote-claude', model: null, sessionId: crypto.randomUUID(),
        hasStarted: false, allowedTools: null, tools: null, disallowedTools: null,
        permissionPromptTool: null, maxTurns: 1, maxBudgetUsd: null,
        addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {},
      },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
      agents: {}, settings: {},
    };

    const agentConfig = {
      system_prompt: 'You are a test agent. Respond briefly.',
      mcps: {},
      cli: 'qa-remote-claude',
    };
    let args = buildClaudeArgs(manifest, { prompt: 'test', agentConfig });
    args = injectRemotePort('qa-remote-claude', args, desktop);

    let resultText = '';
    await spawnStreamingProcess({
      command: 'qa-remote-claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say exactly: REMOTE_CLAUDE_PLAIN_OK',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') resultText = evt.result || '';
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(resultText.length > 0, 'qa-remote-claude should respond');
    assert.ok(resultText.includes('REMOTE_CLAUDE_PLAIN_OK'),
      'response should contain requested text. Got: ' + resultText.slice(0, 200));
  });
});

// ── Live: qa-remote-codex as plain worker (no MCPs) ──────────────

describe('qa-remote-codex plain worker (live)', { timeout: 300000 }, () => {
  it('responds to a simple prompt inside container', async (t) => {
    if (await skipIfMissing(t, 'qa-desktop')) return;
    if (await skipIfMissing(t, 'qa-remote-codex')) return;

    const panelId = 'test-remote-codex-plain-' + Date.now();
    const desktop = await ensureDesktop(tmp.root, panelId);
    if (!desktop) { t.skip('Could not start container'); return; }
    startedInstance = desktop.name;

    const manifest = {
      repoRoot: tmp.root, extensionDir: EXTENSION_DIR, chromeDebugPort: null,
      files: {},
      controller: { cli: 'codex' },
      worker: {
        cli: 'qa-remote-codex', bin: 'qa-remote-codex', model: null,
        sessionId: crypto.randomUUID(), hasStarted: false,
        allowedTools: null, tools: null, disallowedTools: null,
        permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null,
        addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {},
      },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
      agents: {}, settings: {},
    };

    const workerRecord = {
      promptFile: path.join(tmp.ccDir, 'test-prompt.txt'),
      stdoutFile: path.join(tmp.ccDir, 'test-stdout.log'),
      stderrFile: path.join(tmp.ccDir, 'test-stderr.log'),
      finalFile: path.join(tmp.ccDir, 'test-final.json'),
    };

    let args = buildCodexWorkerArgs(manifest, workerRecord, { agentConfig: null, agentSession: null });
    args = injectRemotePort('qa-remote-codex', args, desktop);

    let stdout = '';
    await spawnStreamingProcess({
      command: 'qa-remote-codex',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say exactly: REMOTE_CODEX_PLAIN_OK',
      onStdoutLine: (line) => { stdout += line + '\n'; },
      onStderrLine: () => {},
    });

    assert.ok(stdout.length > 0, 'qa-remote-codex should produce output');
  });
});

// ── Live: qa-remote-codex with MCPs inside container ─────────────

describe('qa-remote-codex + MCPs inside container (live)', { timeout: 300000 }, () => {
  it('qa-remote-codex can use detached-command MCP', async (t) => {
    if (await skipIfMissing(t, 'qa-desktop')) return;
    if (await skipIfMissing(t, 'qa-remote-codex')) return;

    const panelId = 'test-remote-codex-mcp-' + Date.now();
    const desktop = await ensureDesktop(tmp.root, panelId);
    if (!desktop) { t.skip('Could not start container'); return; }
    startedInstance = desktop.name;

    const manifest = {
      repoRoot: tmp.root, extensionDir: EXTENSION_DIR, chromeDebugPort: null,
      files: {},
      controller: { cli: 'codex' },
      worker: {
        cli: 'qa-remote-codex', bin: 'qa-remote-codex', model: null,
        sessionId: crypto.randomUUID(), hasStarted: false,
        allowedTools: null, tools: null, disallowedTools: null,
        permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null,
        addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {},
      },
      mcpServers: {},
      workerMcpServers: {
        'detached-command': {
          command: 'node',
          args: ['/opt/detached-command-mcp/dist/index.js'],
          env: {
            DETACHED_BASH_MCP_DATA_DIR: '/workspace/.qpanda/.detached-jobs',
            DETACHED_COMMAND_INSTANCE_ID: 'codex-remote-test-' + Date.now(),
          },
        },
      },
      controllerMcpServers: null,
      agents: {}, settings: {},
    };

    const workerRecord = {
      promptFile: path.join(tmp.ccDir, 'test-prompt.txt'),
      stdoutFile: path.join(tmp.ccDir, 'test-stdout.log'),
      stderrFile: path.join(tmp.ccDir, 'test-stderr.log'),
      finalFile: path.join(tmp.ccDir, 'test-final.json'),
    };

    let args = buildCodexWorkerArgs(manifest, workerRecord, { agentConfig: null, agentSession: null });
    args = injectRemotePort('qa-remote-codex', args, desktop);

    let stdout = '';
    await spawnStreamingProcess({
      command: 'qa-remote-codex',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Use the detached_command start_command tool to run "echo REMOTE_CODEX_MCP_OK". Then show the result.',
      onStdoutLine: (line) => { stdout += line + '\n'; },
      onStderrLine: () => {},
    });

    assert.ok(stdout.length > 0, 'qa-remote-codex should produce output with MCP');
  });
});
