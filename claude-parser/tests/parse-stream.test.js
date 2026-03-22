'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyLine, parseToolCall, isSpinnerLine, extractText, parseChunk } = require('../parse-stream');

// ── classifyLine ─────────────────────────────────────────────────────

test('classifyLine: response text with ● prefix', () => {
  const result = classifyLine('● Hello world');
  assert.deepStrictEqual(result, { type: 'text', text: 'Hello world' });
});

test('classifyLine: response text number', () => {
  const result = classifyLine('● 42');
  assert.deepStrictEqual(result, { type: 'text', text: '42' });
});

test('classifyLine: multi-word response', () => {
  const result = classifyLine('● The answer is 42.');
  assert.deepStrictEqual(result, { type: 'text', text: 'The answer is 42.' });
});

// Tool calls
test('classifyLine: Bash tool call', () => {
  const result = classifyLine('● Bash(echo hi)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Bash(echo hi)' });
});

test('classifyLine: Write tool call', () => {
  const result = classifyLine('● Write(foo.txt)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Write(foo.txt)' });
});

test('classifyLine: Edit tool call', () => {
  const result = classifyLine('● Edit(foo.txt)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Edit(foo.txt)' });
});

test('classifyLine: Read tool call', () => {
  const result = classifyLine('● Read(foo.txt)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Read(foo.txt)' });
});

test('classifyLine: Glob tool call', () => {
  const result = classifyLine('● Glob(*.js)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Glob(*.js)' });
});

test('classifyLine: Grep tool call', () => {
  const result = classifyLine('● Grep(pattern)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Grep(pattern)' });
});

test('classifyLine: Update tool call', () => {
  const result = classifyLine('● Update(foo.txt)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Update(foo.txt)' });
});

