const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildClaudeArgs } = require('../../src/claude');
const { buildCodexArgs } = require('../../src/codex');

const EXTENSION_DIR = path.resolve(__dirname, '../../extension');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function baseManifest(overrides = {}) {
  return {
    repoRoot: PROJECT_ROOT,
    extensionDir: EXTENSION_DIR,
    chromeDebugPort: null,
    files: { schema: path.join(PROJECT_ROOT, '.qpanda', 'schema.json') },
    controller: { cli: 'codex', bin: 'codex', model: null, profile: null, sandbox: 'workspace-write', config: [], skipGitRepoCheck: false, extraInstructions: null, sessionId: null, schemaFile: path.join(PROJECT_ROOT, '.qpanda', 'schema.json') },
    worker: { cli: 'claude', bin: 'claude', model: null, sessionId: 'test-sess', allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', hasStarted: false, agentSessions: {} },
    mcpServers: {},
    workerMcpServers: null,
    controllerMcpServers: null,
    agents: {},
    settings: { rawEvents: false, quiet: false, color: true },
    ...overrides,
  };
}

function baseLoop() {
  return {
    id: 'loop-0001', index: 1,
    controller: { finalFile: path.join(PROJECT_ROOT, 'test-final.json') },
  };
}

describe('Claude --mcp-config JSON format', () => {
  it('produces valid JSON for stdio MCP', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'detached-command': {
          command: 'node',
          args: [path.join(EXTENSION_DIR, 'detached-command-mcp', 'dist', 'index.js')],
          env: { DETACHED_BASH_MCP_DATA_DIR: path.join(PROJECT_ROOT, '.qpanda', '.detached-jobs') },
        },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const idx = args.indexOf('--mcp-config');
    assert.ok(idx >= 0, 'should have --mcp-config');

    const jsonStr = args[idx + 1];
    let config;
    assert.doesNotThrow(() => { config = JSON.parse(jsonStr); }, 'should be valid JSON');
    assert.ok(config.mcpServers, 'should have mcpServers key');
    assert.ok(config.mcpServers['detached-command'], 'should have detached-command');
    assert.equal(config.mcpServers['detached-command'].type, 'stdio');
    assert.ok(config.mcpServers['detached-command'].command, 'should have command');
    assert.ok(Array.isArray(config.mcpServers['detached-command'].args), 'should have args array');
    assert.ok(config.mcpServers['detached-command'].env, 'should have env');
  });

  it('produces valid JSON for HTTP MCP', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'cc-tasks': { type: 'http', url: 'http://127.0.0.1:12345/mcp' },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const idx = args.indexOf('--mcp-config');
    const config = JSON.parse(args[idx + 1]);
    assert.equal(config.mcpServers['cc-tasks'].type, 'http');
    assert.equal(config.mcpServers['cc-tasks'].url, 'http://127.0.0.1:12345/mcp');
  });

  it('produces valid JSON for mixed MCPs', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'detached-command': { command: 'node', args: ['mcp.js'] },
        'cc-tasks': { type: 'http', url: 'http://localhost:8080/mcp' },
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browser-url=http://127.0.0.1:9222'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.equal(Object.keys(config.mcpServers).length, 3);
  });

  it('placeholder replacement produces valid paths in JSON', () => {
    const manifest = baseManifest({
      chromeDebugPort: 9333,
      workerMcpServers: {
        'test-mcp': {
          command: 'node',
          args: ['{EXTENSION_DIR}/mcp.js', '--port={CHROME_DEBUG_PORT}', '--root={REPO_ROOT}'],
          env: { DATA: '{REPO_ROOT}/data' },
        },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const jsonStr = args[args.indexOf('--mcp-config') + 1];

    // Should still be valid JSON after replacements
    let config;
    assert.doesNotThrow(() => { config = JSON.parse(jsonStr); }, 'should be valid JSON after replacement');

    // No unreplaced placeholders
    assert.ok(!jsonStr.includes('{EXTENSION_DIR}'), 'no unreplaced EXTENSION_DIR');
    assert.ok(!jsonStr.includes('{CHROME_DEBUG_PORT}'), 'no unreplaced CHROME_DEBUG_PORT');
    assert.ok(!jsonStr.includes('{REPO_ROOT}'), 'no unreplaced REPO_ROOT');
  });

  it('Windows backslash paths are forward-slashed in JSON', () => {
    const manifest = baseManifest({
      repoRoot: 'C:\\Users\\Test\\repo',
      extensionDir: 'C:\\Users\\Test\\.vscode\\ext',
      workerMcpServers: {
        'test': { command: 'node', args: ['{EXTENSION_DIR}/mcp.js', '{REPO_ROOT}/data'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const jsonStr = args[args.indexOf('--mcp-config') + 1];
    // Paths in the replacement should use forward slashes
    assert.ok(jsonStr.includes('C:/Users/Test'), 'should use forward slashes');
  });
});

describe('Codex -c MCP TOML format', () => {
  it('produces valid -c flags for stdio MCP', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'detached-command': { command: 'node', args: ['mcp.js'], env: { KEY: 'value' } },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');

    // Should have command, args, env, and timeout
    const hasCommand = cFlags.some(f => f.includes('mcp_servers.detached_command.command='));
    const hasArgs = cFlags.some(f => f.includes('mcp_servers.detached_command.args='));
    const hasEnv = cFlags.some(f => f.includes('mcp_servers.detached_command.env.KEY='));
    const hasTimeout = cFlags.some(f => f.includes('mcp_servers.detached_command.startup_timeout_sec='));

    assert.ok(hasCommand, 'should have command flag');
    assert.ok(hasArgs, 'should have args flag');
    assert.ok(hasEnv, 'should have env flag');
    assert.ok(hasTimeout, 'should have timeout flag');
  });

  it('produces valid -c flags for HTTP MCP', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'cc-tasks': { type: 'http', url: 'http://localhost:8080/mcp' },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');

    const hasUrl = cFlags.some(f => f.includes('mcp_servers.cc_tasks.url='));
    assert.ok(hasUrl, 'should have URL flag');
  });

  it('converts hyphens to underscores in MCP names', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'my-custom-mcp': { command: 'node', args: ['s.js'] },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasUnderscore = cFlags.some(f => f.includes('my_custom_mcp'));
    assert.ok(hasUnderscore, 'hyphens should become underscores');
  });

  it('TOML escapes Windows backslash paths', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'test': { command: 'C:\\Program Files\\node.exe', args: ['C:\\mcp\\server.js'] },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const cmdFlag = cFlags.find(f => f.includes('mcp_servers.test.command='));
    assert.ok(cmdFlag, 'should have command flag');
    // TOML requires doubled backslashes
    assert.ok(cmdFlag.includes('\\\\'), 'should double-escape backslashes for TOML');
  });

  it('TOML properly quotes string values', () => {
    const manifest = baseManifest({
      controllerMcpServers: {
        'test': { command: 'node', args: ['server.js'], env: { PATH_VAR: '/usr/local/bin' } },
      },
    });
    const args = buildCodexArgs(manifest, baseLoop());
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const envFlag = cFlags.find(f => f.includes('env.PATH_VAR'));
    assert.ok(envFlag, 'should have env flag');
    assert.ok(envFlag.includes('"'), 'env value should be quoted');
  });
});
