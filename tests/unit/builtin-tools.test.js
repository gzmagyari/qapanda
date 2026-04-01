const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startBuiltinToolsServer } = require('../../src/builtin-tools-mcp');

let tmpDir, mcp;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-tools-test-'));
  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'line one\nline two\nline three\nline four\nline five\n');
  fs.writeFileSync(path.join(tmpDir, 'code.js'), 'const x = 1;\nconst y = 2;\nconst z = x + y;\n');
  fs.mkdirSync(path.join(tmpDir, 'subdir'));
  fs.writeFileSync(path.join(tmpDir, 'subdir', 'nested.txt'), 'nested content\n');
  mcp = await startBuiltinToolsServer(tmpDir);
});

after(async () => {
  if (mcp) await mcp.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function callTool(name, args) {
  const result = await mcp.client.callTool({ name, arguments: args });
  return result.content.map(c => c.text).join('\n');
}

describe('Built-in MCP — listTools', () => {
  it('returns all 7 tools', async () => {
    const result = await mcp.client.listTools();
    assert.equal(result.tools.length, 7);
    const names = result.tools.map(t => t.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('run_command'));
    assert.ok(names.includes('glob_search'));
    assert.ok(names.includes('grep_search'));
    assert.ok(names.includes('list_directory'));
  });

  it('all tools have MCP format (name, description, inputSchema)', async () => {
    const result = await mcp.client.listTools();
    for (const tool of result.tools) {
      assert.ok(tool.name, 'should have name');
      assert.ok(tool.description, 'should have description');
      assert.ok(tool.inputSchema, 'should have inputSchema');
    }
  });
});

describe('Built-in MCP — read_file', () => {
  it('reads existing file with line numbers', async () => {
    const result = await callTool('read_file', { path: 'hello.txt' });
    assert.ok(result.includes('1\tline one'));
    assert.ok(result.includes('5\tline five'));
  });

  it('reads with start_line and end_line range', async () => {
    const result = await callTool('read_file', { path: 'hello.txt', start_line: 2, end_line: 3 });
    assert.ok(result.includes('2\tline two'));
    assert.ok(result.includes('3\tline three'));
    assert.ok(!result.includes('1\tline one'));
  });

  it('returns error for non-existent file', async () => {
    const result = await callTool('read_file', { path: 'nope.txt' });
    assert.ok(result.includes('Error'));
  });
});

describe('Built-in MCP — write_file', () => {
  it('creates new file', async () => {
    const result = await callTool('write_file', { path: 'new.txt', content: 'hello world' });
    assert.ok(result.includes('File written'));
    assert.equal(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf8'), 'hello world');
  });

  it('overwrites existing file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'overwrite.txt'), 'old');
    await callTool('write_file', { path: 'overwrite.txt', content: 'new' });
    assert.equal(fs.readFileSync(path.join(tmpDir, 'overwrite.txt'), 'utf8'), 'new');
  });
});

describe('Built-in MCP — edit_file', () => {
  it('replaces old_string with new_string', async () => {
    fs.writeFileSync(path.join(tmpDir, 'edit.txt'), 'foo bar baz');
    const result = await callTool('edit_file', { path: 'edit.txt', old_string: 'bar', new_string: 'qux' });
    assert.ok(result.includes('File edited'));
    assert.equal(fs.readFileSync(path.join(tmpDir, 'edit.txt'), 'utf8'), 'foo qux baz');
  });

  it('fails when old_string not found', async () => {
    fs.writeFileSync(path.join(tmpDir, 'edit2.txt'), 'abc');
    const result = await callTool('edit_file', { path: 'edit2.txt', old_string: 'xyz', new_string: '123' });
    assert.ok(result.includes('not found'));
  });

  it('handles replace_all', async () => {
    fs.writeFileSync(path.join(tmpDir, 'edit3.txt'), 'aaa bbb aaa');
    await callTool('edit_file', { path: 'edit3.txt', old_string: 'aaa', new_string: 'ccc', replace_all: true });
    assert.equal(fs.readFileSync(path.join(tmpDir, 'edit3.txt'), 'utf8'), 'ccc bbb ccc');
  });
});

describe('Built-in MCP — run_command', () => {
  it('executes simple command and returns stdout', async () => {
    const result = await callTool('run_command', { command: 'echo hello' });
    assert.ok(result.includes('hello'));
  });

  it('respects timeout', async () => {
    const result = await callTool('run_command', {
      command: process.platform === 'win32' ? 'ping -n 10 127.0.0.1' : 'sleep 10',
      timeout: 500,
    });
    assert.ok(result.includes('timed out') || result.includes('Error'));
  });
});

describe('Built-in MCP — grep_search', () => {
  it('finds content matching regex in a file', async () => {
    const result = await callTool('grep_search', { pattern: 'const', path: 'code.js' });
    assert.ok(result.includes('const x'));
  });

  it('returns no matches message', async () => {
    const result = await callTool('grep_search', { pattern: 'zzzzzzz', path: 'hello.txt' });
    assert.ok(result.includes('No matches'));
  });
});

describe('Built-in MCP — list_directory', () => {
  it('lists files and directories', async () => {
    const result = await callTool('list_directory', {});
    assert.ok(result.includes('hello.txt'));
    assert.ok(result.includes('[dir]'));
    assert.ok(result.includes('subdir'));
  });

  it('lists subdirectory', async () => {
    const result = await callTool('list_directory', { path: 'subdir' });
    assert.ok(result.includes('nested.txt'));
  });
});
