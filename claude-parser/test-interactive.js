/**
 * Experiment: Claude Code interactive mode via PTY + xterm headless buffer
 *
 * Spawns claude interactively using node-pty, feeds all output through
 * @xterm/headless to maintain a rendered virtual screen buffer, then
 * detects when Claude has finished responding by inspecting the buffer
 * structure (idle input prompt between two separator lines).
 *
 * Dependencies (install globally or adjust paths):
 *   npm install -g node-pty
 *   npm install @xterm/headless
 *
 * Run:
 *   node claude-parser/test-interactive.js
 *
 * Output is written to Desktop/claude-xterm-output.log and stdout.
 */

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COLS = 220;
const ROWS = 50;

const outFile = path.join(os.homedir(), 'Desktop', 'claude-xterm-output.log');
fs.writeFileSync(outFile, '');

const log = (label, data) => {
  const entry = `[${new Date().toISOString()}] [${label}] ${data}\n`;
  process.stdout.write(entry);
  fs.appendFileSync(outFile, entry);
};

// Returns all non-empty rendered lines from the terminal buffer
function snapshotBuffer(term) {
  const lines = [];
  for (let i = 0; i < term.buffer.active.length; i++) {
    const line = term.buffer.active.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true).trimEnd();
    if (text) lines.push(text);
  }
  return lines;
}

// Wait for Claude to finish responding to a sent message.
//
// Strategy: poll the buffer every 300ms and check that:
//   1. The user's prompt appears in the buffer (as a ❯ line)
//   2. A ● response line has appeared after it
//   3. The idle state is showing: two separator (────) lines with only "❯"
//      between them (the empty input prompt)
//
// Buffer layout when idle:
//   ❯ <user message>
//   ● <claude response>
//   ────────────  (first separator)
//   ❯             (empty input prompt — idle indicator)
//   ────────────  (second separator)
//   ⏵⏵ status bar
// Spinner chars used by Claude during thinking/tool execution
const SPINNER_CHARS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏','✢','✣','✤','✥','✦','✧','✶','✷','✸','✹','✺','✻','✼','✽','✾','*','·','◐','◑','◒','◓','○','●','◌'];

function isSpinnerLine(line) {
  // Lines like "✢ Gusting…", "· Waddling…", "✶ Booping…"
  // The spinner char is the first non-space character
  const trimmed = line.trimStart();
  const firstChar = trimmed[0];
  return SPINNER_CHARS.includes(firstChar) && trimmed.includes('…');
}

function waitForResponse(term, promptText, callback) {
  const shortPrompt = promptText.slice(0, 30);
  const interval = setInterval(() => {
    const lines = snapshotBuffer(term);

    // Find the ❯ line containing our prompt
    const promptIdx = lines.findIndex(l => l.startsWith('❯') && l.includes(shortPrompt));
    if (promptIdx === -1) return;

    // A ● response must appear after the prompt
    const responseIdx = lines.findIndex((l, i) => i > promptIdx && l.startsWith('●'));
    if (responseIdx === -1) return;

    // No spinner lines anywhere in the content area (above the first separator)
    const firstSep = lines.findIndex(l => l.startsWith('────'));
    const contentLines = firstSep === -1 ? lines : lines.slice(0, firstSep);
    if (contentLines.some(isSpinnerLine)) return;

    // Also check status bar doesn't show "esc to interrupt" (means still running)
    const statusLine = lines.find(l => l.includes('⏵⏵'));
    if (statusLine && statusLine.includes('esc to interrupt')) return;

    // Idle check: last two separator lines must sandwich just "❯"
    const sepIndices = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('────'))
      .map(({ i }) => i);
    if (sepIndices.length < 2) return;

    const lastSep = sepIndices[sepIndices.length - 1];
    const prevSep = sepIndices[sepIndices.length - 2];
    const between = lines.slice(prevSep + 1, lastSep);

    if (between.length === 1 && between[0].trimEnd() === '❯') {
      clearInterval(interval);
      callback(lines);
    }
  }, 300);
}

log('START', 'Spawning claude via PTY + xterm headless buffer');

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

// On Windows, claude is a .cmd shim so we must go through cmd.exe
const isWin = process.platform === 'win32';
const claudeCmd = isWin ? 'cmd.exe' : 'claude';
const claudeArgs = isWin
  ? ['/c', 'claude', '--dangerously-skip-permissions']
  : ['--dangerously-skip-permissions'];

const ptyProc = pty.spawn(claudeCmd, claudeArgs, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});

ptyProc.onData((data) => {
  term.write(data);
});

ptyProc.onExit(({ exitCode }) => {
  log('EXIT', `code=${exitCode}`);
  log('FINAL_BUFFER', '\n' + snapshotBuffer(term).join('\n'));
  process.exit(0);
});

const send = (text, label) => {
  log('SEND', label || text.trim());
  ptyProc.write(text);
};

// Send multi-line input via bracketed paste then submit with enter
const sendMultiLine = (text, label) => {
  log('SEND', label || text.slice(0, 60));
  ptyProc.write('\x1b[200~' + text + '\x1b[201~');
  setTimeout(() => ptyProc.write('\r'), 200);
};

// Extract just the new content since the last snapshot
// (lines between the last user ❯ prompt and the separators)
function extractNewContent(lines, promptText) {
  const shortPrompt = promptText.slice(0, 30);
  const promptIdx = lines.findIndex(l => l.startsWith('❯') && l.includes(shortPrompt));
  if (promptIdx === -1) return lines;
  const firstSepAfter = lines.findIndex((l, i) => i > promptIdx && l.startsWith('────'));
  const contentLines = firstSepAfter === -1 ? lines.slice(promptIdx) : lines.slice(promptIdx, firstSepAfter);
  return contentLines;
}

// --- Test sequence ---

const messages = [
  {
    label: 'msg1: simple bash',
    text: 'Run this bash command and show me the output: echo "hello from bash"',
  },
  {
    label: 'msg2: create file',
    text: 'Create a new file called claude-parser/test-output.txt with exactly this content: "hello world\\nline two\\nline three"',
  },
  {
    label: 'msg3: edit file',
    text: 'Edit the file claude-parser/test-output.txt and append a new line at the end that says "line four"',
  },
  {
    label: 'msg4: read file',
    text: 'Read the file claude-parser/test-output.txt and tell me all its contents',
  },
  {
    label: 'msg5: multi tool',
    text: 'Run "ls claude-parser/" to list files, then run "wc -l claude-parser/test-output.txt" to count lines. Report both results.',
  },
];

function runSequence(msgs, idx) {
  if (idx >= msgs.length) {
    setTimeout(() => send('/exit\r', '/exit'), 500);
    return;
  }
  const { label, text } = msgs[idx];
  send(text + '\r', label);
  waitForResponse(term, text, (lines) => {
    const content = extractNewContent(lines, text);
    log(`RESPONSE_${idx + 1} [${label}]`, '\n' + content.join('\n'));
    runSequence(msgs, idx + 1);
  });
}

setTimeout(() => runSequence(messages, 0), 10000);

// Hard kill fallback
setTimeout(() => {
  log('KILL', 'hard kill fallback — something stalled');
  ptyProc.kill();
  process.exit(1);
}, 120000);

console.log('Running... output:', outFile);
