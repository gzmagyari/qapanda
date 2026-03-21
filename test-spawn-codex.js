/**
 * Tests the Codex turn.completed abort fix.
 * Uses spawnStreamingProcess with a local AbortController, same as our fix.
 */
const { spawnStreamingProcess } = require('./src/process-utils');
const path = require('path');
const fs = require('fs');
const os = require('os');

const cwd = 'c:\\xampp\\htdocs\\BacktestBuddyWorkspace\\BacktestBuddyNew';
const finalFile = path.join(os.tmpdir(), `codex-test-${Date.now()}.json`);

const codexHome = path.join(os.tmpdir(), 'cc-codex-home');
const realCodexHome = path.join(os.homedir(), '.codex');
fs.mkdirSync(codexHome, { recursive: true });
for (const f of ['auth.json', 'cap_sid']) {
  const src = path.join(realCodexHome, f);
  const dst = path.join(codexHome, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, dst);
}

const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env;
cleanEnv.CODEX_HOME = codexHome;

const args = [
  'exec',
  '--cd', cwd,
  '--color', 'never',
  '--dangerously-bypass-approvals-and-sandbox',
  '--json',
  '--output-last-message', finalFile,
  '-',
];

// Same abort pattern as our fix
const localAbort = new AbortController();
let turnDone = false;

const start = Date.now();
console.log('Spawning codex...');

spawnStreamingProcess({
  command: 'codex',
  args,
  cwd,
  stdinText: 'Say hi in one word.',
  env: cleanEnv,
  abortSignal: localAbort.signal,
  onStdoutLine: (line) => {
    try {
      const raw = JSON.parse(line);
      console.log(`  [${((Date.now()-start)/1000).toFixed(1)}s] ${raw.type} ${raw.item?.type||''} ${raw.item?.id||''}`);
      if (raw.type === 'turn.completed') {
        turnDone = true;
        console.log('  >>> turn.completed detected, will abort in 500ms');
        setTimeout(() => { if (!localAbort.signal.aborted) localAbort.abort(); }, 500);
      }
    } catch {}
  },
  onStderrLine: () => {},
}).then((result) => {
  console.log(`\nDone in ${((Date.now()-start)/1000).toFixed(1)}s`);
  console.log('Exit code:', result.code, 'aborted:', result.aborted, 'turnDone:', turnDone);
  try { fs.unlinkSync(finalFile); } catch {}
  process.exit(0);
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

setTimeout(() => { console.log('TIMEOUT after 60s'); process.exit(1); }, 60000);
