const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer } = require('../unit/llm-mock-server');
const { createApiTestDir, createApiTestManifest, createApiTestRenderer, createMultiTurnHandler } = require('../helpers/api-test-utils');
const { runApiWorkerTurn } = require('../../src/api-worker');

let mock, tmp;
before(async () => { mock = await createMockServer(); tmp = createApiTestDir(); });
after(async () => { if (mock) await mock.close(); if (tmp) tmp.cleanup(); });

describe('API Streaming — text chunks', () => {
  it('text chunks arrive at renderer in order', async () => {
    mock.setHandler(() => ({ text: 'word1 word2 word3 word4 word5' }));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'hi', renderer, emitEvent: () => {},
    });
    const streams = renderer.output.filter(o => o.type === 'stream');
    assert.ok(streams.length >= 2, 'should have multiple stream chunks (got ' + streams.length + ')');
    // Verify text reconstructs correctly
    const fullText = streams.map(s => s.text).join('');
    assert.ok(fullText.includes('word1'));
    assert.ok(fullText.includes('word5'));
  });

  it('flushes stream after final text', async () => {
    mock.setHandler(() => ({ text: 'response text here' }));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'hi', renderer, emitEvent: () => {},
    });
    assert.ok(renderer.output.some(o => o.type === 'flush'), 'should flush stream');
  });
});

describe('API Streaming — tool call progress', () => {
  it('shows Calling and Finished messages for tool calls', async () => {
    mock.setHandler(createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'hello.txt' } }] },
      { text: 'Done.' },
    ]));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'read', renderer, emitEvent: () => {},
    });
    const claudeMessages = renderer.output.filter(o => o.type === 'claude').map(o => o.text);
    assert.ok(claudeMessages.some(m => m.includes('Calling') && m.includes('read_file')), 'should show Calling read_file');
    assert.ok(claudeMessages.some(m => m.includes('Finished') && m.includes('read_file')), 'should show Finished read_file');
  });

  it('shows tool name with path preview for file tools', async () => {
    mock.setHandler(createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'code.js' } }] },
      { text: 'Read it.' },
    ]));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'read code', renderer, emitEvent: () => {},
    });
    const calling = renderer.output.filter(o => o.type === 'claude').find(o => o.text.includes('Calling'));
    assert.ok(calling.text.includes('code.js'), 'should preview the file path');
  });
});

describe('API Streaming — events emitted', () => {
  it('emits start and complete events', async () => {
    mock.setHandler(() => ({ text: 'hi' }));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    const events = [];
    await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'hi', renderer, emitEvent: (e) => events.push(e),
    });
    assert.ok(events.some(e => e.type === 'start'), 'should emit start');
    assert.ok(events.some(e => e.type === 'complete'), 'should emit complete');
  });

  it('emits tool_call events for each tool invocation', async () => {
    mock.setHandler(createMultiTurnHandler([
      { toolCalls: [
        { id: 'c1', name: 'read_file', arguments: { path: 'hello.txt' } },
        { id: 'c2', name: 'list_directory', arguments: {} },
      ]},
      { text: 'Done.' },
    ]));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    const events = [];
    await runApiWorkerTurn({
      manifest, request: { id: 'r1' }, loop: { controller: {} },
      workerRecord: {}, prompt: 'explore', renderer, emitEvent: (e) => events.push(e),
    });
    const toolEvents = events.filter(e => e.type === 'tool_call');
    assert.equal(toolEvents.length, 2, 'should have 2 tool_call events');
    assert.ok(toolEvents.some(e => e.name === 'read_file'));
    assert.ok(toolEvents.some(e => e.name === 'list_directory'));
  });
});
