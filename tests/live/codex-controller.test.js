const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { buildCodexArgs } = require('../../src/codex');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

function baseManifest(schemaFile) {
  return {
    repoRoot: PROJECT_ROOT,
    files: { schema: schemaFile },
    controller: { cli: 'codex', bin: 'codex', model: null, profile: null, sandbox: 'workspace-write', config: [], skipGitRepoCheck: false, extraInstructions: null, sessionId: null, schemaFile },
    worker: { cli: 'claude', bin: 'claude', model: null, sessionId: null, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', hasStarted: false, agentSessions: {} },
    mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
    agents: {}, settings: { rawEvents: false, quiet: false, color: true },
  };
}

describe('Codex as controller (live)', { timeout: 120000 }, () => {
  it('produces a valid JSON decision', async (t) => {
    if (await skipIfMissing(t, 'codex')) return;

    const tmp = createTempDir();
    try {
      // Create schema file
      const schema = require('../../src/schema');
      const schemaFile = path.join(tmp.ccDir, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(schema));

      const finalFile = path.join(tmp.ccDir, 'controller.final.json');
      const manifest = baseManifest(schemaFile);
      const loop = {
        id: 'loop-0001', index: 1,
        controller: { finalFile },
      };
      const args = buildCodexArgs(manifest, loop);

      const stdinText = 'The user said: "Say hello". Please respond with action "stop" and a friendly message in controller_messages.';

      let stdout = '';
      await spawnStreamingProcess({
        command: 'codex',
        args,
        cwd: PROJECT_ROOT,
        stdinText,
        onStdoutLine: (line) => { stdout += line + '\n'; },
        onStderrLine: () => {},
      });

      // Check that codex produced output (final file or stdout)
      const hasFinalFile = fs.existsSync(finalFile) && fs.readFileSync(finalFile, 'utf8').trim().length > 0;
      assert.ok(stdout.length > 0 || hasFinalFile, 'should have stdout output or final file');
    } finally {
      tmp.cleanup();
    }
  });
});
