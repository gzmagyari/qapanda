const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockServer } = require('./llm-mock-server');
const { compactApiSessionHistory } = require('../../src/api-compaction');
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
  it('preserves only the latest image context in replay after compaction', async () => {
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
      files: { transcript: transcriptPath },
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
    const replay = buildSessionReplay(updatedEntries, 'worker:agent:QA-Browser');
    const imageMessages = replay.filter((message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part && part.type === 'image_url')
    );

    assert.equal(imageMessages.length, 1, 'should preserve only one image message');
    const latestImageUrl = imageMessages[0].content.find((part) => part.type === 'image_url').image_url.url;
    assert.match(latestImageUrl, /bmV3LWltYWdl/, 'should preserve the latest image only');
    assert.doesNotMatch(JSON.stringify(replay), /b2xkLWltYWdl/, 'older image should be removed from replay');

    const compactionEntries = updatedEntries.filter((entry) => entry.kind === 'context_compaction');
    assert.equal(compactionEntries.length, 1);
    assert.deepEqual(
      compactionEntries[0].compaction.preservedLines.length,
      0,
      'latest image stayed in the raw tail, so the checkpoint itself should not preserve older image lines'
    );
  });
});
