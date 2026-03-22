/**
 * Test the ANSI stream parser against live claude output.
 * Shows events as they arrive from each PTY chunk.
 */

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { parseChunk } = require('./parse-stream');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COLS = 220;
const ROWS = 50;

const outFile = path.join(os.homedir(), 'Desktop', 'claude-parser-events.log');
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
  const t = line.trimStart();
  return SPINNER_CHARS.includes(t[0]) && t.includes('…');
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
    const between = lines.slice(sepIndices[sepIndices.length - 2] + 1, sepIndices[sepIndices.length - 1]);
    if (between.length === 1 && between[0].trimEnd() === '❯') {
      clearInterval(interval);
      callback(lines);
    }
  }, 300);
}

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

const isWin = process.platform === 'win32';
const ptyProc = pty.spawn(
  isWin ? 'cmd.exe' : 'claude',
  isWin ? ['/c', 'claude', '--dangerously-skip-permissions'] : ['--dangerously-skip-permissions'],
  { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }
);

let capturing = false;

ptyProc.onData((data) => {
  term.write(data);
  if (!capturing) return;

  const events = parseChunk(data);
  for (const ev of events) {
    if (ev.type === 'text') {
      log('TEXT', ev.text);
    } else if (ev.type === 'tool') {
      log('TOOL', ev.text);
    } else if (ev.type === 'tool_out') {
      log('TOOL_OUT', ev.text);
    }
  }
});

ptyProc.onExit(({ exitCode }) => {
  log('EXIT', `code=${exitCode}`);
  process.exit(0);
});

const send = (text, label) => {
  log('SEND', label || text.trim());
  ptyProc.write(text);
};

const messages = [
  'Write a detailed 200 word explanation of how photosynthesis works. Do not use any tools.',
  'Run the bash command: echo "hello world" and then read the file claude-parser/package.json',
];

function runNext(msgs, i) {
  if (i >= msgs.length) {
    setTimeout(() => send('/exit\r', '/exit'), 500);
    return;
  }
  const msg = msgs[i];
  capturing = true;
  send(msg + '\r', `msg${i + 1}`);
  waitForResponse(term, msg, (lines) => {
    capturing = false;
    log('TURN_DONE', `--- turn ${i + 1} complete ---`);
    runNext(msgs, i + 1);
  });
}

setTimeout(() => runNext(messages, 0), 10000);
setTimeout(() => { log('KILL', 'fallback'); ptyProc.kill(); process.exit(1); }, 120000);

console.log('Running... output:', outFile);
