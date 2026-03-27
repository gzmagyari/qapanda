const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeArgs } = require('../../src/claude');
const { buildCodexArgs } = require('../../src/codex');
const { buildCodexWorkerArgs } = require('../../src/codex-worker');

// ── Manifest factory ──────────────────────────────────────────────

function baseManifest(overrides = {}) {
  return {
    repoRoot: '/test/repo',
    files: { schema: '/test/repo/.qpanda/schema.json' },
    controller: {
      cli: 'codex', bin: 'codex', model: null, profile: null,
      sandbox: 'workspace-write', config: [], skipGitRepoCheck: false,
      extraInstructions: null, sessionId: null,
      schemaFile: '/test/repo/.qpanda/schema.json',
    },
    worker: {
      cli: 'claude', bin: 'claude', model: null, sessionId: 'sess-001',
      allowedTools: null, tools: null, disallowedTools: null,
      permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null,
      addDirs: [], appendSystemPrompt: null, runMode: 'print',
      hasStarted: false, agentSessions: {},
    },
    mcpServers: {},
    workerMcpServers: null,
    controllerMcpServers: null,
    agents: {},
    settings: { rawEvents: false, quiet: false, color: true },
    extensionDir: '/test/extension',
    chromeDebugPort: null,
    ...overrides,
  };
}

function baseLoop() {
  return {
    id: 'loop-0001',
    index: 1,
    controller: {
      finalFile: '/test/repo/.qpanda/runs/test/requests/req-0001/loop-0001/controller.final.json',
    },
    worker: {
      finalFile: '/test/repo/.qpanda/runs/test/requests/req-0001/loop-0001/worker.final.json',
    },
  };
}

function baseWorkerRecord() {
  return {
    promptFile: '/test/worker.prompt.txt',
    stdoutFile: '/test/worker.stdout.log',
    stderrFile: '/test/worker.stderr.log',
    finalFile: '/test/worker.final.json',
  };
}

// ── buildClaudeArgs ───────────────────────────────────────────────

