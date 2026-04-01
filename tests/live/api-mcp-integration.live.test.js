const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer } = require('../unit/llm-mock-server');
const { createApiTestDir, createApiTestManifest, createApiTestRenderer, createMultiTurnHandler } = require('../helpers/api-test-utils');
const { loadAllTools, executeTool } = require('../../src/mcp-tool-bridge');
const { runApiWorkerTurn } = require('../../src/api-worker');

let mock, tmp;
before(async () => { mock = await createMockServer(); tmp = createApiTestDir(); });
after(async () => { if (mock) await mock.close(); if (tmp) tmp.cleanup(); });

describe('API MCP Integration — built-in tools always loaded', () => {
  it('loadAllTools returns all 7 built-in tools with no MCPs', async () => {
    const tools = await loadAllTools({}, tmp.dir);
    const names = tools.map(t => t.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('run_command'));
    assert.ok(names.includes('glob_search'));
    assert.ok(names.includes('grep_search'));
    assert.ok(names.includes('list_directory'));
    assert.equal(tools.length, 7);
  });
});

describe('API MCP Integration — tool execution routing', () => {
  it('routes read_file to built-in handler', async () => {
    const result = await executeTool(
      { function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) } },
      {},
      tmp.dir
    );
    assert.ok(result.includes('Hello world'));
  });

  it('routes write_file to built-in handler', async () => {
    await executeTool(
      { function: { name: 'write_file', arguments: JSON.stringify({ path: 'mcp-test.txt', content: 'from mcp test' }) } },
      {},
      tmp.dir
    );
    const fs = require('node:fs');
    const path = require('node:path');
    assert.equal(fs.readFileSync(path.join(tmp.dir, 'mcp-test.txt'), 'utf8'), 'from mcp test');
  });

  it('returns error for unknown tool', async () => {
    const result = await executeTool(
      { function: { name: 'totally_fake_mcp__unknown_tool', arguments: '{}' } },
      {},
      tmp.dir
    );
    assert.ok(result.includes('Error'));
  });
});

describe('API MCP Integration — worker uses tools from bridge', () => {
  it('worker calls built-in tool through unified bridge', async () => {
    mock.setHandler(createMultiTurnHandler([
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'hello.txt' } }] },
      { text: 'File content retrieved successfully.' },
    ]));
    const manifest = createApiTestManifest(mock.url, tmp.dir);
    const renderer = createApiTestRenderer();
    const result = await runApiWorkerTurn({
      manifest,
      request: { id: 'r1' },
      loop: { controller: {} },
      workerRecord: {},
      prompt: 'read hello.txt',
      renderer,
      emitEvent: () => {},
    });
    assert.ok(result.resultText.includes('retrieved'));
    assert.ok(renderer.output.some(o => o.text && o.text.includes('read_file')));
    assert.ok(renderer.output.some(o => o.text && o.text.includes('Finished')));
  });
});
