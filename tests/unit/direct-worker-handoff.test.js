const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DIRECT_WORKER_HANDOFF_NOTICE,
  buildDirectWorkerPrompt,
  getDirectWorkerSessionState,
  syncDirectWorkerChatCursor,
} = require('../../src/direct-worker-handoff');
const { buildTranscriptTail } = require('../../src/transcript');

function createRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-worker-handoff-'));
}

function writeChatLog(repoRoot, entries) {
  const runDir = path.join(repoRoot, '.qpanda', 'runs', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  const chatLog = path.join(runDir, 'chat.jsonl');
  fs.writeFileSync(
    chatLog,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
  return chatLog;
}

function makeManifest(repoRoot, chatLogFile, workerOverrides = {}) {
  return {
    repoRoot,
    runId: 'run-1',
    files: {
      chatLog: chatLogFile,
    },
    worker: {
      cli: 'claude',
      lastSeenChatLine: 0,
      lastSeenTranscriptLine: 0,
      agentSessions: {},
      ...workerOverrides,
    },
    agents: {
      dev: { name: 'Developer', cli: 'claude', enabled: true },
      'QA-Browser': { name: 'QA Engineer (Browser)', cli: 'claude', enabled: true },
    },
  };
}

describe('direct worker handoff', () => {
  it('caps a brand-new worker handoff to a whole-entry tail from filtered chat history', async () => {
    const repoRoot = createRepo();
    try {
      const entries = [];
      const expectedLines = [];
      for (let index = 0; index < 80; index += 1) {
        entries.push({ type: 'user', text: `USER-${index}-START ${'u'.repeat(500)} USER-${index}-END` });
        entries.push({ type: 'claude', label: 'Developer', text: `DEV-${index}-START ${'d'.repeat(500)} DEV-${index}-END` });
        entries.push({ type: 'claude', label: 'QA Engineer (Browser)', text: `QA-${index}-START ${'q'.repeat(500)} QA-${index}-END` });
        expectedLines.push(`User: USER-${index}-START ${'u'.repeat(500)} USER-${index}-END`);
        expectedLines.push(`Developer: DEV-${index}-START ${'d'.repeat(500)} DEV-${index}-END`);
      }
      const chatLogFile = writeChatLog(repoRoot, entries);
      const manifest = makeManifest(repoRoot, chatLogFile);
      const expectedTail = buildTranscriptTail(expectedLines, { maxChars: 50_000 });

      const handoff = await buildDirectWorkerPrompt(manifest, 'QA-Browser', 'Please test the latest changes.');

      assert.ok(handoff.truncated);
      assert.equal(handoff.handoffLines[0], DIRECT_WORKER_HANDOFF_NOTICE);
      assert.deepEqual(handoff.handoffLines.slice(1), expectedTail.lines);
      assert.match(handoff.prompt, /^Context since your last turn in this run:\n/);
      assert.match(handoff.prompt, /Current user request:\nPlease test the latest changes\.$/);
      assert.ok(!handoff.prompt.includes('QA-0-START'));
      assert.ok(expectedTail.lines.every((line) => /(USER|DEV)-\d+-START .* (USER|DEV)-\d+-END$/.test(line)));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('only includes chat lines after the target worker last saw the run', async () => {
    const repoRoot = createRepo();
    try {
      const entries = [
        { type: 'user', text: 'Implement the auth fix.' },
        { type: 'claude', label: 'Developer', text: 'Auth fix is in place.' },
        { type: 'controller', label: 'Continue', text: 'This controller line must not appear.' },
        { type: 'banner', text: 'Noise banner that should be skipped.' },
        { type: 'claude', label: 'QA Engineer (Browser)', text: 'QA found a login redirect regression.' },
        { type: 'user', text: 'Please fix the QA issue.' },
        { type: 'mcpCardStart', label: 'Developer', text: 'Running command' },
      ];
      const chatLogFile = writeChatLog(repoRoot, entries);
      const manifest = makeManifest(repoRoot, chatLogFile, {
        agentSessions: {
          dev: { sessionId: 'dev-sess', hasStarted: true, lastSeenChatLine: 2, lastSeenTranscriptLine: 0 },
        },
      });

      const handoff = await buildDirectWorkerPrompt(manifest, 'dev', 'Handle the QA feedback.');

      assert.ok(handoff.prompt.includes('QA Engineer (Browser): QA found a login redirect regression.'));
      assert.ok(handoff.prompt.includes('User: Please fix the QA issue.'));
      assert.ok(!handoff.prompt.includes('Implement the auth fix.'));
      assert.ok(!handoff.prompt.includes('Auth fix is in place.'));
      assert.ok(!handoff.prompt.includes('This controller line must not appear.'));
      assert.ok(!handoff.prompt.includes('Noise banner that should be skipped.'));
      assert.ok(!handoff.prompt.includes('Running command'));

      syncDirectWorkerChatCursor(manifest, 'dev');
      assert.equal(getDirectWorkerSessionState(manifest, 'dev').lastSeenChatLine, entries.length);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('returns the original prompt unchanged when there is no unseen history', async () => {
    const repoRoot = createRepo();
    try {
      const entries = [
        { type: 'claude', label: 'Developer', text: 'Previous answer.' },
      ];
      const chatLogFile = writeChatLog(repoRoot, entries);
      const manifest = makeManifest(repoRoot, chatLogFile, {
        agentSessions: {
          dev: { sessionId: 'dev-sess', hasStarted: true, lastSeenChatLine: 1, lastSeenTranscriptLine: 1 },
        },
      });

      const handoff = await buildDirectWorkerPrompt(manifest, 'dev', 'Continue the same task.');

      assert.equal(handoff.prompt, 'Continue the same task.');
      assert.deepEqual(handoff.handoffLines, []);
      assert.equal(handoff.truncated, false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
