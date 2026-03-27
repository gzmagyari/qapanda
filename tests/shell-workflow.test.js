const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'qapanda.js');
const fakeCodex = path.join(rootDir, 'tests', 'fakes', 'fake-codex.js');
const fakeClaude = path.join(rootDir, 'tests', 'fakes', 'fake-claude.js');

function runShell(stdinText, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'shell', ...args], {
      cwd: options.cwd || rootDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
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

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

test('/workflow command runs a workflow and records the full message', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-shell-wf-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const stateRoot = path.join(tempRoot, 'state');

  // Create a workflow directory with WORKFLOW.md
  const wfDir = path.join(repoRoot, '.qpanda', 'workflows', 'autonomous-dev');
  await fs.mkdir(wfDir, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });

  const wfContent = [
    '---',
    'name: autonomous-dev',
    'description: Run the autonomous dev loop',
    '---',
    '',
    'Step 1: Read all source files',
    'Step 2: Run the test suite',
    'Step 3: Fix any failures',
  ].join('\n');
  const wfPath = path.join(wfDir, 'WORKFLOW.md');
  await fs.writeFile(wfPath, wfContent);

  // Also need a file in the repo so it looks like a real repo
  await fs.writeFile(path.join(repoRoot, 'hello.txt'), 'hello\n');

  const result = await runShell(
    '/workflow autonomous-dev\n/quit\n',
    [
      '--repo', repoRoot,
      '--state-dir', stateRoot,
      '--codex-bin', fakeCodex,
      '--claude-bin', fakeClaude,
    ],
  );

  // Should not print "Unknown command"
  assert.doesNotMatch(result.stdout, /Unknown command/);
  assert.doesNotMatch(result.stderr, /Unknown command/);

  // Find the run manifest and check the recorded user message
  const runsDir = path.join(stateRoot, 'runs');
  const entries = await fs.readdir(runsDir);
  assert.equal(entries.length, 1, `Expected 1 run, got ${entries.length}`);

  const manifestPath = path.join(runsDir, entries[0], 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  assert.ok(manifest.requests.length >= 1, 'Should have at least one request');
  const userMessage = manifest.requests[0].userMessage;

  assert.ok(userMessage.includes('autonomous-dev'), 'message should contain workflow name');
  assert.ok(userMessage.includes(wfPath), 'message should contain workflow file path');
  assert.ok(userMessage.includes('Run the autonomous dev loop'), 'message should contain summary');
  assert.ok(userMessage.includes('Step 1: Read all source files'), 'message should contain workflow body');
  assert.ok(userMessage.includes('Step 3: Fix any failures'), 'message should contain workflow body');
});
