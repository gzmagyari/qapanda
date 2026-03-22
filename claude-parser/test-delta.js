/**
 * Test: extract streaming text deltas by diffing xterm buffer snapshots
 * on every PTY onData event.
 */

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COLS = 220;
const ROWS = 50;

const outFile = path.join(os.homedir(), 'Desktop', 'claude-delta.log');
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

const SPINNER_RE = /^[✢✣✤✥✦✧✶✷✸✹✺✻✼✽✾*·◐◑◒◓○◌]/;

// Extract just the response content area, stripping trailing spinner lines
function getResponseText(lines, shortPrompt) {
  const promptIdx = lines.findIndex(l => l.startsWith('❯') && l.includes(shortPrompt));
  if (promptIdx === -1) return '';
  const firstSepAfter = lines.findIndex((l, i) => i > promptIdx && l.startsWith('────'));
  const contentLines = firstSepAfter === -1 ? lines.slice(promptIdx + 1) : lines.slice(promptIdx + 1, firstSepAfter);
  // Strip trailing spinner line so it doesn't cause false REPAINT detections
  while (contentLines.length && SPINNER_RE.test(contentLines[contentLines.length - 1].trimStart())) {
    contentLines.pop();
  }
  return contentLines.join('\n');
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
let shortPrompt = '';
let lastResponseText = '';

ptyProc.onData((data) => {
  term.write(data);
  if (!capturing) return;

  const lines = snapshotBuffer(term);
  const current = getResponseText(lines, shortPrompt);

  if (current !== lastResponseText) {
    // Something changed — emit the delta
    if (current.startsWith(lastResponseText)) {
      // Pure addition — emit just the new part
      const delta = current.slice(lastResponseText.length);
      if (delta.trim()) log('DELTA', JSON.stringify(delta));
    } else {
      // Content changed in a non-additive way (repaint shifted text)
      // Still log full current for debugging
      log('REPAINT', JSON.stringify(current.slice(0, 100)));
    }
    lastResponseText = current;
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

const msg = 'Say "Hi!" then create a file called claude-parser/delta-test.txt containing "hello", then say "Done!"';

setTimeout(() => {
  shortPrompt = msg.slice(0, 30);
  lastResponseText = '';
  capturing = true;
  send(msg + '\r', 'msg: story');

  waitForResponse(term, msg, (lines) => {
    capturing = false;
    log('TURN_DONE', 'complete');
    log('FINAL', '\n' + getResponseText(lines, shortPrompt));
    setTimeout(() => send('/exit\r', '/exit'), 500);
  });
}, 10000);

setTimeout(() => { ptyProc.kill(); process.exit(1); }, 90000);
console.log('Running... output:', outFile);
