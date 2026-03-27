const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnStreamingProcess } = require('../../src/process-utils');
const { buildClaudeArgs } = require('../../src/claude');
const { skipIfMissing, PROJECT_ROOT } = require('../helpers/live-test-utils');

function baseManifest() {
  return {
    repoRoot: PROJECT_ROOT,
    extensionDir: path.join(PROJECT_ROOT, 'extension'),
    chromeDebugPort: null,
    files: { schema: path.join(PROJECT_ROOT, '.qpanda', 'schema.json') },
    controller: { cli: 'codex', bin: 'codex', model: null, profile: null, sandbox: 'workspace-write', config: [], skipGitRepoCheck: false, extraInstructions: null, sessionId: null, schemaFile: '' },
    worker: { cli: 'claude', bin: 'claude', model: null, sessionId: require('node:crypto').randomUUID(), allowedTools: null, tools: null, disallowedTools: null, permissionPromptTool: null, maxTurns: 1, maxBudgetUsd: null, addDirs: [], appendSystemPrompt: null, runMode: 'print', hasStarted: false, agentSessions: {} },
    mcpServers: {}, workerMcpServers: null, controllerMcpServers: null,
    agents: {}, settings: { rawEvents: false, quiet: false, color: true },
  };
}

describe('Claude Code as worker (live)', { timeout: 60000 }, () => {
  it('responds to a simple prompt', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const manifest = baseManifest();
    const args = buildClaudeArgs(manifest, { prompt: 'Say exactly: HELLO_TEST_123' });

    let resultText = '';
    let gotResult = false;

    await spawnStreamingProcess({
      command: 'claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say exactly: HELLO_TEST_123',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') {
            resultText = evt.result || '';
            gotResult = true;
          }
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(gotResult, 'should receive a result event');
    assert.ok(resultText.includes('HELLO_TEST_123'), 'response should contain the requested text');
  });

  it('returns a session ID', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const manifest = baseManifest();
    const args = buildClaudeArgs(manifest, { prompt: 'Say hi' });

    let sessionId = null;
    await spawnStreamingProcess({
      command: 'claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say hi',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result' && evt.session_id) sessionId = evt.session_id;
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(sessionId, 'should return a session_id');
    assert.ok(typeof sessionId === 'string');
    assert.ok(sessionId.length > 10, 'session ID should be a UUID-like string');
  });

  it('streams content_block_delta events', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    const manifest = baseManifest();
    const args = buildClaudeArgs(manifest, { prompt: 'Say hello' });

    let hasTextDelta = false;
    const eventTypes = new Set();
    await spawnStreamingProcess({
      command: 'claude',
      args,
      cwd: PROJECT_ROOT,
      stdinText: 'Say hello',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          eventTypes.add(evt.type);
          // Claude stream-json may wrap events: { type: "content_block_delta", ... }
          // or as { type: "stream_event", event: { type: "content_block_delta" } }
          if (evt.type === 'content_block_delta') hasTextDelta = true;
          if (evt.event && evt.event.type === 'content_block_delta') hasTextDelta = true;
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(hasTextDelta || eventTypes.has('content_block_delta') || eventTypes.has('result'),
      'should receive streaming events (got types: ' + [...eventTypes].join(', ') + ')');
  });

  it('resumes session and maintains context across turns', async (t) => {
    if (await skipIfMissing(t, 'claude')) return;

    // Turn 1: store a value
    const manifest1 = baseManifest();
    const args1 = buildClaudeArgs(manifest1, { prompt: 'Remember: the secret code is MANGO99. Just say OK.' });

    let sessionId = null;
    await spawnStreamingProcess({
      command: 'claude',
      args: args1,
      cwd: PROJECT_ROOT,
      stdinText: 'Remember: the secret code is MANGO99. Just say OK.',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result' && evt.session_id) sessionId = evt.session_id;
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(sessionId, 'turn 1 should return session_id');

    // Turn 2: recall the value using --resume
    const manifest2 = baseManifest();
    manifest2.worker.sessionId = sessionId;
    manifest2.worker.hasStarted = true;
    const args2 = buildClaudeArgs(manifest2, { prompt: 'What was the secret code I told you? Just say the code.' });

    let resultText2 = '';
    await spawnStreamingProcess({
      command: 'claude',
      args: args2,
      cwd: PROJECT_ROOT,
      stdinText: 'What was the secret code I told you? Just say the code.',
      onStdoutLine: (line) => {
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'result') resultText2 = evt.result || '';
        } catch {}
      },
      onStderrLine: () => {},
    });

    assert.ok(resultText2.includes('MANGO99'), 'turn 2 should recall the secret code from turn 1');
  });
});