describe('buildClaudeArgs', () => {
  it('builds basic args for print mode', () => {
    const manifest = baseManifest();
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('-p'), 'should include -p flag');
    assert.ok(args.includes('--output-format'), 'should include output-format');
    assert.ok(args.includes('stream-json'), 'should use stream-json format');
    assert.ok(args.includes('--verbose'), 'should include verbose');
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('includes --session-id for first turn', () => {
    const manifest = baseManifest();
    manifest.worker.hasStarted = false;
    manifest.worker.sessionId = 'test-session-id';
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('--session-id'), 'should include --session-id');
    const idx = args.indexOf('--session-id');
    assert.equal(args[idx + 1], 'test-session-id');
  });

  it('includes --resume for subsequent turns', () => {
    const manifest = baseManifest();
    manifest.worker.hasStarted = true;
    manifest.worker.sessionId = 'test-session-id';
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('--resume'), 'should include --resume');
    const idx = args.indexOf('--resume');
    assert.equal(args[idx + 1], 'test-session-id');
  });

  it('includes --model when worker model is set', () => {
    const manifest = baseManifest();
    manifest.worker.model = 'claude-opus-4-6';
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('--model'), 'should include --model flag');
    const idx = args.indexOf('--model');
    assert.equal(args[idx + 1], 'claude-opus-4-6');
  });

  it('uses --system-prompt for agents with custom system_prompt', () => {
    const manifest = baseManifest();
    const agentConfig = { system_prompt: 'You are a QA tester.', mcps: {} };
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop(), agentConfig });
    assert.ok(args.includes('--system-prompt'), 'should include --system-prompt');
    const idx = args.indexOf('--system-prompt');
    assert.equal(args[idx + 1], 'You are a QA tester.');
  });

  it('uses --append-system-prompt when no agent system prompt', () => {
    const manifest = baseManifest();
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('--append-system-prompt'), 'should include --append-system-prompt');
  });

  it('includes --mcp-config when MCPs are present', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'test-mcp': { command: 'node', args: ['server.js'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('--mcp-config'), 'should include --mcp-config');
    const idx = args.indexOf('--mcp-config');
    const config = JSON.parse(args[idx + 1]);
    assert.ok(config.mcpServers['test-mcp'], 'should have test-mcp in config');
    assert.equal(config.mcpServers['test-mcp'].type, 'stdio');
  });

  it('merges agent MCPs with base MCPs', () => {
    const manifest = baseManifest({
      workerMcpServers: { 'base-mcp': { command: 'node', args: ['base.js'] } },
    });
    const agentConfig = {
      system_prompt: 'test',
      mcps: { 'agent-mcp': { command: 'node', args: ['agent.js'] } },
    };
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop(), agentConfig });
    const idx = args.indexOf('--mcp-config');
    const config = JSON.parse(args[idx + 1]);
    assert.ok(config.mcpServers['base-mcp'], 'should have base MCP');
    assert.ok(config.mcpServers['agent-mcp'], 'should have agent MCP');
  });

  it('disables Bash when detached-command MCP is present', () => {
    const manifest = baseManifest({
      workerMcpServers: { 'detached-command': { command: 'node', args: ['mcp.js'] } },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    const idx = args.indexOf('--disallowedTools');
    assert.ok(idx >= 0, 'should have --disallowedTools');
    assert.ok(args[idx + 1].includes('Bash'), 'should disallow Bash');
  });

  it('replaces {CHROME_DEBUG_PORT} placeholder', () => {
    const manifest = baseManifest({
      chromeDebugPort: 9222,
      workerMcpServers: {
        'chrome-devtools': {
          command: 'npx',
          args: ['chrome-devtools-mcp', '--browser-url=http://127.0.0.1:{CHROME_DEBUG_PORT}'],
        },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    const idx = args.indexOf('--mcp-config');
    assert.ok(idx >= 0, 'should have --mcp-config');
    const configStr = args[idx + 1];
    assert.ok(configStr.includes('9222'), 'should replace port placeholder');
    assert.ok(!configStr.includes('{CHROME_DEBUG_PORT}'), 'should not have placeholder');
  });

  it('replaces {EXTENSION_DIR} placeholder', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'test-mcp': { command: 'node', args: ['{EXTENSION_DIR}/mcp.js'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    const idx = args.indexOf('--mcp-config');
    const configStr = args[idx + 1];
    assert.ok(configStr.includes('/test/extension'), 'should replace extension dir');
    assert.ok(!configStr.includes('{EXTENSION_DIR}'), 'should not have placeholder');
  });

  it('replaces {REPO_ROOT} placeholder', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'test-mcp': { command: 'node', args: ['{REPO_ROOT}/mcp.js'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    const idx = args.indexOf('--mcp-config');
    const configStr = args[idx + 1];
    assert.ok(configStr.includes('/test/repo'), 'should replace repo root');
    assert.ok(!configStr.includes('{REPO_ROOT}'), 'should not have placeholder');
  });

  it('includes --no-chrome when chrome-devtools MCP is present', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    assert.ok(args.includes('--no-chrome'), 'should include --no-chrome');
  });

  it('uses agent-specific session when provided', () => {
    const manifest = baseManifest();
    const agentSession = { sessionId: 'agent-sess-123', hasStarted: true };
    const agentConfig = { system_prompt: 'test', mcps: {} };
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop(), agentConfig, agentSession });
    assert.ok(args.includes('--resume'), 'should resume agent session');
    const idx = args.indexOf('--resume');
    assert.equal(args[idx + 1], 'agent-sess-123');
  });

  it('includes HTTP MCP servers correctly', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'cc-tasks': { type: 'http', url: 'http://localhost:12345/mcp' },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'hello', loop: baseLoop() });
    const idx = args.indexOf('--mcp-config');
    const config = JSON.parse(args[idx + 1]);
    assert.equal(config.mcpServers['cc-tasks'].type, 'http');
    assert.equal(config.mcpServers['cc-tasks'].url, 'http://localhost:12345/mcp');
  });
});

// ── buildCodexArgs (controller) ──────────────────────────────────

