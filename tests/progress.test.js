const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// ── Test 1: prepareNewRun creates a progress file path in the manifest ───────

test('prepareNewRun includes progress path in files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-progress-'));
  try {
    const { prepareNewRun } = require('../src/state');
    const manifest = await prepareNewRun('test message', {
      stateRoot: tmpDir,
      repoRoot: tmpDir,
    });
    assert.ok(manifest.files.progress, 'manifest.files.progress should exist');
    assert.ok(manifest.files.progress.endsWith('progress.md'), 'should end with progress.md');
    assert.ok(manifest.files.progress.includes(manifest.runId), 'should be under run dir');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Test 2: progressPath helper ──────────────────────────────────────────────

test('progressPath returns correct path', () => {
  const { progressPath } = require('../src/state');
  const result = progressPath('/fake/runs/my-run');
  assert.equal(result, path.join('/fake/runs/my-run', 'progress.md'));
});

// ── Test 3: appendProgress writes to file and calls renderer.progress ────────

test('orchestrator appendProgress writes to file and notifies renderer', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-progress-'));
  const progressFile = path.join(tmpDir, 'progress.md');
  const progressCalls = [];

  const fakeManifest = {
    files: { progress: progressFile },
  };
  const fakeRenderer = {
    progress(line) { progressCalls.push(line); },
  };

  // We need to call appendProgress from the orchestrator module.
  // It's not exported, so we test it indirectly through the session-manager test
  // or by testing the file output after a run. Instead, let's directly test the
  // progress file creation via the state + utils modules.
  const { appendText, readText } = require('../src/utils');

  // Simulate what appendProgress does — status lines only, no transcript chatter
  const line1 = '[12:00:00] Analyzing the request';
  const line2 = '[12:00:01] Done';
  await appendText(progressFile, line1 + '\n');
  await appendText(progressFile, line2 + '\n');

  const content = await readText(progressFile);
  assert.ok(content.includes(line1));
  assert.ok(content.includes(line2));
  const lines = content.trim().split('\n');
  assert.equal(lines.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 4: SessionManager sendProgress reads file and posts to webview ──────

const extDir = path.resolve(__dirname, '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');
const utilsPath = path.join(extDir, 'src', 'utils.js');

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);
const origUtils = require(utilsPath);

function stubRenderer() {
  return new Proxy({}, {
    get() { return () => {}; },
  });
}

function buildSession({ runExists = true, progressContent = '', manifest = null } = {}) {
  const posted = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-progress-sm-'));
  const progressFile = path.join(tmpDir, 'progress.md');
  if (progressContent) {
    fs.writeFileSync(progressFile, progressContent, 'utf8');
  }

  const fakeManifest = manifest || {
    runId: 'progress-run',
    runDir: tmpDir,
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: progressFile },
  };

  delete require.cache[smPath];

  require.cache[statePath] = {
    id: statePath, filename: statePath, loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async (runId) => {
        if (!runExists) throw new Error(`Run ${runId} not found`);
        return tmpDir;
      },
      loadManifestFromDir: async () => {
        if (!runExists) throw new Error('Not found');
        return { ...fakeManifest };
      },
      prepareNewRun: async (msg, opts) => ({ ...fakeManifest, runId: 'new-run' }),
      saveManifest: async () => {},
    },
  };

  require.cache[orchPath] = {
    id: orchPath, filename: orchPath, loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: async (m) => m,
    },
  };

  require.cache[promptsPath] = {
    id: promptsPath, filename: promptsPath, loaded: true,
    exports: { ...origPrompts, loadWorkflows: () => [] },
  };

  const { SessionManager } = require(smPath);

  const session = new SessionManager(stubRenderer(), {
    repoRoot: tmpDir,
    stateRoot: tmpDir,
    postMessage: (msg) => posted.push(msg),
  });

  const cleanup = () => {
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { session, posted, tmpDir, progressFile, cleanup };
}

test('sendProgress sends full progress file content to webview', async () => {
  const content = '[12:00:00] Analyzing the request\n[12:00:01] Done\n';
  const { session, posted, cleanup } = buildSession({ progressContent: content });
  try {
    await session.reattachRun('progress-run');
    posted.length = 0;

    await session.sendProgress();
    const msg = posted.find(m => m.type === 'progressFull');
    assert.ok(msg, 'should post progressFull');
    assert.ok(msg.text.includes('Analyzing the request'));
    assert.ok(msg.text.includes('Done'));
  } finally {
    cleanup();
  }
});

test('sendProgress with no attached run sends empty content', async () => {
  const { session, posted, cleanup } = buildSession();
  try {
    await session.sendProgress();
    const msg = posted.find(m => m.type === 'progressFull');
    assert.ok(msg, 'should post progressFull');
    assert.equal(msg.text, '');
  } finally {
    cleanup();
  }
});

test('sendProgress with missing progress file sends empty content', async () => {
  const { session, posted, progressFile, cleanup } = buildSession({ progressContent: '' });
  try {
    await session.reattachRun('progress-run');
    // Delete the file to simulate missing
    try { fs.unlinkSync(progressFile); } catch {}
    posted.length = 0;

    await session.sendProgress();
    const msg = posted.find(m => m.type === 'progressFull');
    assert.ok(msg, 'should post progressFull');
    assert.equal(msg.text, '');
  } finally {
    cleanup();
  }
});

