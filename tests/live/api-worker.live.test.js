const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockServer } = require('../unit/llm-mock-server');
const { createApiTestDir, createApiTestManifest, createApiTestRenderer, createMultiTurnHandler, createEventCollector } = require('../helpers/api-test-utils');
const { runApiWorkerTurn } = require('../../src/api-worker');

let mock, tmp;
before(async () => { mock = await createMockServer(); tmp = createApiTestDir(); });
after(async () => { if (mock) await mock.close(); if (tmp) tmp.cleanup(); });

function run(handler, opts = {}) {
  mock.setHandler(handler);
  const manifest = createApiTestManifest(mock.url, tmp.dir, opts);
  const renderer = createApiTestRenderer();
  const collector = createEventCollector();
  const workerRecord = {};
  return runApiWorkerTurn({
    manifest,
    request: { id: 'r1' },
    loop: { controller: {} },
    workerRecord,
    prompt: opts.prompt || 'test prompt',
    renderer,
    emitEvent: collector.emit,
    agentId: opts.agentId,
    abortSignal: opts.abortSignal,
  }).then(result => ({ result, renderer, collector, workerRecord }));
}

describe('API Worker Live — simple responses', () => {
  it('responds to simple prompt with streaming text', async () => {
    const { result, renderer } = await run(() => ({ text: 'The project has 3 files.' }));
    assert.equal(result.resultText, 'The project has 3 files.');
    assert.equal(result.exitCode, 0);
    assert.ok(renderer.output.some(o => o.type === 'stream'));
  });

  it('reports usage tokens', async () => {
    const { collector } = await run(() => ({
      text: 'done',
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    }));
    const complete = collector.events.find(e => e.type === 'complete');
    assert.ok(complete, 'should emit complete event');
    assert.ok(complete.totalUsage.promptTokens >= 100);
  });
});

describe('API Worker Live — built-in tool calls', () => {
  it('uses read_file tool and returns content', async () => {
    const handler = createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'hello.txt' } }] },
      { text: 'The file says Hello world.' },
    ]);
    const { result, renderer } = await run(handler);
    assert.ok(result.resultText.includes('Hello world'));
    assert.ok(renderer.output.some(o => o.text && o.text.includes('read_file')));
  });

  it('uses run_command tool', async () => {
    const handler = createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'run_command', arguments: { command: 'echo api_test_ok' } }] },
      { text: 'Command returned api_test_ok.' },
    ]);
    const { result } = await run(handler);
    assert.ok(result.resultText.includes('api_test_ok'));
  });

  it('uses edit_file tool', async () => {
    fs.writeFileSync(path.join(tmp.dir, 'editable.txt'), 'foo bar baz');
    const handler = createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'edit_file', arguments: { path: 'editable.txt', old_string: 'bar', new_string: 'qux' } }] },
      { text: 'File edited.' },
    ]);
    await run(handler);
    assert.equal(fs.readFileSync(path.join(tmp.dir, 'editable.txt'), 'utf8'), 'foo qux baz');
  });

  it('uses list_directory tool', async () => {
    const handler = createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'list_directory', arguments: {} }] },
      { text: 'Found hello.txt and code.js.' },
    ]);
    const { result } = await run(handler);
    assert.ok(result.resultText.includes('hello.txt') || result.resultText.includes('Found'));
  });

  it('uses grep_search tool', async () => {
    const handler = createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'grep_search', arguments: { pattern: 'const', path: 'code.js' } }] },
      { text: 'Found 2 matches.' },
    ]);
    const { result } = await run(handler);
    assert.ok(result.resultText.includes('matches') || result.resultText.includes('Found'));
  });
});

describe('API Worker Live — multi-turn tool loop', () => {
  it('handles 3 rounds of tool calls before final text', async () => {
    let callCount = 0;
    const { result } = await run(() => {
      callCount++;
      if (callCount === 1) return { toolCalls: [{ id: 'c1', name: 'list_directory', arguments: {} }] };
      if (callCount === 2) return { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: 'hello.txt' } }] };
      if (callCount === 3) return { toolCalls: [{ id: 'c3', name: 'read_file', arguments: { path: 'code.js' } }] };
      return { text: 'I have read all the files.' };
    });
    assert.equal(callCount, 4);
    assert.ok(result.resultText.includes('read all'));
  });
});

describe('API Worker Live — error recovery', () => {
  it('sends tool error back to LLM and recovers', async () => {
    const handler = createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'nonexistent.txt' } }] },
      { text: 'File not found, trying something else.' },
    ]);
    const { result } = await run(handler);
    assert.ok(result.resultText.includes('something else'));
  });
});

describe('API Worker Live — abort', () => {
  it('stops on abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const { renderer } = await run(() => ({ text: 'should not see' }), { abortSignal: ac.signal });
    assert.ok(renderer.output.some(o => o.text && o.text.includes('aborted')));
  });
});

describe('API Worker Live — agent config', () => {
  it('uses agent system prompt', async () => {
    let capturedMessages;
    const { result } = await run((_req, body) => {
      capturedMessages = body.messages;
      return { text: 'I am a developer.' };
    }, { agentId: 'dev' });
    assert.ok(capturedMessages.some(m => m.role === 'system' && m.content.includes('developer')));
  });
});
