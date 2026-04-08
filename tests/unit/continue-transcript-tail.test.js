const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildControllerPrompt,
} = require('../../src/prompts');
const {
  buildMergedRunView,
  readTranscriptTailEntriesSync,
} = require('../../src/transcript');

const CONTINUE_NOTICE = 'System: Earlier transcript omitted. Only the latest ~50000 characters of visible chat history are shown.';

function createRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-continue-tail-'));
}

function writeChatLog(repoRoot, entries) {
  const qpandaDir = path.join(repoRoot, '.qpanda');
  fs.mkdirSync(qpandaDir, { recursive: true });
  const chatLog = path.join(qpandaDir, 'chat.jsonl');
  fs.writeFileSync(chatLog, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return chatLog;
}

function writeTranscriptLog(repoRoot, entries) {
  const qpandaDir = path.join(repoRoot, '.qpanda');
  fs.mkdirSync(qpandaDir, { recursive: true });
  const transcript = path.join(qpandaDir, 'transcript.jsonl');
  fs.writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return transcript;
}

function buildManifest(repoRoot, chatLogFile, currentRequest, previousRequests = [], options = {}) {
  return {
    repoRoot,
    runId: 'run-tail-1',
    stopReason: null,
    selfTesting: false,
    controllerSystemPrompt: options.controllerSystemPrompt === undefined
      ? 'Continue system prompt'
      : options.controllerSystemPrompt,
    controller: {
      sessionId: null,
      extraInstructions: '',
    },
    worker: {
      sessionId: null,
      hasStarted: true,
      cli: 'codex',
      bin: 'codex',
    },
    agents: {},
    files: {
      chatLog: chatLogFile,
      transcript: options.transcriptFile || null,
    },
    requests: [...previousRequests, currentRequest],
  };
}

function parsePromptState(prompt) {
  const marker = 'Current state:\n';
  const start = prompt.indexOf(marker);
  assert.notEqual(start, -1, 'Current state marker not found');
  const jsonStart = prompt.indexOf('{', start + marker.length);
  assert.notEqual(jsonStart, -1, 'State JSON start not found');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = jsonStart; index < prompt.length; index += 1) {
    const ch = prompt[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(prompt.slice(jsonStart, index + 1));
      }
    }
  }

  throw new Error('State JSON end not found');
}

function selectExpectedTail(lines, maxChars = 50_000) {
  let start = lines.length - 1;
  let totalChars = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    totalChars += lines[index].length;
    start = index;
    if (totalChars >= maxChars) break;
  }
  return {
    lines: lines.slice(start),
    totalChars,
    truncated: start > 0,
  };
}

