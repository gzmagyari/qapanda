'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ClaudeSession } = require('../index');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_FILE = path.join(__dirname, '_test-artifact.txt');

// Shared session for multi-turn tests (reused across tests in this file)
let session;

test('session lifecycle: not started before first send', () => {
  session = new ClaudeSession({
    cwd: REPO_ROOT,
    startupTimeout: 30000,
    turnTimeout: 60000,
  });
  assert.strictEqual(session.started, false);
  assert.strictEqual(session.busy, false);
});

test('simple text response', async (t) => {
  const events = [];
  const result = await session.send('What is 2+2? Just the number, nothing else.', {
    onEvent: (e) => events.push(e),
  });

  // Session should now be started
  assert.strictEqual(session.started, true);
  assert.strictEqual(session.busy, false);

  // Session ID should be a UUID
  assert.ok(result.sessionId, 'sessionId should be set');
  assert.match(result.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

  // Should have text delta events (or at least final-text with content)
  const textDeltas = events.filter(e => e.kind === 'text-delta');
  const finalTexts = events.filter(e => e.kind === 'final-text');
  assert.ok(
    textDeltas.length >= 1 || (finalTexts.length >= 1 && finalTexts[0].text.includes('4')),
    `Should have text-delta or final-text with "4". Events: ${JSON.stringify(events.map(e => e.kind))}`
  );

  // Should have a final-text event
  assert.strictEqual(finalTexts.length, 1, 'Should have exactly one final-text event');

  // Result text should contain "4"
  assert.ok(result.resultText.includes('4'), `resultText "${result.resultText}" should contain "4"`);
});

test('tool use: file write', async (t) => {
  // Use a unique filename to ensure Claude always creates it fresh
  const uniqueId = Date.now().toString(36);
  const artifactFile = path.join(__dirname, `_test-artifact-${uniqueId}.txt`);
  const relativePath = `claude-parser/tests/_test-artifact-${uniqueId}.txt`;

  // Ensure it doesn't exist
  try { fs.unlinkSync(artifactFile); } catch {}

  const events = [];
  const result = await session.send(
    `Create a new file called ${relativePath} with exactly the text "hello from test"`,
    { onEvent: (e) => events.push(e) }
  );

  // Should have a tool-start event for Write (or Edit), OR the final-text should mention Write/Edit
  const toolStarts = events.filter(e => e.kind === 'tool-start');
  const finalText = events.find(e => e.kind === 'final-text');
  const hasToolInEvents = toolStarts.some(e => e.toolName === 'Write' || e.toolName === 'Edit');
  const hasToolInFinal = finalText && (finalText.text.includes('Write(') || finalText.text.includes('Edit('));
  assert.ok(
    hasToolInEvents || hasToolInFinal,
    `Expected Write/Edit tool in events or final text. Events: ${JSON.stringify(events.map(e => ({ kind: e.kind, text: (e.text || '').slice(0, 60) })))}`
  );

  // File should exist on disk
  assert.ok(fs.existsSync(artifactFile), `Artifact file should exist at ${artifactFile}`);
  const contents = fs.readFileSync(artifactFile, 'utf8');
  assert.ok(contents.includes('hello from test'), `File contents "${contents}" should contain "hello from test"`);

  // Cleanup
  try { fs.unlinkSync(artifactFile); } catch {}
});

test('tool use: bash command', async (t) => {
  const events = [];
  const result = await session.send(
    'Run this bash command and tell me the output: echo "test_marker_xyz"',
    { onEvent: (e) => events.push(e) }
  );

  // Should have a tool-start for Bash, OR the final-text should mention Bash
  const toolStarts = events.filter(e => e.kind === 'tool-start');
  const finalText = events.find(e => e.kind === 'final-text');
  const hasToolInEvents = toolStarts.some(e => e.toolName === 'Bash');
  const hasToolInFinal = finalText && finalText.text.includes('Bash(');
  assert.ok(
    hasToolInEvents || hasToolInFinal,
    `Expected Bash tool in events or final text. Events: ${JSON.stringify(events.map(e => ({ kind: e.kind, text: (e.text || '').slice(0, 60) })))}`
  );

  // Result or final text should mention the output
  const allText = result.resultText + ' ' + (finalText ? finalText.text : '');
  assert.ok(
    allText.includes('test_marker_xyz'),
    `Output should contain "test_marker_xyz". resultText: "${result.resultText}"`
  );
});

test('multi-turn conversation: memory across turns', async (t) => {
  // Turn 1: tell it something
  await session.send('Remember this exact phrase: "purple elephant dancing"', {});

  // Turn 2: ask it to recall
  const events = [];
  const result = await session.send(
    'What was the exact phrase I asked you to remember? Just repeat the phrase.',
    { onEvent: (e) => events.push(e) }
  );

  assert.ok(
    result.resultText.includes('purple elephant dancing'),
    `resultText "${result.resultText}" should contain "purple elephant dancing"`
  );
});

// ── Advanced integration tests ───────────────────────────────────────

test('multi-step turn: read file and extract info', async (t) => {
  const events = [];
  const result = await session.send(
    'Read claude-parser/package.json and tell me the value of the "version" field. Just the version string.',
    { onEvent: (e) => events.push(e) }
  );

  const finalText = events.find(e => e.kind === 'final-text');
  const allText = result.resultText + ' ' + (finalText ? finalText.text : '');

  // Should have used Read tool or file read output
  const hasToolActivity = events.some(e =>
    e.kind === 'tool-start' || e.kind === 'tool-output'
  );
  const hasFinalToolRef = finalText && (finalText.text.includes('Read(') || finalText.text.includes('Read '));
  assert.ok(
    hasToolActivity || hasFinalToolRef,
    `Expected tool activity. Events: ${JSON.stringify(events.map(e => e.kind))}`
  );

  // Result should contain the version
  assert.ok(
    allText.includes('0.1.0'),
    `Output should contain "0.1.0". resultText: "${result.resultText}"`
  );
});

test('file edit with existing content', async (t) => {
  const editFile = path.join(__dirname, '_edit-target.txt');
  const relativePath = 'claude-parser/tests/_edit-target.txt';

  // Create file with known content
  fs.writeFileSync(editFile, 'The quick foo jumped over the lazy dog.\n');

  try {
    const events = [];
    const result = await session.send(
      `Edit the file ${relativePath} and change the word "foo" to "bar". Use the Edit tool.`,
      { onEvent: (e) => events.push(e) }
    );

    const finalText = events.find(e => e.kind === 'final-text');

    // Should have Edit or Update tool in events or final text
    const toolStarts = events.filter(e => e.kind === 'tool-start');
    const hasEditTool = toolStarts.some(e => e.toolName === 'Edit' || e.toolName === 'Update');
    const hasEditInFinal = finalText && (finalText.text.includes('Edit(') || finalText.text.includes('Update('));
    assert.ok(
      hasEditTool || hasEditInFinal,
      `Expected Edit/Update tool. Events: ${JSON.stringify(events.map(e => ({ kind: e.kind, toolName: e.toolName })))}`
    );

    // File should now contain 'bar' instead of 'foo'
    const contents = fs.readFileSync(editFile, 'utf8');
    assert.ok(contents.includes('bar'), `File should contain "bar", got: "${contents}"`);
    assert.ok(!contents.includes('foo'), `File should not contain "foo", got: "${contents}"`);
  } finally {
    try { fs.unlinkSync(editFile); } catch {}
  }
});

test('bash command with multi-line output', async (t) => {
  const events = [];
  const result = await session.send(
    'Run this exact bash command: echo -e "line1\\nline2\\nline3\\nline4\\nline5"',
    { onEvent: (e) => events.push(e) }
  );

  const finalText = events.find(e => e.kind === 'final-text');
  const allText = result.resultText + ' ' + (finalText ? finalText.text : '');

  // Should have Bash tool
  const toolStarts = events.filter(e => e.kind === 'tool-start');
  const hasBash = toolStarts.some(e => e.toolName === 'Bash');
  const hasBashInFinal = finalText && finalText.text.includes('Bash(');
  assert.ok(hasBash || hasBashInFinal, 'Expected Bash tool');

  // Output should contain all 5 lines
  for (const line of ['line1', 'line2', 'line3', 'line4', 'line5']) {
    assert.ok(allText.includes(line), `Output should contain "${line}"`);
  }
});

test('markdown in response', async (t) => {
  const events = [];
  const result = await session.send(
    'List exactly 3 programming languages with one sentence each. Use markdown bullet points (- prefix). Do not use any tools.',
    { onEvent: (e) => events.push(e) }
  );

  // resultText should have multiple lines of content
  const lines = result.resultText.split('\n').filter(l => l.trim().length > 0);
  assert.ok(lines.length >= 3, `Expected at least 3 non-empty lines, got ${lines.length}: ${JSON.stringify(lines)}`);
});

test('longer multi-turn conversation: 4 turns with recall', async (t) => {
  await session.send('Remember this: color=blue', {});
  await session.send('Remember this: animal=cat', {});
  await session.send('Remember this: number=7', {});

  const events = [];
  const result = await session.send(
    'What were the three things I asked you to remember? List the color, animal, and number.',
    { onEvent: (e) => events.push(e) }
  );

  const finalText = events.find(e => e.kind === 'final-text');
  const allText = result.resultText + ' ' + (finalText ? finalText.text : '');

  assert.ok(allText.includes('blue'), `Should recall "blue". Got: "${result.resultText}"`);
  assert.ok(allText.includes('cat'), `Should recall "cat". Got: "${result.resultText}"`);
  assert.ok(allText.includes('7'), `Should recall "7". Got: "${result.resultText}"`);
});

test('tool error handling: read nonexistent file', async (t) => {
  const events = [];
  const result = await session.send(
    'Read the file claude-parser/tests/nonexistent-file-xyz-12345.txt',
    { onEvent: (e) => events.push(e) }
  );

  // Turn should complete without crashing
  assert.ok(result.resultText !== undefined, 'Should have a resultText');
  assert.ok(events.some(e => e.kind === 'final-text'), 'Should have final-text event');
});

test('glob tool: find test files', async (t) => {
  const events = [];
  const result = await session.send(
    'Use the Glob tool to find all files matching "claude-parser/tests/*.test.js" and list them.',
    { onEvent: (e) => events.push(e) }
  );

  const finalText = events.find(e => e.kind === 'final-text');
  const allText = result.resultText + ' ' + (finalText ? finalText.text : '');

  // Should have used some tool (Glob, Bash, or Read)
  const hasToolActivity = events.some(e => e.kind === 'tool-start' || e.kind === 'tool-output');
  const hasFinalToolRef = finalText && (finalText.text.includes('Glob(') || finalText.text.includes('Bash('));
  assert.ok(
    hasToolActivity || hasFinalToolRef,
    `Expected tool activity. Events: ${JSON.stringify(events.map(e => e.kind))}`
  );

  // Should mention our test files
  assert.ok(
    allText.includes('parse-stream.test.js') && allText.includes('session.test.js'),
    `Should list test files. Got: "${result.resultText}"`
  );
});

test('sequential tool calls in one turn', async (t) => {
  const events = [];
  const result = await session.send(
    'Run these 3 bash commands one by one and tell me each output: (1) echo "AAA" (2) echo "BBB" (3) echo "CCC"',
    { onEvent: (e) => events.push(e) }
  );

  const finalText = events.find(e => e.kind === 'final-text');
  const allText = result.resultText + ' ' + (finalText ? finalText.text : '');

  // Should have multiple Bash tool calls
  const bashTools = events.filter(e => e.kind === 'tool-start' && e.toolName === 'Bash');
  const bashInFinal = finalText ? (finalText.text.match(/Bash\(/g) || []).length : 0;
  const totalBash = bashTools.length + bashInFinal;
  assert.ok(totalBash >= 2, `Expected at least 2 Bash calls, got ${totalBash}`);

  // All outputs should be present
  assert.ok(allText.includes('AAA'), 'Should contain "AAA"');
  assert.ok(allText.includes('BBB'), 'Should contain "BBB"');
  assert.ok(allText.includes('CCC'), 'Should contain "CCC"');
});

// ── Lifecycle tests (must be last) ──────────────────────────────────

test('session lifecycle: close', () => {
  assert.doesNotThrow(() => session.close());
});

test('send after close throws', async (t) => {
  await assert.rejects(
    () => session.send('hello', {}),
    { message: /process has exited/ }
  );
});
