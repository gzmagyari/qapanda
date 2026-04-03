const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleToolCall } = require('../../extension/memory-mcp-core');

function createMemoryFile(content = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-memory-mcp-'));
  const file = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function call(name, args, file) {
  return JSON.parse(handleToolCall(name, args || {}, file));
}

describe('memory-mcp-core', () => {
  it('returns full memory content and exact line slices', () => {
    const { dir, file } = createMemoryFile('alpha\nbeta\ngamma\ndelta\n');
    try {
      const full = call('get_memory', {}, file);
      assert.equal(full.total_lines, 4);
      assert.equal(full.content, 'alpha\nbeta\ngamma\ndelta\n');

      const slice = call('get_memory', { from_line: 2, to_line: 3 }, file);
      assert.equal(slice.from_line, 2);
      assert.equal(slice.to_line, 3);
      assert.equal(slice.content, 'beta\ngamma');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('searches by keyword with bounded context and supports zero context lines', () => {
    const { dir, file } = createMemoryFile(
      'first line\nsecond alpha beta\nthird line\nfourth alpha beta\nfifth line\n'
    );
    try {
      const result = call('search_memory', {
        query: 'alpha beta',
        context_before: 0,
        context_after: 1,
        max_matches: 1,
        max_total_lines: 2,
      }, file);

      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].line, 2);
      assert.equal(result.matches[0].start_line, 2);
      assert.equal(result.matches[0].end_line, 3);
      assert.deepEqual(result.matches[0].context, [
        { line: 2, text: 'second alpha beta' },
        { line: 3, text: 'third line' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('searches by regex and respects max_total_lines truncation', () => {
    const { dir, file } = createMemoryFile('match one\nline 2\nmatch two\nline 4\nmatch three\n');
    try {
      const result = call('search_memory', {
        regex: 'match',
        context_before: 0,
        context_after: 1,
        max_matches: 10,
        max_total_lines: 4,
      }, file);

      assert.equal(result.matches.length, 2);
      assert.equal(result.truncated, true);
      assert.equal(result.matches[0].line, 1);
      assert.equal(result.matches[1].line, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces text in single-match mode and rejects zero or ambiguous matches', () => {
    const { dir, file } = createMemoryFile('one target\nsecond target\nunique value\n');
    try {
      const success = call('replace_memory_text', {
        find: 'unique value',
        replace: 'updated value',
      }, file);
      assert.equal(success.matches_replaced, 1);
      assert.match(fs.readFileSync(file, 'utf8'), /updated value/);

      assert.throws(
        () => handleToolCall('replace_memory_text', { find: 'missing', replace: 'x' }, file),
        /found 0 matches/
      );
      assert.throws(
        () => handleToolCall('replace_memory_text', { find: 'target', replace: 'x' }, file),
        /be more specific or set replace_all=true/
      );

      const all = call('replace_memory_text', {
        find: 'target',
        replace: 'replacement',
        replace_all: true,
      }, file);
      assert.equal(all.matches_replaced, 2);
      assert.equal((fs.readFileSync(file, 'utf8').match(/replacement/g) || []).length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces exact line ranges deterministically', () => {
    const { dir, file } = createMemoryFile('line one\nline two\nline three\nline four\n');
    try {
      const result = call('replace_memory_lines', {
        from_line: 2,
        to_line: 3,
        content: 'new two\nnew three',
      }, file);
      assert.equal(result.from_line, 2);
      assert.equal(result.to_line, 3);
      assert.equal(result.inserted_lines, 2);
      assert.equal(
        fs.readFileSync(file, 'utf8'),
        'line one\nnew two\nnew three\nline four'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
