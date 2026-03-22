/**
 * Test: what does the raw PTY data look like during streaming?
 * We want to see if we can extract text deltas in real time from
 * the raw escape sequence stream rather than polling the xterm buffer.
 */

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COLS = 220;
const ROWS = 50;

const outFile = path.join(os.homedir(), 'Desktop', 'claude-streaming-raw.log');
fs.writeFileSync(outFile, '');

const log = (label, data) => {
  const entry = `[${new Date().toISOString()}] [${label}] ${data}\n`;
  process.stdout.write(entry);
  fs.appendFileSync(outFile, entry);
};

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

const SPINNER_CHARS = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏','✢','✣','✤','✥','✦','✧','✶','✷','✸','✹','✺','✻','✼','✽','✾','*','·','◐','◑','◒','◓'];
function isSpinnerLine(line) {
  const trimmed = line.trimStart();
  return SPINNER_CHARS.includes(trimmed[0]) && trimmed.includes('…');
}

function waitForResponse(term, promptText, callback) {
  const shortPrompt = promptText.slice(0, 30);
  const interval = setInterval(() => {
    const lines = snapshotBuffer(term);
    const promptIdx = lines.findIndex(l => l.startsWith('❯') && l.includes(shortPrompt));
    if (promptIdx === -1) return;
    const responseIdx = lines.findIndex((l, i) => i > promptIdx && l.startsWith('●'));
    if (responseIdx === -1) return;
    const firstSep = lines.findIndex(l => l.startsWith('────'));
    const contentLines = firstSep === -1 ? lines : lines.slice(0, firstSep);
    if (contentLines.some(isSpinnerLine)) return;
    const statusLine = lines.find(l => l.includes('⏵⏵'));
    if (statusLine && statusLine.includes('esc to interrupt')) return;
    const sepIndices = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith('────')).map(({ i }) => i);
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

log('START', 'Spawning claude, watching raw PTY data during streaming response');

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

const isWin = process.platform === 'win32';
const claudeCmd = isWin ? 'cmd.exe' : 'claude';
const claudeArgs = isWin ? ['/c', 'claude', '--dangerously-skip-permissions'] : ['--dangerously-skip-permissions'];

const ptyProc = pty.spawn(claudeCmd, claudeArgs, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
});

// Track buffer state before and after each data chunk to detect new content
let lastRenderedContent = '';

function getContentAboveSeparator(term) {
  const lines = snapshotBuffer(term);
  const firstSep = lines.findIndex(l => l.startsWith('────'));
  return (firstSep === -1 ? lines : lines.slice(0, firstSep)).join('\n');
}

let capturing = false;

ptyProc.onData((data) => {
  term.write(data);
  if (!capturing) return;
  // Log every raw PTY chunk during capture so we can see the timing
  log('RAW_CHUNK', JSON.stringify(data));
});

ptyProc.onExit(({ exitCode }) => {
  log('EXIT', `code=${exitCode}`);
  process.exit(0);
});

const send = (text, label) => {
  log('SEND', label || text.trim());
  ptyProc.write(text);
};

// Ask for a longer response so we can see streaming chunks
const msg = 'Write a detailed 200 word explanation of how photosynthesis works. Do not use any tools.';

setTimeout(() => {
  capturing = true;
  send(msg + '\r', 'streaming test: count 1-10');
  waitForResponse(term, msg, (lines) => {
    capturing = false;
    log('FULL_RESPONSE', '\n' + lines.join('\n'));
    setTimeout(() => send('/exit\r', '/exit'), 500);
  });
}, 10000);

setTimeout(() => { log('KILL', 'fallback'); ptyProc.kill(); process.exit(1); }, 90000);

console.log('Running... output:', outFile);
