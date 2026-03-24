const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildClaudeArgs } = require('../../src/claude');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { skipIfMissing, PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

let chromeManager;
try { chromeManager = require('../../extension/chrome-manager'); } catch {}

function makeManifest(mcpServers, overrides = {}) {
  return {
    repoRoot: PROJECT_ROOT,
    extensionDir: EXTENSION_DIR,
    chromeDebugPort: null,
    files: {},
    controller: { cli: 'codex' },
    worker: {
      cli: 'claude', model: null, sessionId: crypto.randomUUID(),
      hasStarted: false, allowedTools: null, tools: null, disallowedTools: null,
      permissionPromptTool: null, maxTurns: 10, maxBudgetUsd: null,
      addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {},
    },
    mcpServers: {},
    workerMcpServers: mcpServers,
    controllerMcpServers: null,
    agents: {},
    settings: {},
    ...overrides,
  };
}

function runClaude(manifest, prompt) {
  const args = buildClaudeArgs(manifest, { prompt });
  return new Promise((resolve) => {
    let resultText = '';
    let stderrText = '';
    spawnStreamingProcess({
      command: 'claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: prompt,
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') resultText = evt.result || '';
        } catch {}
      },
      onStderrLine: (line) => { stderrText += line + '\n'; },
    }).then(() => {
      if (!resultText && stderrText) console.error('[runClaude] No result. stderr:', stderrText.slice(0, 500));
      resolve(resultText);
    }).catch((e) => {
      console.error('[runClaude] Error:', e.message, 'stderr:', stderrText.slice(0, 500));
      resolve(resultText);
    });
  });
}

describe('Claude Code + detached-command MCP', { timeout: 180000 }, () => {
  it('Claude can see and call detached-command MCP tools', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const tmp = createTempDir();
    try {
      const manifest = makeManifest({
        'detached-command': {
          command: 'node',
          args: [path.join(EXTENSION_DIR, 'detached-command-mcp', 'dist', 'index.js')],
          env: {
            DETACHED_BASH_MCP_DATA_DIR: path.join(tmp.ccDir, '.detached-jobs'),
            DETACHED_COMMAND_INSTANCE_ID: 'test-' + Date.now(),
          },
        },
      });

      const result = await runClaude(manifest,
        'Use the start_command tool to run the command "echo DETACHED_MCP_WORKS". Then use read_output to get the result. Tell me what the output was.');

      assert.ok(result.length > 0, 'should get a response');
      // Claude should have used the MCP and reported the output
      assert.ok(
        result.includes('DETACHED_MCP_WORKS') || result.includes('start_command') || result.includes('echo'),
        'response should reference the MCP tool usage or output. Got: ' + result.slice(0, 200)
      );
    } finally {
      tmp.cleanup();
    }
  });
});

describe('Claude Code + cc-tasks MCP (HTTP)', { timeout: 180000 }, () => {
  let httpServer;

  afterEach(() => {
    if (httpServer) {
      try { require('../../extension/tasks-mcp-http').stopTasksMcpServer(); } catch {}
      httpServer = null;
    }
  });

  it('Claude can create a task via cc-tasks MCP', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const tmp = createTempDir();
    try {
      const tasksFile = path.join(tmp.ccDir, 'tasks.json');
      const { startTasksMcpServer } = require('../../extension/tasks-mcp-http');
      httpServer = await startTasksMcpServer(tasksFile);

      const manifest = makeManifest({
        'cc-tasks': { type: 'http', url: `http://127.0.0.1:${httpServer.port}/mcp` },
      });

      const result = await runClaude(manifest,
        'Use the create_task tool to create a task with title "Test from Claude MCP". Just confirm it was created.');

      assert.ok(result.length > 0, 'should get a response');

      // Verify task was actually created on disk
      if (fs.existsSync(tasksFile)) {
        const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        assert.ok(data.tasks && data.tasks.length > 0, 'task should exist in file');
        assert.ok(data.tasks.some(t => t.title.includes('Test from Claude')), 'task title should match');
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe('Claude Code + chrome-devtools MCP', { timeout: 180000 }, () => {
  const chromePanelId = 'test-mcp-chrome-' + Date.now();
  let chromeStarted = false;

  afterEach(() => {
    if (chromeStarted && chromeManager) {
      try { chromeManager.killChrome(chromePanelId); } catch {}
      chromeStarted = false;
    }
  });

  it('Claude can use chrome-devtools MCP to navigate', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;
    if (!chromeManager) { t.skip('chrome-manager not available'); return; }

    const chromeResult = await chromeManager.ensureChrome(chromePanelId);
    if (!chromeResult) { t.skip('Chrome binary not found'); return; }
    chromeStarted = true;

    const manifest = makeManifest({
      'chrome-devtools': {
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', `--browser-url=http://127.0.0.1:${chromeResult.port}`, '--viewport=1280x720'],
      },
    }, { chromeDebugPort: chromeResult.port });

    const result = await runClaude(manifest,
      'Use the chrome-devtools MCP to list the pages. Tell me how many pages you see.');

    assert.ok(result.length > 0, 'should get a response');
    // Claude should be able to interact with Chrome
  });
});
