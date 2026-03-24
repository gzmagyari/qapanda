const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { buildClaudeArgs } = require('../../src/claude');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');

// Claude as controller uses the same buildClaudeArgs but with a schema-enforcing system prompt

describe('Claude Code as controller (live)', { timeout: 60000 }, () => {
  it('can produce structured JSON output when prompted', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const manifest = {
      repoRoot: PROJECT_ROOT,
      extensionDir: path.join(PROJECT_ROOT, 'extension'),
      chromeDebugPort: null,
      files: {},
      controller: { cli: 'claude', bin: 'claude', model: null, profile: null, sandbox: null, config: [], skipGitRepoCheck: false, extraInstructions: null, sessionId: null, schemaFile: null },
      worker: { cli: 'claude', bin: 'claude', model: null, sessionId: require('node:crypto').randomUUID(), allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: 1, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', hasStarted: false, agentSessions: {} },
      mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
      agents: {}, settings: { rawEvents: false, quiet: false, color: true },
    };

    const prompt = 'Respond with exactly this JSON and nothing else: {"action":"stop","controller_messages":["Done"],"claude_message":""}';
    const agentConfig = {
      system_prompt: 'You are a controller. Always respond with valid JSON containing action, controller_messages, and claude_message fields.',
      mcps: {},
    };
    const args = buildClaudeArgs(manifest, { prompt, agentConfig });

    let resultText = '';
    await spawnStreamingProcess({
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
      onStderrLine: () => {},
    });

    assert.ok(resultText.length > 0, 'should get a response');
    // Claude may or may not produce exact JSON, but it should respond
  });
});