describe('continue transcript tail', () => {
  it('caps Continue transcript to a whole-entry tail and preserves the last real user message', () => {
    const repoRoot = createRepo();
    const previousRequest = {
      id: 'req-1',
      userMessage: 'Finish tickets 1 through 10.',
      startedAt: '2026-04-04T09:00:00.000Z',
      loops: [],
    };
    const currentRequest = {
      id: 'req-2',
      userMessage: '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.',
      startedAt: '2026-04-04T09:05:00.000Z',
      loops: [],
    };

    try {
      const rawEntries = [];
      const expectedLines = [];
      for (let index = 0; index < 80; index += 1) {
        const content = `ENTRY-${index}-START ${'x'.repeat(900)} ENTRY-${index}-END`;
        rawEntries.push({ type: 'claude', label: 'Developer', text: content });
        expectedLines.push(`Developer: ${content}`);
      }
      const chatLog = writeChatLog(repoRoot, rawEntries);
      const manifest = buildManifest(repoRoot, chatLog, currentRequest, [previousRequest]);
      const prompt = buildControllerPrompt(manifest, currentRequest);
      const state = parsePromptState(prompt);
      const expectedTail = selectExpectedTail(expectedLines);

      assert.equal(state.latest_user_message, 'Finish tickets 1 through 10.');
      assert.equal(state.recent_transcript[0], CONTINUE_NOTICE);
      assert.deepEqual(state.recent_transcript.slice(1), expectedTail.lines);
      assert.ok(expectedTail.truncated);
      assert.ok(expectedTail.totalChars >= 50_000);
      assert.ok(expectedTail.lines.length >= 1);
      assert.ok(expectedTail.lines.every((line) => /^Developer: ENTRY-\d+-START .* ENTRY-\d+-END$/.test(line)));
      assert.ok(expectedTail.lines.slice(1).reduce((sum, line) => sum + line.length, 0) < 50_000);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('keeps the newest single entry whole even when it alone exceeds the limit', () => {
    const repoRoot = createRepo();
    const previousRequest = {
      id: 'req-1',
      userMessage: 'Keep working.',
      startedAt: '2026-04-04T09:00:00.000Z',
      loops: [],
    };
    const currentRequest = {
      id: 'req-2',
      userMessage: '[CONTROLLER GUIDANCE] Resume from the latest blocker.',
      startedAt: '2026-04-04T09:05:00.000Z',
      loops: [],
    };

    try {
      const hugeContent = `HUGE-ENTRY-START ${'y'.repeat(55_000)} HUGE-ENTRY-END`;
      const chatLog = writeChatLog(repoRoot, [
        { type: 'user', text: 'Older message that should be omitted' },
        { type: 'claude', label: 'Developer', text: hugeContent },
      ]);
      const manifest = buildManifest(repoRoot, chatLog, currentRequest, [previousRequest]);
      const prompt = buildControllerPrompt(manifest, currentRequest);
      const state = parsePromptState(prompt);

      assert.equal(state.recent_transcript[0], CONTINUE_NOTICE);
      assert.deepEqual(state.recent_transcript.slice(1), [`Developer: ${hugeContent}`]);
      assert.match(state.recent_transcript[1], /HUGE-ENTRY-START/);
      assert.match(state.recent_transcript[1], /HUGE-ENTRY-END/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not cap non-Continue overridden controller prompts', () => {
    const repoRoot = createRepo();
    const currentRequest = {
      id: 'req-1',
      userMessage: 'Review the completed feature.',
      startedAt: '2026-04-04T09:05:00.000Z',
      loops: [],
    };

    try {
      const rawEntries = [];
      const expectedLines = [];
      for (let index = 0; index < 30; index += 1) {
        const content = `NORMAL-${index}-START ${'z'.repeat(400)} NORMAL-${index}-END`;
        rawEntries.push({ type: 'controller', label: 'Continue', text: content });
        expectedLines.push(`Continue: ${content}`);
      }
      const chatLog = writeChatLog(repoRoot, rawEntries);
      const manifest = buildManifest(repoRoot, chatLog, currentRequest);
      const prompt = buildControllerPrompt(manifest, currentRequest);
      const state = parsePromptState(prompt);

      assert.equal(state.latest_user_message, 'Review the completed feature.');
      assert.deepEqual(state.recent_transcript, expectedLines);
      assert.doesNotMatch(prompt, /Earlier transcript omitted/);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses the transcript tail reader for overridden Continue prompts instead of full file reads', () => {
    const repoRoot = createRepo();
    const previousRequest = {
      id: 'req-1',
      userMessage: 'Keep moving forward.',
      startedAt: '2026-04-04T09:00:00.000Z',
      loops: [],
    };
    const currentRequest = {
      id: 'req-2',
      userMessage: '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.',
      startedAt: '2026-04-04T09:05:00.000Z',
      loops: [],
    };

    try {
      const transcriptEntries = [];
      for (let index = 0; index < 160; index += 1) {
        transcriptEntries.push({
          v: 2,
          ts: `2026-04-04T09:${String(index % 60).padStart(2, '0')}:00.000Z`,
          kind: 'assistant_message',
          sessionKey: 'worker:default',
          backend: 'worker:codex',
          labelHint: 'Developer',
          text: `TAIL-${index}-START ${'q'.repeat(700)} TAIL-${index}-END`,
          display: true,
        });
      }
      const transcriptFile = writeTranscriptLog(repoRoot, transcriptEntries);
      const chatLogFile = path.join(repoRoot, '.qpanda', 'chat.jsonl');
      const manifest = buildManifest(repoRoot, chatLogFile, currentRequest, [previousRequest], { transcriptFile });
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
        if (filePath === transcriptFile || filePath === chatLogFile) {
          throw new Error(`Unexpected full read of transcript/chat file: ${filePath}`);
        }
        return originalReadFileSync.call(this, filePath, ...args);
      };

      try {
        const prompt = buildControllerPrompt(manifest, currentRequest);
        const state = parsePromptState(prompt);
        assert.equal(state.recent_transcript[0], CONTINUE_NOTICE);
        assert.ok(state.recent_transcript.length > 1);
        assert.ok(state.recent_transcript.some((line) => line.includes('TAIL-159-START')));
      } finally {
        fs.readFileSync = originalReadFileSync;
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses the transcript tail reader for default Continue prompts instead of full file reads', () => {
    const repoRoot = createRepo();
    const currentRequest = {
      id: 'req-1',
      userMessage: '[CONTROLLER GUIDANCE] Resume from the latest blocker.',
      startedAt: '2026-04-04T09:05:00.000Z',
      loops: [],
    };

    try {
      const transcriptEntries = [];
      for (let index = 0; index < 140; index += 1) {
        transcriptEntries.push({
          v: 2,
          ts: `2026-04-04T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
          kind: 'assistant_message',
          sessionKey: 'worker:default',
          backend: 'worker:codex',
          labelHint: 'Developer',
          text: `DEFAULT-${index}-START ${'r'.repeat(700)} DEFAULT-${index}-END`,
          display: true,
        });
      }
      const transcriptFile = writeTranscriptLog(repoRoot, transcriptEntries);
      const chatLogFile = path.join(repoRoot, '.qpanda', 'chat.jsonl');
      const manifest = buildManifest(repoRoot, chatLogFile, currentRequest, [], {
        transcriptFile,
        controllerSystemPrompt: null,
      });
      const originalReadFileSync = fs.readFileSync;
      fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
        if (filePath === transcriptFile || filePath === chatLogFile) {
          throw new Error(`Unexpected full read of transcript/chat file: ${filePath}`);
        }
        return originalReadFileSync.call(this, filePath, ...args);
      };

      try {
        const prompt = buildControllerPrompt(manifest, currentRequest);
        const state = parsePromptState(prompt);
        assert.equal(state.recent_transcript[0], CONTINUE_NOTICE);
        assert.ok(state.recent_transcript.length > 1);
        assert.ok(state.recent_transcript.some((line) => line.includes('DEFAULT-139-START')));
      } finally {
        fs.readFileSync = originalReadFileSync;
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('preserves absolute line numbers in tailed transcripts so compaction does not hide recent messages', () => {
    const repoRoot = createRepo();
    const currentRequest = {
      id: 'req-1',
      userMessage: '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.',
      startedAt: '2026-04-04T10:05:00.000Z',
      loops: [],
    };

    try {
      const transcriptEntries = [];
      for (let index = 0; index < 80; index += 1) {
        transcriptEntries.push({
          v: 2,
          ts: `2026-04-04T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
          kind: 'assistant_message',
          sessionKey: 'worker:default',
          backend: 'worker:codex',
          labelHint: 'Developer',
          text: `OLDER-${index}-START ${'s'.repeat(180)} OLDER-${index}-END`,
          display: true,
        });
      }
      transcriptEntries.push({
        v: 2,
        ts: '2026-04-04T11:59:00.000Z',
        kind: 'context_compaction',
        sessionKey: 'worker:default',
        backend: 'worker:codex',
        labelHint: 'Developer',
        text: 'Earlier context compacted.',
        compaction: {
          compactedThroughLine: 81,
          preservedLines: [],
        },
        display: true,
      });
      for (let index = 0; index < 6; index += 1) {
        transcriptEntries.push({
          v: 2,
          ts: `2026-04-04T12:0${index}:00.000Z`,
          kind: 'assistant_message',
          sessionKey: 'worker:default',
          backend: 'worker:codex',
          labelHint: 'Developer',
          text: `RECENT-${index}-START ${'t'.repeat(900)} RECENT-${index}-END`,
          display: true,
        });
      }

      const transcriptFile = writeTranscriptLog(repoRoot, transcriptEntries);
      const chatLogFile = path.join(repoRoot, '.qpanda', 'chat.jsonl');
      const manifest = buildManifest(repoRoot, chatLogFile, currentRequest, [], {
        transcriptFile,
        controllerSystemPrompt: null,
      });

      const tailState = readTranscriptTailEntriesSync(transcriptFile, { bytes: 12 * 1024 });
      assert.ok(tailState.startOffset > 0, 'expected a sliced tail read');
      assert.ok(tailState.entries.some((entry) => entry.kind === 'context_compaction'));

      const compactionEntry = tailState.entries.find((entry) => entry.kind === 'context_compaction');
      assert.equal(compactionEntry.__lineNumber, 81);
      const recentEntries = tailState.entries.filter((entry) => /RECENT-\d+-START/.test(entry.text || ''));
      assert.ok(recentEntries.length >= 1);
      assert.ok(recentEntries.every((entry) => entry.__lineNumber > 81));

      const view = buildMergedRunView(tailState.entries, manifest);
      assert.ok(view.some((line) => line.includes('RECENT-5-START')));
      assert.ok(view.some((line) => line.includes('RECENT-0-START')));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