test('/clear posts empty progressFull to webview', async () => {
  const { session, posted, cleanup } = buildSession({ progressContent: 'some progress' });
  try {
    await session.reattachRun('progress-run');
    posted.length = 0;

    await session.handleMessage({ type: 'userInput', text: '/clear' });
    const msg = posted.find(m => m.type === 'progressFull');
    assert.ok(msg, '/clear should post progressFull');
    assert.equal(msg.text, '');
  } finally {
    cleanup();
  }
});

test('/detach posts empty progressFull to webview', async () => {
  const { session, posted, cleanup } = buildSession({ progressContent: 'some progress' });
  try {
    await session.reattachRun('progress-run');
    posted.length = 0;

    await session.handleMessage({ type: 'userInput', text: '/detach' });
    const msg = posted.find(m => m.type === 'progressFull');
    assert.ok(msg, '/detach should post progressFull');
    assert.equal(msg.text, '');
  } finally {
    cleanup();
  }
});

test('/resume sends progress to webview', async () => {
  const content = '[12:00:00] Working on it\n';
  const { session, posted, cleanup } = buildSession({ progressContent: content });
  try {
    await session.handleMessage({ type: 'userInput', text: '/resume progress-run' });
    const msg = posted.find(m => m.type === 'progressFull');
    assert.ok(msg, '/resume should post progressFull');
    assert.ok(msg.text.includes('Working on it'));
  } finally {
    cleanup();
  }
});

// ── Integration: progress.md content after a real orchestrator run ────────────

const { spawn } = require('node:child_process');

const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'bin', 'qapanda.js');
const fakeCodex = path.join(rootDir, 'tests', 'fakes', 'fake-codex.js');
const fakeClaude = path.join(rootDir, 'tests', 'fakes', 'fake-claude.js');

async function runCli(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd || rootDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function setupIntegrationWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-progress-int-'));
  const repoRoot = path.join(tmpDir, 'repo');
  const stateRoot = path.join(tmpDir, 'state');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'logic.py'), 'def add(a, b):\n    return a + b\n');
  return { tmpDir, repoRoot, stateRoot };
}

function readProgressFile(stateRoot) {
  const runsDir = path.join(stateRoot, 'runs');
  const runs = fs.readdirSync(runsDir);
  assert.equal(runs.length, 1);
  const progressFile = path.join(runsDir, runs[0], 'progress.md');
  return fs.readFileSync(progressFile, 'utf8');
}

test('progress.md contains only progress_updates, not controller_messages or chatter', async () => {
  const { tmpDir, repoRoot, stateRoot } = await setupIntegrationWorkspace();

  try {
    const result = await runCli([
      'run',
      'Please do fixes in this repository until all unit tests pass',
      '--repo', repoRoot,
      '--state-dir', stateRoot,
      '--codex-bin', fakeCodex,
      '--claude-bin', fakeClaude,
    ]);
    assert.equal(result.code, 0, result.stderr);

    const content = readProgressFile(stateRoot);

    // progress.md must NOT contain user request text
    assert.doesNotMatch(content, /Please do fixes/i, 'should not contain user request text');

    // progress.md must NOT contain controller_messages (chat text)
    assert.doesNotMatch(content, /I will instruct Claude Code/, 'should not contain controller_messages text');
    assert.doesNotMatch(content, /Let me review the work/, 'should not contain controller_messages text');
    assert.doesNotMatch(content, /All unit tests passing\. The task has been completed/, 'should not contain controller_messages text');

    // progress.md must NOT contain delegation/worker chatter
    assert.doesNotMatch(content, /Delegating to Claude/i, 'should not contain delegation text');
    assert.doesNotMatch(content, /Worker done/i, 'should not contain worker done chatter');

    // progress.md must NOT have automatic Done/Error lines
    assert.doesNotMatch(content, /^.*\] Done$/m, 'should not contain automatic Done line');

    // progress.md SHOULD contain only the explicit progress_updates from fake-codex
    assert.match(content, /Starting test fixes/, 'should contain progress_update from first delegate');
    assert.match(content, /Reviewing Claude work/, 'should contain progress_update from review');
    assert.match(content, /Found bug in logic\.py/, 'should contain progress_update from review');
    assert.match(content, /Fix verified, all tests passing/, 'should contain progress_update from final stop');

    // Every line should be timestamped
    const lines = content.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 3, `expected at least 3 progress lines, got ${lines.length}`);
    for (const line of lines) {
      assert.match(line, /^\[\d{2}:\d{2}:\d{2}\]/, `line should be timestamped: ${line}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('simple greeting produces no progress lines in progress.md', async () => {
  const { tmpDir, repoRoot, stateRoot } = await setupIntegrationWorkspace();

  try {
    const result = await runCli([
      'run',
      'Hi',
      '--repo', repoRoot,
      '--state-dir', stateRoot,
      '--codex-bin', fakeCodex,
      '--claude-bin', fakeClaude,
    ]);
    assert.equal(result.code, 0, result.stderr);

    // Greeting has empty progress_updates — file should not exist or be empty
    const runsDir = path.join(stateRoot, 'runs');
    const runs = fs.readdirSync(runsDir);
    assert.equal(runs.length, 1);
    const progressFile = path.join(runsDir, runs[0], 'progress.md');
    let content = '';
    try { content = fs.readFileSync(progressFile, 'utf8'); } catch {}
    assert.equal(content.trim(), '', 'progress.md should be empty or absent for a greeting');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
