const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'cc-manager.js');
const fakeCodex = path.join(rootDir, 'tests', 'fakes', 'fake-codex.js');
const fakeClaude = path.join(rootDir, 'tests', 'fakes', 'fake-claude.js');

async function runCli(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function setupWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-manager-test-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const stateRoot = path.join(tempRoot, 'state');
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'logic.py'), 'def add(a, b):\n    return a + b\n');
  return { tempRoot, repoRoot, stateRoot };
}

async function getSingleRunId(stateRoot) {
  const runsDir = path.join(stateRoot, 'runs');
  const entries = await fs.readdir(runsDir);
  assert.equal(entries.length, 1);
  return entries[0];
}

test('simple greeting stops without launching Claude Code', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  const result = await runCli([
    'run',
    'Hi',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeCodex,
    '--claude-bin', fakeClaude,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /User: Hi/);
  assert.match(result.stdout, /Controller: Hi, how can I help you\?/);
  assert.match(result.stdout, /Controller: STOP/);
  assert.doesNotMatch(result.stdout, /Launching Claude Code/);
});

test('controller delegates to Claude, reviews, delegates again, then stops', async () => {
  const { repoRoot, stateRoot } = await setupWorkspace();
  const first = await runCli([
    'run',
    'Please do fixes in this repository until all unit tests pass',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeCodex,
    '--claude-bin', fakeClaude,
  ]);

  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Controller: I will instruct Claude Code to fix the issues\./);
  assert.match(first.stdout, /Controller: Launching Claude Code with: "Please fix all issues in this repository such that all unit tests pass\."/);
  assert.match(first.stdout, /Claude code: I will start fixing the issues\./);
  assert.match(first.stdout, /Controller: Let me review the work that was done\./);
  assert.match(first.stdout, /Controller: Launching Claude Code with the same session with: "The changes in logic\.py introduced a critical bug\. Please fix it and rerun the unit tests\."/);
  assert.match(first.stdout, /Controller: All unit tests passing\. The task has been completed\. Waiting for next user instruction\./);
  assert.match(first.stdout, /Controller: STOP/);

  const runId = await getSingleRunId(stateRoot);
  const second = await runCli([
    'resume',
    runId,
    'Good job. Thank you',
    '--repo', repoRoot,
    '--state-dir', stateRoot,
    '--codex-bin', fakeCodex,
    '--claude-bin', fakeClaude,
  ]);

  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /User: Good job\. Thank you/);
  assert.match(second.stdout, /Controller: No worries\. Let me know if you want me to do anything else\./);
  assert.match(second.stdout, /Controller: STOP/);
  assert.doesNotMatch(second.stdout, /Launching Claude Code/);
});