test('classifyLine: WebFetch tool call', () => {
  const result = classifyLine('● WebFetch(https://example.com)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'WebFetch(https://example.com)' });
});

test('classifyLine: WebSearch tool call', () => {
  const result = classifyLine('● WebSearch(query)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'WebSearch(query)' });
});

test('classifyLine: TodoWrite tool call', () => {
  const result = classifyLine('● TodoWrite(items)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'TodoWrite(items)' });
});

test('classifyLine: MCP tool call', () => {
  const result = classifyLine('● mcp__server__tool(args)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'mcp__server__tool(args)' });
});

test('classifyLine: tool call with bracket syntax', () => {
  const result = classifyLine('● Bash[command: echo hi]');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Bash[command: echo hi]' });
});

test('classifyLine: tool call with path containing backslash', () => {
  const result = classifyLine('● Write(claude-parser\\session-test.txt)');
  assert.deepStrictEqual(result, { type: 'tool', text: 'Write(claude-parser\\session-test.txt)' });
});

// Tool output
test('classifyLine: tool output with ⎿ prefix', () => {
  const result = classifyLine('  ⎿  Wrote 3 lines');
  assert.deepStrictEqual(result, { type: 'tool_out', text: 'Wrote 3 lines' });
});

test('classifyLine: tool output single word', () => {
  const result = classifyLine('  ⎿  Done');
  assert.deepStrictEqual(result, { type: 'tool_out', text: 'Done' });
});

test('classifyLine: empty tool output', () => {
  const result = classifyLine('  ⎿  ');
  assert.strictEqual(result, null);
});

test('classifyLine: bare ⎿', () => {
  const result = classifyLine('⎿');
  assert.strictEqual(result, null);
});

test('classifyLine: collapsed Read 1 file', () => {
  const result = classifyLine('Read 1 file (ctrl+o to expand)');
  assert.deepStrictEqual(result, { type: 'tool_out', text: 'Read 1 file (ctrl+o to expand)' });
});

test('classifyLine: collapsed Read 3 files', () => {
  const result = classifyLine('Read 3 files (ctrl+o to expand)');
  assert.deepStrictEqual(result, { type: 'tool_out', text: 'Read 3 files (ctrl+o to expand)' });
});

// Continuation text (indented)
test('classifyLine: continuation text with 2-space indent', () => {
  const result = classifyLine('  continuation text here');
  assert.deepStrictEqual(result, { type: 'text', text: 'continuation text here' });
});

test('classifyLine: continuation text with more indent', () => {
  const result = classifyLine('     deeply indented');
  assert.deepStrictEqual(result, { type: 'text', text: 'deeply indented' });
});

// UI chrome — should all return null
test('classifyLine: separator line', () => {
  assert.strictEqual(classifyLine('────────────────────────'), null);
});

test('classifyLine: status bar with ⏵⏵', () => {
  assert.strictEqual(classifyLine('  ⏵⏵ bypass permissions on (shift+tab to cycle)'), null);
});

test('classifyLine: status bar bypass permissions', () => {
  assert.strictEqual(classifyLine('bypass permissions on'), null);
});

test('classifyLine: user prompt with text', () => {
  assert.strictEqual(classifyLine('❯ some prompt'), null);
});

test('classifyLine: bare user prompt', () => {
  assert.strictEqual(classifyLine('❯'), null);
});

test('classifyLine: Tip message', () => {
  assert.strictEqual(classifyLine('Tip: Use git worktrees to run multiple sessions'), null);
});

test('classifyLine: spinner ✦', () => {
  assert.strictEqual(classifyLine('✦ Quantumizing…'), null);
});

test('classifyLine: spinner ◐', () => {
  assert.strictEqual(classifyLine('◐ Thinking…'), null);
});

test('classifyLine: spinner ✶', () => {
  assert.strictEqual(classifyLine('✶ Processing…'), null);
});

test('classifyLine: transient Reading file', () => {
  assert.strictEqual(classifyLine('Reading 1 file…'), null);
});

test('classifyLine: transient Reading files', () => {
  assert.strictEqual(classifyLine('Reading 3 files…'), null);
});

test('classifyLine: Running… noise', () => {
  assert.strictEqual(classifyLine('  Running…'), null);
});

test('classifyLine: ctrl+o noise', () => {
  assert.strictEqual(classifyLine('  (ctrl+o to expand)'), null);
});

test('classifyLine: Tip noise in continuation', () => {
  assert.strictEqual(classifyLine('  Tip: something'), null);
});

test('classifyLine: empty string', () => {
  assert.strictEqual(classifyLine(''), null);
});

test('classifyLine: whitespace only', () => {
  assert.strictEqual(classifyLine('   '), null);
});

test('classifyLine: bare ● with no text', () => {
  assert.strictEqual(classifyLine('●'), null);
});

test('classifyLine: ● with only spaces', () => {
  assert.strictEqual(classifyLine('●   '), null);
});

// ── parseToolCall ────────────────────────────────────────────────────

test('parseToolCall: Bash with parens', () => {
  const result = parseToolCall('Bash(echo hello)');
  assert.deepStrictEqual(result, { name: 'Bash', argsText: 'echo hello' });
});

test('parseToolCall: Write with path', () => {
  const result = parseToolCall('Write(path/to/file.txt)');
  assert.deepStrictEqual(result, { name: 'Write', argsText: 'path/to/file.txt' });
});

test('parseToolCall: bracket syntax', () => {
  const result = parseToolCall('Bash[command: echo hi]');
  assert.deepStrictEqual(result, { name: 'Bash', argsText: 'command: echo hi' });
});

test('parseToolCall: nested parens in args', () => {
  const result = parseToolCall('Bash(echo "hello (world)")');
  assert.deepStrictEqual(result, { name: 'Bash', argsText: 'echo "hello (world)"' });
});

test('parseToolCall: plain text returns null', () => {
  assert.strictEqual(parseToolCall('hello world'), null);
});

test('parseToolCall: empty string returns null', () => {
  assert.strictEqual(parseToolCall(''), null);
});

test('parseToolCall: MCP tool', () => {
  const result = parseToolCall('mcp__server__action(data)');
  assert.deepStrictEqual(result, { name: 'mcp__server__action', argsText: 'data' });
});

// ── isSpinnerLine ────────────────────────────────────────────────────

test('isSpinnerLine: ✦ spinner', () => {
  assert.strictEqual(isSpinnerLine('✦ Quantumizing…'), true);
});

test('isSpinnerLine: ◐ spinner', () => {
  assert.strictEqual(isSpinnerLine('◐ Thinking…'), true);
});

test('isSpinnerLine: ⠋ spinner', () => {
  assert.strictEqual(isSpinnerLine('⠋ Loading…'), true);
});

test('isSpinnerLine: · spinner', () => {
  assert.strictEqual(isSpinnerLine('· Working…'), true);
});

test('isSpinnerLine: * spinner', () => {
  assert.strictEqual(isSpinnerLine('* Processing…'), true);
});

test('isSpinnerLine: indented spinner', () => {
  assert.strictEqual(isSpinnerLine('  ✦ Thinking…'), true);
});

test('isSpinnerLine: ● is not a spinner', () => {
  assert.strictEqual(isSpinnerLine('● Hello'), false);
});

test('isSpinnerLine: plain text is not a spinner', () => {
  assert.strictEqual(isSpinnerLine('hello world'), false);
});

test('isSpinnerLine: spinner char without ellipsis', () => {
  assert.strictEqual(isSpinnerLine('✦ Done'), false);
});

// ── extractText ──────────────────────────────────────────────────────

test('extractText: cursor-forward-1 becomes space', () => {
  const result = extractText('hello\x1b[1Cworld');
  assert.ok(result.includes('hello world'), `Expected "hello world" in "${result}"`);
});

test('extractText: cursor-position becomes newline', () => {
  const result = extractText('hello\x1b[5;3Hworld');
  assert.ok(result.includes('hello\nworld'), `Expected newline in "${result}"`);
});

test('extractText: bold markers stripped', () => {
  const result = extractText('\x1b[1mbold\x1b[22m normal');
  assert.ok(!result.includes('\x1b'), `Expected no escape sequences in "${result}"`);
  assert.ok(result.includes('bold'), `Expected "bold" in "${result}"`);
});

test('extractText: OSC sequences stripped', () => {
  const result = extractText('hello\x1b]0;window title\x07world');
  assert.ok(!result.includes('window title'), `Expected OSC stripped in "${result}"`);
  assert.ok(result.includes('hello'), `Expected "hello" in "${result}"`);
});

test('extractText: color codes stripped', () => {
  const result = extractText('\x1b[38;2;255;255;255mcolored text\x1b[m');
  assert.ok(result.includes('colored text'), `Expected "colored text" in "${result}"`);
});

test('extractText: multiple spaces collapsed', () => {
  const result = extractText('hello     world');
  assert.ok(result.includes('hello world'), `Expected collapsed spaces in "${result}"`);
});

// ── parseChunk ───────────────────────────────────────────────────────

test('parseChunk: response text produces text events', () => {
  // Simulate a simple rendered line: "● Hello" after ANSI extraction
  const chunk = '● Hello world';
  const events = parseChunk(chunk);
  assert.ok(events.length >= 1);
  assert.ok(events.some(e => e.type === 'text' && e.text === 'Hello world'));
});

test('parseChunk: tool call produces tool event', () => {
  const chunk = '● Bash(echo test)';
  const events = parseChunk(chunk);
  assert.ok(events.some(e => e.type === 'tool' && e.text === 'Bash(echo test)'));
});

test('parseChunk: separator-only chunk produces no events', () => {
  const chunk = '────────────────────────';
  const events = parseChunk(chunk);
  assert.strictEqual(events.length, 0);
});

test('parseChunk: mixed content', () => {
  const chunk = '● Hello\n● Bash(ls)\n  ⎿  file.txt';
  const events = parseChunk(chunk);
  assert.ok(events.some(e => e.type === 'text' && e.text === 'Hello'));
  assert.ok(events.some(e => e.type === 'tool' && e.text === 'Bash(ls)'));
  assert.ok(events.some(e => e.type === 'tool_out' && e.text === 'file.txt'));
});

test('parseChunk: status bar noise produces no events', () => {
  const chunk = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
  const events = parseChunk(chunk);
  assert.strictEqual(events.length, 0);
});

test('parseChunk: spinner produces no events', () => {
  const chunk = '✦ Thinking…';
  const events = parseChunk(chunk);
  assert.strictEqual(events.length, 0);
});
