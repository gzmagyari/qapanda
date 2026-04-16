const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createMcpHttpServer } = require('../../extension/mcp-http-server');
const {
  MCP_BATCH_NAME,
  SEARCH_MCP_TOOLS_NAME,
  buildMcpBatchToolDefinition,
  buildMcpCapabilityIndex,
  buildSearchMcpToolDefinition,
  loadAllTools,
  loadToolCatalog,
  materializeToolDefinitions,
  searchToolCatalog,
  executeTool,
  closeAll,
  _mcpToolToOpenAI,
  _sanitizeToolNamePart,
} = require('../../src/mcp-tool-bridge');

let tmpDir;
let tmpDir2;
const builtinServerPath = path.resolve(__dirname, '../../extension/builtin-tools-mcp-server.js');

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-bridge-test-'));
  tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-bridge-test-'));
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello world\n');
  fs.writeFileSync(path.join(tmpDir2, 'test.txt'), 'second workspace\n');
});

describe('lazy MCP catalog helpers', () => {
  it('builds a searchable catalog and materializes only the visible subset', async () => {
    const catalog = await loadToolCatalog(builtinMcpConfig(), tmpDir);
    assert.equal(catalog.toolCount, 7);
    const visible = materializeToolDefinitions(catalog, ['builtin_tools__read_file', 'builtin_tools__list_directory']);
    assert.deepEqual(
      visible.map((tool) => tool.function.name),
      ['builtin_tools__list_directory', 'builtin_tools__read_file']
    );
  });

  it('finds tool matches deterministically by name and description', async () => {
    const catalog = await loadToolCatalog(builtinMcpConfig(), tmpDir);
    const matches = searchToolCatalog(catalog, 'read file', { maxResults: 3 });
    assert.ok(matches.length > 0);
    assert.equal(matches[0].name, 'builtin_tools__read_file');
  });

  it('exposes a synthetic search_mcp_tools definition', () => {
    const tool = buildSearchMcpToolDefinition();
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, SEARCH_MCP_TOOLS_NAME);
    assert.ok(tool.function.parameters.required.includes('query'));
  });

  it('exposes a synthetic mcp_batch definition', () => {
    const tool = buildMcpBatchToolDefinition();
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, MCP_BATCH_NAME);
    assert.ok(tool.function.parameters.required.includes('calls'));
  });

  it('builds a deterministic MCP capability index grouped by server name', () => {
    const index = buildMcpCapabilityIndex({
      entries: [
        {
          name: 'cc_tasks__add_comment',
          serverName: 'cc_tasks',
          originalName: 'add_comment',
          description: 'Add a comment',
          parameters: { type: 'object', properties: { task_id: { type: 'string' } } },
        },
        {
          name: 'builtin_tools__read_file',
          serverName: 'builtin_tools',
          originalName: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
        {
          name: 'cc_tasks__search_tasks',
          serverName: 'cc_tasks',
          originalName: 'search_tasks',
          description: 'Search tasks',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
        {
          name: 'builtin_tools__grep_search',
          serverName: 'builtin_tools',
          originalName: 'grep_search',
          description: 'Search file contents',
          parameters: { type: 'object', properties: { pattern: { type: 'string' } } },
        },
      ],
    });

    assert.equal(
      index,
      [
        'builtin_tools: grep_search, read_file',
        'cc_tasks: add_comment, search_tasks',
      ].join('\n')
    );
    assert.equal(index.includes('description'), false);
    assert.equal(index.includes('properties'), false);
    assert.equal(index.includes('builtin_tools__read_file'), false);
  });
});

after(async () => {
  await closeAll();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch {}
});

function builtinMcpConfig() {
  return {
    'builtin-tools': { command: 'node', args: [builtinServerPath], env: { CWD: tmpDir } },
  };
}

function resultText(result) {
  return ((result && result.content) || [])
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

describe('_mcpToolToOpenAI', () => {
  it('converts MCP tool schema to OpenAI function format', () => {
    const mcpTool = {
      name: 'read_resource',
      description: 'Read a resource',
      inputSchema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] },
    };
    const result = _mcpToolToOpenAI('my-server', mcpTool);
    assert.equal(result.type, 'function');
    assert.equal(result.function.name, 'my_server__read_resource');
    assert.equal(result.function.description, 'Read a resource');
    assert.equal(result._mcpServer, 'my-server');
    assert.equal(result._mcpOriginalName, 'read_resource');
  });

  it('sanitizes dotted MCP tool names for strict OpenAI-compatible providers', () => {
    const mcpTool = {
      name: 'chat.search',
      description: 'Search chat history',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const result = _mcpToolToOpenAI('chat-search', mcpTool);
    assert.equal(result.function.name, 'chat_search__chat_x2e_search');
    assert.match(result.function.name, /^[a-zA-Z0-9_-]+$/);
    assert.equal(_sanitizeToolNamePart('chat.list_sessions'), 'chat_x2e_list_sessions');
  });
});

