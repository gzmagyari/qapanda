const test = require('node:test');
const assert = require('node:assert/strict');

const { compactBackendTranscriptPayload } = require('../../src/orchestrator');

test('compactBackendTranscriptPayload summarizes non-tool backend events', () => {
  const payload = {
    type: 'item.completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'user_message',
      id: 'msg-1',
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'A'.repeat(6000),
        },
      ],
    },
  };

  const compacted = compactBackendTranscriptPayload(payload);
  assert.deepEqual(compacted.type, 'item.completed');
  assert.deepEqual(compacted.threadId, 'thread-1');
  assert.deepEqual(compacted.turnId, 'turn-1');
  assert.deepEqual(compacted.item.type, 'user_message');
  assert.deepEqual(compacted.item.id, 'msg-1');
  assert.deepEqual(compacted.item.role, 'user');
  assert.equal(typeof compacted.item.textPreview, 'string');
  assert.ok(compacted.item.textPreview.length < 5000);
  assert.equal(Object.prototype.hasOwnProperty.call(compacted.item, 'content'), false);
});

test('compactBackendTranscriptPayload preserves mcp tool events verbatim', () => {
  const payload = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      id: 'tool-1',
      server: 'chrome-devtools',
      tool: 'list_pages',
      arguments: { pageId: 8 },
      result: { ok: true },
    },
  };

  const compacted = compactBackendTranscriptPayload(payload);
  assert.deepEqual(compacted, payload);
});