describe('buildCodexArgs', () => {
  it('builds basic controller args', () => {
    const manifest = baseManifest();
    const args = buildCodexArgs(manifest, baseLoop());
    assert.ok(args.includes('exec'), 'should include exec subcommand');
    assert.ok(args.includes('--cd'), 'should include --cd');
    assert.ok(args.includes('--output-schema'), 'should include --output-schema');
    assert.ok(args.includes('--json'), 'should include --json');
    assert.ok(args.includes('-'), 'should end with - for stdin');
  });

  it('uses resume when controller has sessionId', () => {
    const manifest = baseManifest();
    manifest.controller.sessionId = 'ctrl-session';
    const args = buildCodexArgs(manifest, baseLoop());
    assert.ok(args.includes('resume'), 'should include resume');
    assert.ok(args.includes('ctrl-session'), 'should include session ID');
    assert.ok(!args.includes('--cd'), 'resume should not include --cd');
    assert.ok(!args.includes('--output-schema'), 'resume should not include --output-schema');
  });

  it('includes custom model', () => {
    const manifest = baseManifest();
    manifest.controller.model = 'gpt-5.4';
    const args = buildCodexArgs(manifest, baseLoop());
    const idx = args.indexOf('--model');
    assert.ok(idx >= 0 || args.includes('-m'), 'should include model flag');
    // codex uses -m
    const mIdx = args.indexOf('-m');
    if (mIdx >= 0) assert.equal(args[mIdx + 1], 'gpt-5.4');
  });

  it('injects MCP servers as TOML -c flags', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'cc-tasks': { type: 'http', url: 'http://localhost:12345/mcp' },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasMcpUrl = cFlags.some(f => f.includes('mcp_servers.cc_tasks.url'));
    assert.ok(hasMcpUrl, 'should have HTTP MCP url in -c flag (with underscores)');
  });

  it('converts hyphens to underscores in MCP names for Codex', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'detached-command': { command: 'node', args: ['mcp.js'] },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasUnderscore = cFlags.some(f => f.includes('detached_command'));
    assert.ok(hasUnderscore, 'should use underscores in MCP name');
  });

  it('disables shell tool when detached-command present', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'detached-command': { command: 'node', args: ['mcp.js'] },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasShellDisable = cFlags.some(f => f === 'features.shell_tool=false');
    assert.ok(hasShellDisable, 'should disable shell tool');
  });

  it('includes --output-last-message with loop finalFile', () => {
    const loop = baseLoop();
    const manifest = baseManifest();
    const args = buildCodexArgs(manifest, loop);
    assert.ok(args.includes('--output-last-message'), 'should include --output-last-message');
    const idx = args.indexOf('--output-last-message');
    assert.equal(args[idx + 1], loop.controller.finalFile);
  });
});

// ── buildCodexWorkerArgs ─────────────────────────────────────────

describe('buildCodexWorkerArgs', () => {
  it('builds basic worker args', () => {
    const manifest = baseManifest();
    const args = buildCodexWorkerArgs(manifest, baseWorkerRecord(), { agentConfig: null, agentSession: null });
    assert.ok(args.includes('exec'), 'should include exec');
    assert.ok(args.includes('--cd'), 'should include --cd');
    assert.ok(args.includes('--json'), 'should include --json');
    assert.ok(args.includes('-'), 'should end with stdin marker');
    assert.ok(!args.includes('--output-schema'), 'worker should not use schema');
  });

  it('uses resume for subsequent turns', () => {
    const manifest = baseManifest();
    manifest.worker.hasStarted = true;
    manifest.worker.sessionId = 'worker-sess';
    const args = buildCodexWorkerArgs(manifest, baseWorkerRecord(), { agentConfig: null, agentSession: null });
    assert.ok(args.includes('resume'), 'should include resume');
    assert.ok(args.includes('worker-sess'), 'should include session ID');
  });

  it('uses agent session when provided', () => {
    const manifest = baseManifest();
    const agentSession = { sessionId: 'agent-sess', hasStarted: true };
    const args = buildCodexWorkerArgs(manifest, baseWorkerRecord(), { agentConfig: null, agentSession });
    assert.ok(args.includes('resume'), 'should resume agent session');
    assert.ok(args.includes('agent-sess'));
  });

  it('merges agent MCPs with base', () => {
    const manifest = baseManifest({
      workerMcpServers: { 'base-mcp': { command: 'node', args: ['base.js'] } },
    });
    const agentConfig = { mcps: { 'agent-mcp': { command: 'node', args: ['agent.js'] } } };
    const args = buildCodexWorkerArgs(manifest, baseWorkerRecord(), { agentConfig, agentSession: null });
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasBase = cFlags.some(f => f.includes('base_mcp'));
    const hasAgent = cFlags.some(f => f.includes('agent_mcp'));
    assert.ok(hasBase, 'should have base MCP');
    assert.ok(hasAgent, 'should have agent MCP');
  });

  it('disables shell when detached-command present', () => {
    const manifest = baseManifest({
      workerMcpServers: { 'detached-command': { command: 'node', args: ['mcp.js'] } },
    });
    const args = buildCodexWorkerArgs(manifest, baseWorkerRecord(), { agentConfig: null, agentSession: null });
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasShellDisable = cFlags.some(f => f === 'features.shell_tool=false');
    assert.ok(hasShellDisable, 'should disable shell tool');
  });
});
