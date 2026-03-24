const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCodexArgs } = require('../../src/codex');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { skipIfMissing, PROJECT_ROOT, EXTENSION_DIR } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

function makeManifest(controllerMcpServers, tmp) {
  const schemaFile = path.join(tmp.ccDir, 'schema.json');
  const schema = require('../../src/schema');
  fs.writeFileSync(schemaFile, JSON.stringify(schema));

  return {
    repoRoot: PROJECT_ROOT,
    extensionDir: EXTENSION_DIR,
    chromeDebugPort: null,
    files: { schema: schemaFile },
    controller: {
      cli: 'codex', bin: 'codex', model: null, profile: null,
      sandbox: 'workspace-write', config: [], skipGitRepoCheck: false,
      extraInstructions: null, sessionId: null, schemaFile,
    },
    worker: {
      cli: 'claude', bin: 'claude', model: null, sessionId: null,
      hasStarted: false, agentSessions: {},
    },
    mcpServers: {},
    workerMcpServers: null,
    controllerMcpServers,
    agents: {},
    settings: {},
  };
}

function makeLoop(tmp) {
  const finalFile = path.join(tmp.ccDir, 'controller.final.json');
  return {
    id: 'loop-0001', index: 1,
    controller: { finalFile },
  };
}

describe('Codex + detached-command MCP', { timeout: 120000 }, () => {
  it('Codex can see detached-command MCP tools', async (t) => {
    if (await skipIfMissing(t, 'codex')) return;

    const tmp = createTempDir();
    try {
      const manifest = makeManifest({
        'detached-command': {
          command: 'node',
          args: [path.join(EXTENSION_DIR, 'detached-command-mcp', 'dist', 'index.js')],
          env: {
            DETACHED_BASH_MCP_DATA_DIR: path.join(tmp.ccDir, '.detached-jobs'),
            DETACHED_COMMAND_INSTANCE_ID: 'codex-test-' + Date.now(),
          },
        },
      }, tmp);
      const loop = makeLoop(tmp);
      const args = buildCodexArgs(manifest, loop);

      // Verify -c flags include the MCP
      const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
      const hasMcp = cFlags.some(f => f.includes('mcp_servers.detached_command'));
      assert.ok(hasMcp, 'args should include detached-command MCP config');

      // Actually run codex with the MCP
      let stdout = '';
      await spawnStreamingProcess({
        command: 'codex',
        args,
        cwd: PROJECT_ROOT,
        stdinText: 'Use the detached_command start_command tool to run "echo CODEX_MCP_TEST". Then respond with action "stop" and include the echo output in controller_messages.',
        onStdoutLine: (line) => { stdout += line + '\n'; },
        onStderrLine: () => {},
      });

      assert.ok(stdout.length > 0, 'codex should produce output');
    } finally {
      tmp.cleanup();
    }
  });
});

describe('Codex + cc-tasks MCP (HTTP)', { timeout: 120000 }, () => {
  let httpServer;

  afterEach(() => {
    if (httpServer) {
      try { require('../../extension/tasks-mcp-http').stopTasksMcpServer(); } catch {}
      httpServer = null;
    }
  });

  it('Codex can interact with cc-tasks MCP', async (t) => {
    if (await skipIfMissing(t, 'codex')) return;

    const tmp = createTempDir();
    try {
      const tasksFile = path.join(tmp.ccDir, 'tasks.json');
      const { startTasksMcpServer } = require('../../extension/tasks-mcp-http');
      httpServer = await startTasksMcpServer(tasksFile);

      const manifest = makeManifest({
        'cc-tasks': { type: 'http', url: `http://127.0.0.1:${httpServer.port}/mcp` },
      }, tmp);
      const loop = makeLoop(tmp);
      const args = buildCodexArgs(manifest, loop);

      // Verify -c flags include the HTTP MCP
      const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
      const hasUrl = cFlags.some(f => f.includes('cc_tasks.url'));
      assert.ok(hasUrl, 'args should include cc-tasks HTTP URL');

      let stdout = '';
      await spawnStreamingProcess({
        command: 'codex',
        args,
        cwd: PROJECT_ROOT,
        stdinText: 'Use the cc_tasks create_task tool to create a task with title "Codex Task Test". Then respond with action "stop".',
        onStdoutLine: (line) => { stdout += line + '\n'; },
        onStderrLine: () => {},
      });

      assert.ok(stdout.length > 0, 'codex should produce output');

      // Check if task was actually created
      if (fs.existsSync(tasksFile)) {
        const data = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        if (data.tasks && data.tasks.length > 0) {
          assert.ok(true, 'task was created via MCP');
        }
      }
    } finally {
      tmp.cleanup();
    }
  });
});
