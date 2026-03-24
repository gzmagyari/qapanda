const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { buildCodexWorkerArgs } = require('../../src/codex-worker');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');
const { createTempDir } = require('../helpers/test-utils');

function baseManifest() {
  return {
    repoRoot: PROJECT_ROOT,
    extensionDir: path.join(PROJECT_ROOT, 'extension'),
    chromeDebugPort: null,
    files: {},
    controller: { cli: 'codex', bin: 'codex', model: null, profile: null, sandbox: 'workspace-write', config: [], skipGitRepoCheck: false, extraInstructions: null, sessionId: null, schemaFile: '' },
    worker: { cli: 'codex', bin: 'codex', model: null, sessionId: null, allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: null, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', hasStarted: false, agentSessions: {} },
    mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
    agents: {}, settings: { rawEvents: false, quiet: false, color: true },
  };
}

describe('Codex as worker (live)', { timeout: 120000 }, () => {
  it('responds to a simple prompt', async (t) => {
    if (await skipIfMissing(t, 'codex')) return;

    const tmp = createTempDir();
    try {
      const finalFile = path.join(tmp.ccDir, 'worker.final.json');
      const workerRecord = {
        promptFile: path.join(tmp.ccDir, 'worker.prompt.txt'),
        stdoutFile: path.join(tmp.ccDir, 'worker.stdout.log'),
        stderrFile: path.join(tmp.ccDir, 'worker.stderr.log'),
        finalFile,
      };

      const manifest = baseManifest();
      const args = buildCodexWorkerArgs(manifest, workerRecord, { agentConfig: null, agentSession: null });

      let stdout = '';
      await spawnStreamingProcess({
        command: 'codex',
        args,
        cwd: PROJECT_ROOT,
        stdinText: 'Say exactly: CODEX_WORKER_TEST',
        onStdoutLine: (line) => { stdout += line + '\n'; },
        onStderrLine: () => {},
      });

      assert.ok(stdout.length > 0, 'should produce output');
    } finally {
      tmp.cleanup();
    }
  });
});
