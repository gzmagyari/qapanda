const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockServer } = require('./llm-mock-server');
const { compactApiSessionHistory } = require('../../src/api-compaction');
const { createEmptyUsageSummary } = require('../../src/usage-summary');
const {
  buildSessionReplay,
  createTranscriptRecord,
  readTranscriptEntriesSync,
} = require('../../src/transcript');

let mock;
let tmpDir;

before(async () => {
  mock = await createMockServer();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-compaction-test-'));
});

after(async () => {
  if (mock) await mock.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function writeTranscript(entries, transcriptPath) {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  );
}

describe('API compaction', () => {
  it('preserves the stable opener and fresh tail tool context without replaying old images inline', async () => {
    mock.setHandler(() => ({ text: 'summarized earlier context' }));
    const transcriptPath = path.join(tmpDir, '.qpanda', 'runs', 'compact-test', 'transcript.jsonl');
    const entries = [
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'user',
        requestId: 'r1',
        text: 'take the first screenshot',
        payload: { role: 'user', content: 'take the first screenshot' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_old',
            type: 'function',
            function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
          }],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'call_old',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'b2xkLWltYWdl' }],
        },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'The first screenshot was captured.',
        payload: { role: 'assistant', content: 'The first screenshot was captured.' },
      }),
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'user',
        requestId: 'r2',
        text: 'take the latest screenshot',
        payload: { role: 'user', content: 'take the latest screenshot' },
      }),
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r2',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_new',
            type: 'function',
            function: { name: 'chrome_devtools__take_screenshot', arguments: '{}' },
          }],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r2',
        toolCallId: 'call_new',
        toolName: 'chrome_devtools__take_screenshot',
        result: {
          content: [{ type: 'image', mimeType: 'image/png', data: 'bmV3LWltYWdl' }],
        },
      }),
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'user',
        requestId: 'r3',
        text: 'continue from the latest screenshot',
        payload: { role: 'user', content: 'continue from the latest screenshot' },
      }),
    ];
    writeTranscript(entries, transcriptPath);

    const manifest = {
      runDir: path.join(tmpDir, '.qpanda', 'runs', 'compact-test'),
      files: {
        manifest: path.join(tmpDir, '.qpanda', 'runs', 'compact-test', 'manifest.json'),
        transcript: transcriptPath,
      },
      worker: {},
      usageSummary: createEmptyUsageSummary(),
    };

    const result = await compactApiSessionHistory({
      manifest,
      sessionKey: 'worker:agent:QA-Browser',
      backend: 'worker:api',
      provider: 'custom',
      apiKey: 'test-key',
      baseURL: mock.url + '/v1',
      model: 'test-model',
      triggerMessages: 1,
      keepRecentMessages: 2,
    });

    assert.equal(result.performed, true);

    const updatedEntries = readTranscriptEntriesSync(transcriptPath);
    const replay = buildSessionReplay(updatedEntries, 'worker:agent:QA-Browser', {
      inlineImageReplayMode: 'tail-only',
    });
    const imageMessages = replay.filter((message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part && part.type === 'image_url')
    );
    assert.equal(imageMessages.length, 0, 'historical replay should not keep inline screenshot payloads');
    assert.ok(
      replay.some((message) => message.role === 'tool' && /asset_id=asset_call_new/.test(String(message.content || ''))),
      'the latest screenshot should still be represented by text provenance'
    );
    assert.doesNotMatch(JSON.stringify(replay), /b2xkLWltYWdl/, 'older image payload should be removed from replay');
    assert.doesNotMatch(JSON.stringify(replay), /bmV3LWltYWdl/, 'latest image payload should also be removed from historical replay');

    const compactionEntries = updatedEntries.filter((entry) => entry.kind === 'context_compaction');
    assert.equal(compactionEntries.length, 1);
    assert.deepEqual(
      compactionEntries[0].compaction.preservedLines.length,
      1,
      'the first replay message is preserved to keep the cacheable prefix stable across compaction'
    );
  });

  it('preserves an entire assistant tool bundle when it is the stable opener', async () => {
    mock.setHandler(() => ({ text: 'summarized earlier context' }));
    const transcriptPath = path.join(tmpDir, '.qpanda', 'runs', 'compact-bundle-test', 'transcript.jsonl');
    const entries = [
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        payload: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'bundle-1',
              type: 'function',
              function: { name: 'cc_memory__get_memory', arguments: '{}' },
            },
            {
              id: 'bundle-2',
              type: 'function',
              function: { name: 'cc_tasks__list_tasks', arguments: '{}' },
            },
          ],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'bundle-1',
        toolName: 'cc_memory__get_memory',
        result: {
          content: [{ type: 'text', text: 'Memory contents' }],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'bundle-2',
        toolName: 'cc_tasks__list_tasks',
        result: {
          content: [{ type: 'text', text: 'Task list' }],
        },
      }),
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'user',
        requestId: 'r2',
        text: 'continue',
        payload: { role: 'user', content: 'continue' },
      }),
    ];
    writeTranscript(entries, transcriptPath);

    const manifest = {
      runDir: path.join(tmpDir, '.qpanda', 'runs', 'compact-bundle-test'),
      files: {
        manifest: path.join(tmpDir, '.qpanda', 'runs', 'compact-bundle-test', 'manifest.json'),
        transcript: transcriptPath,
      },
      worker: {},
      usageSummary: createEmptyUsageSummary(),
    };

    const result = await compactApiSessionHistory({
      manifest,
      sessionKey: 'worker:agent:QA-Browser',
      backend: 'worker:api',
      provider: 'custom',
      apiKey: 'test-key',
      baseURL: mock.url + '/v1',
      model: 'test-model',
      triggerMessages: 1,
      keepRecentMessages: 0,
    });

    assert.equal(result.performed, true);

    const updatedEntries = readTranscriptEntriesSync(transcriptPath);
    const compactionEntry = updatedEntries.find((entry) => entry.kind === 'context_compaction');
    assert.ok(compactionEntry, 'should append a compaction entry');
    assert.deepEqual(compactionEntry.compaction.preservedLines, [1, 2, 3]);

    const replay = buildSessionReplay(updatedEntries, 'worker:agent:QA-Browser', {
      inlineImageReplayMode: 'tail-only',
    });
    const summaryIndex = replay.findIndex((message) => message.role === 'assistant' && /summarized earlier context/.test(String(message.content || '')));
    const secondToolIndex = replay.findIndex((message) => message.role === 'tool' && message.tool_call_id === 'bundle-2');

    assert.ok(replay[0] && Array.isArray(replay[0].tool_calls), 'bundle opener assistant message should be preserved');
    assert.ok(secondToolIndex >= 0, 'both tool results should remain in replay');
    assert.ok(summaryIndex > secondToolIndex, 'summary must be inserted after the full preserved tool bundle');
  });

  it('preserves raw tool-call and backend history rows for kept tool bundles', async () => {
    mock.setHandler(() => ({ text: 'summarized earlier context' }));
    const transcriptPath = path.join(tmpDir, '.qpanda', 'runs', 'compact-raw-bundle-test', 'transcript.jsonl');
    const entries = [
      createTranscriptRecord({
        kind: 'assistant_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'Checking page state.',
        payload: {
          role: 'assistant',
          content: 'Checking page state.',
          tool_calls: [{
            id: 'pages-1',
            type: 'function',
            function: { name: 'chrome_devtools__list_pages', arguments: '{}' },
          }],
        },
      }),
      createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'pages-1',
        toolName: 'chrome_devtools__list_pages',
        input: {},
      }),
      createTranscriptRecord({
        kind: 'backend_event',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        text: 'Checking page state.',
        payload: { source: 'worker-api', type: 'assistant_message', text: 'Checking page state.' },
      }),
      createTranscriptRecord({
        kind: 'ui_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        payload: { type: 'mcpCardStart', text: 'Listed pages' },
      }),
      createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'worker:api',
        requestId: 'r1',
        toolCallId: 'pages-1',
        toolName: 'chrome_devtools__list_pages',
        result: {
          content: [{ type: 'text', text: '## Pages\n1: https://example.com [selected]' }],
        },
      }),
      createTranscriptRecord({
        kind: 'user_message',
        sessionKey: 'worker:agent:QA-Browser',
        backend: 'user',
        requestId: 'r2',
        text: 'continue',
        payload: { role: 'user', content: 'continue' },
      }),
    ];
    writeTranscript(entries, transcriptPath);

    const manifest = {
      runDir: path.join(tmpDir, '.qpanda', 'runs', 'compact-raw-bundle-test'),
      files: {
        manifest: path.join(tmpDir, '.qpanda', 'runs', 'compact-raw-bundle-test', 'manifest.json'),
        transcript: transcriptPath,
      },
      worker: {},
      usageSummary: createEmptyUsageSummary(),
    };

    const result = await compactApiSessionHistory({
      manifest,
      sessionKey: 'worker:agent:QA-Browser',
      backend: 'worker:api',
      provider: 'custom',
      apiKey: 'test-key',
      baseURL: mock.url + '/v1',
      model: 'test-model',
      triggerMessages: 1,
      keepRecentMessages: 0,
    });

    assert.equal(result.performed, true);

    const updatedEntries = readTranscriptEntriesSync(transcriptPath);
    const compactionEntry = updatedEntries.find((entry) => entry.kind === 'context_compaction');
    assert.ok(compactionEntry, 'should append a compaction entry');
    assert.deepEqual(compactionEntry.compaction.preservedLines, [1, 2, 3, 4, 5]);
  });
});
