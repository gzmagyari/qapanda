const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeClaudeEvent, summarizeCodexEvent, summarizeCodexWorkerEvent } = require('../../src/events');

describe('summarizeClaudeEvent', () => {
  it('returns null for null/undefined input', () => {
    assert.equal(summarizeClaudeEvent(null), null);
    assert.equal(summarizeClaudeEvent(undefined), null);
    assert.equal(summarizeClaudeEvent('string'), null);
  });

  it('parses result event (string result)', () => {
    const evt = { type: 'result', result: 'Hello world' };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'final-text');
    assert.equal(summary.text, 'Hello world');
    assert.equal(summary.source, 'worker');
  });

  it('parses result_message event', () => {
    const evt = { type: 'result_message', result: 'Done' };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'final-text');
    assert.equal(summary.text, 'Done');
  });

  it('parses result with no text as status', () => {
    const evt = { type: 'result', result: null };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'status');
  });

  it('parses text-delta from stream_event', () => {
    const evt = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'text-delta');
    assert.equal(summary.text, 'hello');
  });

  it('parses tool-input-delta from stream_event', () => {
    const evt = {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"cmd":' }, index: 1 },
    };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'tool-input-delta');
    assert.equal(summary.text, '{"cmd":');
    assert.equal(summary.index, 1);
  });

  it('parses tool-start from stream_event', () => {
    const evt = {
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' }, index: 0 },
    };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'tool-start');
    assert.equal(summary.toolName, 'Bash');
    assert.equal(summary.index, 0);
  });

  it('parses block-stop from stream_event', () => {
    const evt = {
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 2 },
    };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'block-stop');
    assert.equal(summary.index, 2);
  });

  it('parses error event', () => {
    const evt = { type: 'error', message: 'Something went wrong' };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'error');
    assert.ok(summary.text.includes('Something went wrong'));
  });

  it('parses assistant_message event', () => {
    const evt = { type: 'assistant_message', content: [{ type: 'text', text: 'Assistant says hi' }] };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.kind, 'assistant-text');
    assert.ok(summary.text.includes('Assistant says hi'));
  });

  it('returns null for unknown event types', () => {
    assert.equal(summarizeClaudeEvent({ type: 'unknown_thing' }), null);
  });

  it('handles Read tool start', () => {
    const evt = {
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' }, index: 0 },
    };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.toolName, 'Read');
  });

  it('handles Edit tool start', () => {
    const evt = {
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Edit' }, index: 0 },
    };
    const summary = summarizeClaudeEvent(evt);
    assert.equal(summary.toolName, 'Edit');
  });
});

describe('summarizeCodexEvent', () => {
  it('returns null for null/undefined input', () => {
    assert.equal(summarizeCodexEvent(null), null);
    assert.equal(summarizeCodexEvent(undefined), null);
  });

  it('parses thread.started', () => {
    const evt = { type: 'thread.started', thread_id: 'abc-123' };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'status');
    assert.ok(summary.text.includes('abc-123'));
  });

  it('parses turn.started', () => {
    const evt = { type: 'turn.started' };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'status');
    assert.ok(summary.text.includes('Thinking'));
  });

  it('parses turn.completed', () => {
    const evt = { type: 'turn.completed' };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'status');
  });

  it('parses turn.failed', () => {
    const evt = { type: 'turn.failed' };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'error');
  });

  it('parses error event', () => {
    const evt = { type: 'error', message: 'Controller error' };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'error');
    assert.ok(summary.text.includes('Controller error'));
  });

  it('parses command_execution item.started', () => {
    const evt = { type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'status');
    assert.ok(summary.text.includes('ls -la'));
  });

  it('parses mcp_tool_call item.started', () => {
    const evt = { type: 'item.started', item: { type: 'mcp_tool_call', server: 'cc-tasks', tool: 'create_task' } };
    const summary = summarizeCodexEvent(evt);
    assert.equal(summary.kind, 'status');
    assert.ok(summary.text.includes('cc-tasks'));
  });

  it('parses context compaction start and finish events', () => {
    const started = summarizeCodexEvent({ type: 'item.started', item: { type: 'context_compaction' } });
    assert.equal(started.kind, 'compaction');
    assert.equal(started.active, true);
    assert.equal(started.text, 'Compacting chat context...');

    const completed = summarizeCodexEvent({ type: 'item.completed', item: { type: 'context_compaction' } });
    assert.equal(completed.kind, 'compaction');
    assert.equal(completed.active, false);
    assert.equal(completed.text, 'Finished compacting chat context.');

    const threadCompacted = summarizeCodexEvent({ type: 'thread.compacted' });
    assert.equal(threadCompacted.kind, 'compaction');
    assert.equal(threadCompacted.active, false);
  });

  it('returns null for unknown event types', () => {
    assert.equal(summarizeCodexEvent({ type: 'totally_unknown' }), null);
  });
});

describe('summarizeCodexWorkerEvent', () => {
  it('parses context compaction worker events', () => {
    const started = summarizeCodexWorkerEvent({ type: 'item.started', item: { type: 'context_compaction' } });
    assert.equal(started.kind, 'compaction');
    assert.equal(started.active, true);
    assert.equal(started.text, 'Compacting chat context...');

    const completed = summarizeCodexWorkerEvent({ type: 'codex.event.context_compacted' });
    assert.equal(completed.kind, 'compaction');
    assert.equal(completed.active, false);
    assert.equal(completed.text, 'Finished compacting chat context.');
  });
});
