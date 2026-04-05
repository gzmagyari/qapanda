const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { prepareNewRun } = require('../../src/state');
const { readTranscriptEntriesSync } = require('../../src/transcript');
const { createTempDir, mockRenderer } = require('../helpers/test-utils');

const orchPath = path.resolve(__dirname, '../../src/orchestrator.js');
const claudePath = path.resolve(__dirname, '../../src/claude.js');
const origClaude = require(claudePath);

function loadOrchestratorWithStub(captured) {
  delete require.cache[orchPath];
  require.cache[claudePath] = {
    id: claudePath,
    filename: claudePath,
    loaded: true,
    exports: {
      ...origClaude,
      runWorkerTurn: async (opts) => {
        captured.prompt = opts.prompt;
        captured.visiblePrompt = opts.visiblePrompt;
        const result = {
          prompt: opts.visiblePrompt == null ? opts.prompt : opts.visiblePrompt,
          exitCode: 0,
          signal: null,
          sessionId: 'stub-session',
          hadTextDelta: true,
          resultText: 'Stub worker completed.',
          finalEvent: null,
        };
        opts.request.latestWorkerResult = result;
        return result;
      },
    },
  };
  return require(orchPath);
}

function restoreClaudeModule() {
  delete require.cache[orchPath];
  require.cache[claudePath] = {
    id: claudePath,
    filename: claudePath,
    loaded: true,
    exports: origClaude,
  };
}

test('direct worker handoff is hidden from transcript but sent in the actual worker prompt', async () => {
  const tmp = createTempDir();
  const captured = {};
  const renderer = mockRenderer();
  const { runDirectWorkerTurn } = loadOrchestratorWithStub(captured);

  try {
    const manifest = await prepareNewRun('Initial run', {
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerCli: 'codex',
      workerCli: 'claude',
    });
    manifest.agents = {
      dev: { name: 'Developer', cli: 'claude', enabled: true },
      'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'claude', enabled: true },
    };
    manifest.worker.agentSessions = {
      dev: { sessionId: 'dev-sess', hasStarted: true, lastSeenChatLine: 2, lastSeenTranscriptLine: 2 },
    };

    fs.writeFileSync(
      manifest.files.chatLog,
      [
        { type: 'user', text: 'Implemented the auth fix.' },
        { type: 'claude', label: 'Developer', text: 'Auth fix is complete.' },
        { type: 'controller', label: 'Continue', text: 'Controller noise must not appear.' },
        { type: 'banner', text: 'Banner noise must not appear.' },
        { type: 'claude', label: 'QA Engineer (Browser)', text: 'QA found a login redirect regression.' },
        { type: 'user', text: 'Please fix the QA issue.' },
        { type: 'mcpCardStart', label: 'Developer', text: 'Running command' },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    const updated = await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Handle the QA feedback.',
      agentId: 'dev',
      enableWorkerHandoff: true,
    });

    assert.equal(captured.visiblePrompt, 'Handle the QA feedback.');
    assert.ok(captured.prompt.includes('Context since your last turn in this run:'));
    assert.ok(captured.prompt.includes('QA Engineer (Browser): QA found a login redirect regression.'));
    assert.ok(captured.prompt.includes('User: Please fix the QA issue.'));
    assert.ok(!captured.prompt.includes('Implemented the auth fix.'));
    assert.ok(!captured.prompt.includes('Controller noise must not appear.'));
    assert.ok(!captured.prompt.includes('Banner noise must not appear.'));
    assert.ok(!captured.prompt.includes('Running command'));

    const transcript = readTranscriptEntriesSync(updated.files.transcript);
    const userEntries = transcript.filter((entry) => entry.kind === 'user_message');
    assert.equal(userEntries[userEntries.length - 1].text, 'Handle the QA feedback.');
    assert.equal(updated.requests[updated.requests.length - 1].latestWorkerResult.prompt, 'Handle the QA feedback.');
    assert.equal(updated.worker.agentSessions.dev.lastSeenChatLine, 7);
  } finally {
    restoreClaudeModule();
    tmp.cleanup();
  }
});

test('direct worker handoff stays disabled unless explicitly requested', async () => {
  const tmp = createTempDir();
  const captured = {};
  const renderer = mockRenderer();
  const { runDirectWorkerTurn } = loadOrchestratorWithStub(captured);

  try {
    const manifest = await prepareNewRun('Initial run', {
      repoRoot: tmp.root,
      stateRoot: tmp.ccDir,
      controllerCli: 'codex',
      workerCli: 'claude',
    });
    manifest.agents = { dev: { name: 'Developer', cli: 'claude', enabled: true } };
    manifest.worker.agentSessions = {
      dev: { sessionId: 'dev-sess', hasStarted: true, lastSeenChatLine: 0, lastSeenTranscriptLine: 0 },
    };

    await runDirectWorkerTurn(manifest, renderer, {
      userMessage: 'Just handle this normally.',
      agentId: 'dev',
    });

    assert.equal(captured.prompt, 'Just handle this normally.');
    assert.equal(captured.visiblePrompt, 'Just handle this normally.');
  } finally {
    restoreClaudeModule();
    tmp.cleanup();
  }
});
