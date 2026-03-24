const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildCodexWorkerArgs } = require('../../src/codex-worker');

// Save and restore env var
const originalThinking = process.env.CLAUDE_CODE_EFFORT_LEVEL;
afterEach(() => {
  if (originalThinking === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
  else process.env.CLAUDE_CODE_EFFORT_LEVEL = originalThinking;
});

describe('CLAUDE_CODE_EFFORT_LEVEL env var', () => {
  it('setting the env var works', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  });

  it('deleting the env var works', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';
    delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  });

  it('_applyWorkerThinking pattern sets env var', () => {
    // Simulate the pattern from session-manager
    const thinking = 'medium';
    if (thinking) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = thinking;
    } else {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    }
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  });

  it('_applyWorkerThinking pattern clears env var for null', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';
    const thinking = null;
    if (thinking) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = thinking;
    } else {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    }
    assert.equal(process.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  });
});

describe('Codex worker thinking level in args', () => {
  function baseManifest() {
    return {
      repoRoot: '/test', extensionDir: '/ext', chromeDebugPort: null, files: {},
      controller: { cli: 'codex' },
      worker: { cli: 'codex', model: null, sessionId: 'sess', hasStarted: false, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', agentSessions: {} },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null, agents: {}, settings: {},
    };
  }

  function baseWorkerRecord() {
    return { promptFile: '/t.txt', stdoutFile: '/t.log', stderrFile: '/t.err', finalFile: '/t.json' };
  }

  it('passes thinking level via -c flag when agent has thinking', () => {
    const agentConfig = { thinking: 'high', mcps: {} };
    const args = buildCodexWorkerArgs(baseManifest(), baseWorkerRecord(), { agentConfig, agentSession: null });
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasThinking = cFlags.some(f => f.includes('model_reasoning_effort') && f.includes('high'));
    assert.ok(hasThinking, 'should set model_reasoning_effort to high');
  });

  it('does NOT pass thinking level when agent has no thinking', () => {
    const agentConfig = { mcps: {} };
    const args = buildCodexWorkerArgs(baseManifest(), baseWorkerRecord(), { agentConfig, agentSession: null });
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasThinking = cFlags.some(f => f.includes('model_reasoning_effort'));
    assert.ok(!hasThinking, 'should NOT set model_reasoning_effort');
  });

  it('does NOT pass thinking level when no agentConfig', () => {
    const args = buildCodexWorkerArgs(baseManifest(), baseWorkerRecord(), { agentConfig: null, agentSession: null });
    const cFlags = args.filter((a, i) => i > 0 && args[i - 1] === '-c');
    const hasThinking = cFlags.some(f => f.includes('model_reasoning_effort'));
    assert.ok(!hasThinking, 'should NOT set model_reasoning_effort');
  });
});