describe('loadAllTools — via stdio MCP', () => {
  it('loads all 7 built-in tools through stdio MCP server', async () => {
    const tools = await loadAllTools(builtinMcpConfig(), tmpDir);
    const names = tools.map(t => t.function.name);
    assert.ok(names.some(n => n.includes('read_file')), 'should have read_file');
    assert.ok(names.some(n => n.includes('write_file')), 'should have write_file');
    assert.ok(names.some(n => n.includes('edit_file')), 'should have edit_file');
    assert.ok(names.some(n => n.includes('run_command')), 'should have run_command');
    assert.ok(names.some(n => n.includes('glob_search')), 'should have glob_search');
    assert.ok(names.some(n => n.includes('grep_search')), 'should have grep_search');
    assert.ok(names.some(n => n.includes('list_directory')), 'should have list_directory');
    assert.equal(tools.length, 7);
  });

  it('returns 0 tools with no MCP servers', async () => {
    const tools = await loadAllTools({}, tmpDir);
    assert.equal(tools.length, 0);
  });

  it('gracefully handles broken MCP server', async () => {
    const tools = await loadAllTools({
      ...builtinMcpConfig(),
      'broken-server': { command: 'nonexistent-binary-xyz', args: [] },
    }, tmpDir);
    assert.ok(tools.length >= 7, 'should still have built-in tools');
  });

  it('reconnects when server config changes but names stay the same', async () => {
    const configA = {
      'builtin-tools': { command: 'node', args: [builtinServerPath], env: { CWD: tmpDir } },
    };
    const configB = {
      'builtin-tools': { command: 'node', args: [builtinServerPath], env: { CWD: tmpDir2 } },
    };

    await loadAllTools(configA, tmpDir);
    const first = await executeTool(
      { function: { name: 'builtin_tools__read_file', arguments: JSON.stringify({ path: 'test.txt' }) } },
      configA, tmpDir
    );
    await loadAllTools(configB, tmpDir2);
    const second = await executeTool(
      { function: { name: 'builtin_tools__read_file', arguments: JSON.stringify({ path: 'test.txt' }) } },
      configB, tmpDir2
    );

    assert.ok(resultText(first).includes('hello world'));
    assert.ok(resultText(second).includes('second workspace'));
  });
});

describe('executeTool — routes through stdio MCP', () => {
  it('routes read_file to builtin-tools MCP', async () => {
    await loadAllTools(builtinMcpConfig(), tmpDir);
    const result = await executeTool(
      { function: { name: 'builtin_tools__read_file', arguments: JSON.stringify({ path: 'test.txt' }) } },
      builtinMcpConfig(), tmpDir
    );
    assert.ok(resultText(result).includes('hello world'));
  });

  it('routes write_file to builtin-tools MCP', async () => {
    await loadAllTools(builtinMcpConfig(), tmpDir);
    await executeTool(
      { function: { name: 'builtin_tools__write_file', arguments: JSON.stringify({ path: 'written.txt', content: 'from bridge' }) } },
      builtinMcpConfig(), tmpDir
    );
    assert.equal(fs.readFileSync(path.join(tmpDir, 'written.txt'), 'utf8'), 'from bridge');
  });

  it('routes run_command to builtin-tools MCP', async () => {
    await loadAllTools(builtinMcpConfig(), tmpDir);
    const result = await executeTool(
      { function: { name: 'builtin_tools__run_command', arguments: JSON.stringify({ command: 'echo bridge_test' }) } },
      builtinMcpConfig(), tmpDir
    );
    assert.ok(resultText(result).includes('bridge_test'));
  });

  it('returns error for unknown tool', async () => {
    await loadAllTools(builtinMcpConfig(), tmpDir);
    const result = await executeTool(
      { function: { name: 'totally_unknown_tool', arguments: '{}' } },
      builtinMcpConfig(), tmpDir
    );
    assert.equal(result.isError, true);
    assert.ok(resultText(result).includes('Error'));
    assert.ok(resultText(result).includes('unknown'));
  });

  it('returns a tool error for malformed JSON arguments', async () => {
    await loadAllTools(builtinMcpConfig(), tmpDir);
    const result = await executeTool(
      { function: { name: 'builtin_tools__read_file', arguments: '{"path":' } },
      builtinMcpConfig(), tmpDir
    );
    assert.equal(result.isError, true);
    assert.ok(resultText(result).includes('Error executing tool'));
  });

  it('routes sanitized dotted HTTP MCP tool names back to the original MCP name', async () => {
    const server = await createMcpHttpServer({
      serverName: 'chat-search',
      tools: [{
        name: 'chat.search',
        description: 'Search chat history',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      handleToolCall(name, args) {
        return JSON.stringify({ name, args });
      },
    });
    try {
      const config = {
        'chat-search': { url: `http://127.0.0.1:${server.port}/mcp` },
      };
      const tools = await loadAllTools(config, tmpDir);
      const dottedTool = tools.find((tool) => tool.function && tool.function.name === 'chat_search__chat_x2e_search');
      assert.ok(dottedTool, 'expected chat.search tool to be loaded');
      assert.match(dottedTool.function.name, /^[a-zA-Z0-9_-]+$/);

      const result = await executeTool(
        {
          function: {
            name: dottedTool.function.name,
            arguments: JSON.stringify({ query: 'hello' }),
          },
        },
        config,
        tmpDir
      );
      const text = resultText(result);
      assert.ok(text.includes('chat.search'));
      assert.ok(text.includes('hello'));
    } finally {
      await server.close();
    }
  });
});
