const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test the placeholder replacement logic used in buildClaudeArgs and buildCodexWorkerArgs
// This logic lives inside those functions — we test via the exported builders

const { buildClaudeArgs } = require('../../src/claude');

function baseManifest(overrides = {}) {
  return {
    repoRoot: '/my/repo',
    extensionDir: '/my/extension',
    chromeDebugPort: null,
    files: { schema: '/my/repo/.qpanda/schema.json' },
    controller: { cli: 'codex', bin: 'codex', model: null, profile: null, sandbox: 'workspace-write', config: [], skipGitRepoCheck: false, extraInstructions: null, sessionId: null, schemaFile: '/my/repo/.qpanda/schema.json' },
    worker: { cli: 'claude', bin: 'claude', model: null, sessionId: 'sess', allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', hasStarted: false, agentSessions: {} },
    mcpServers: {},
    workerMcpServers: null,
    controllerMcpServers: null,
    agents: {},
    settings: { rawEvents: false, quiet: false, color: true },
    ...overrides,
  };
}

function getMcpConfig(args) {
  const idx = args.indexOf('--mcp-config');
  if (idx < 0) return null;
  return JSON.parse(args[idx + 1]);
}

describe('MCP placeholder replacement in buildClaudeArgs', () => {
  it('replaces {CHROME_DEBUG_PORT} in MCP args', () => {
    const manifest = baseManifest({
      chromeDebugPort: 9333,
      workerMcpServers: {
        'chrome-devtools': { command: 'npx', args: ['mcp', '--port={CHROME_DEBUG_PORT}'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const config = getMcpConfig(args);
    assert.ok(config);
    const cdArgs = config.mcpServers['chrome-devtools'].args;
    assert.ok(cdArgs.some(a => a.includes('9333')));
    assert.ok(!cdArgs.some(a => a.includes('{CHROME_DEBUG_PORT}')));
  });

  it('does NOT replace {CHROME_DEBUG_PORT} when port is null', () => {
    const manifest = baseManifest({
      chromeDebugPort: null,
      workerMcpServers: {
        'chrome-devtools': { command: 'npx', args: ['mcp', '--port={CHROME_DEBUG_PORT}'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const config = getMcpConfig(args);
    assert.ok(config);
    const cdArgs = config.mcpServers['chrome-devtools'].args;
    assert.ok(cdArgs.some(a => a.includes('{CHROME_DEBUG_PORT}')), 'placeholder should remain');
  });

  it('replaces {EXTENSION_DIR} in MCP args', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'test': { command: 'node', args: ['{EXTENSION_DIR}/server.js'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const config = getMcpConfig(args);
    const testArgs = config.mcpServers['test'].args;
    assert.ok(testArgs.some(a => a.includes('/my/extension')));
    assert.ok(!testArgs.some(a => a.includes('{EXTENSION_DIR}')));
  });

  it('replaces {REPO_ROOT} in MCP args', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'test': { command: 'node', args: ['{REPO_ROOT}/tools/mcp.js'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const config = getMcpConfig(args);
    const testArgs = config.mcpServers['test'].args;
    assert.ok(testArgs.some(a => a.includes('/my/repo')));
    assert.ok(!testArgs.some(a => a.includes('{REPO_ROOT}')));
  });

  it('replaces {EXTENSION_DIR} in MCP env values', () => {
    const manifest = baseManifest({
      workerMcpServers: {
        'test': { command: 'node', args: ['s.js'], env: { DATA_DIR: '{EXTENSION_DIR}/data' } },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const config = getMcpConfig(args);
    // The env replacement happens in the JSON string level
    const configStr = args[args.indexOf('--mcp-config') + 1];
    assert.ok(configStr.includes('/my/extension'), 'env value should have extension dir');
    assert.ok(!configStr.includes('{EXTENSION_DIR}'), 'placeholder should be gone');
  });

  it('handles multiple placeholders in same MCP', () => {
    const manifest = baseManifest({
      chromeDebugPort: 9444,
      workerMcpServers: {
        'multi': {
          command: 'node',
          args: ['{EXTENSION_DIR}/mcp.js', '--port={CHROME_DEBUG_PORT}', '--root={REPO_ROOT}'],
        },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const configStr = args[args.indexOf('--mcp-config') + 1];
    assert.ok(configStr.includes('/my/extension'));
    assert.ok(configStr.includes('9444'));
    assert.ok(configStr.includes('/my/repo'));
    assert.ok(!configStr.includes('{EXTENSION_DIR}'));
    assert.ok(!configStr.includes('{CHROME_DEBUG_PORT}'));
    assert.ok(!configStr.includes('{REPO_ROOT}'));
  });

  it('handles backslash paths (Windows) by converting to forward slashes', () => {
    const manifest = baseManifest({
      repoRoot: 'C:\\Users\\Test\\repo',
      extensionDir: 'C:\\Users\\Test\\.vscode\\extensions\\qapanda',
      workerMcpServers: {
        'test': { command: 'node', args: ['{EXTENSION_DIR}/mcp.js', '{REPO_ROOT}/data'] },
      },
    });
    const args = buildClaudeArgs(manifest, { prompt: 'test' });
    const configStr = args[args.indexOf('--mcp-config') + 1];
    // Backslashes should be converted to forward slashes in replacements
    assert.ok(configStr.includes('C:/Users/Test/repo'), 'repo root backslashes converted');
    assert.ok(configStr.includes('C:/Users/Test/.vscode/extensions/qapanda'), 'extension dir backslashes converted');
  });
});
