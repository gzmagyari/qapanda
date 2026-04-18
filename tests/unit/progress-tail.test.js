const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const extDir = path.resolve(__dirname, '..', '..', 'extension');
const smPath = path.join(extDir, 'session-manager.js');
const statePath = path.join(extDir, 'src', 'state.js');
const orchPath = path.join(extDir, 'src', 'orchestrator.js');
const promptsPath = path.join(extDir, 'src', 'prompts.js');

const origState = require(statePath);
const origOrch = require(orchPath);
const origPrompts = require(promptsPath);

function stubRenderer() {
  return new Proxy({}, {
    get() { return () => {}; },
  });
}

function buildSession(progressContent) {
  const posted = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-progress-tail-'));
  const progressFile = path.join(tmpDir, 'progress.md');
  fs.writeFileSync(progressFile, progressContent, 'utf8');

  const fakeManifest = {
    runId: 'progress-tail-run',
    runDir: tmpDir,
    controller: { model: null, config: [] },
    worker: { model: null },
    files: { progress: progressFile },
  };

  delete require.cache[smPath];
  require.cache[statePath] = {
    id: statePath,
    filename: statePath,
    loaded: true,
    exports: {
      ...origState,
      resolveRunDir: async () => tmpDir,
      loadManifestFromDir: async () => ({ ...fakeManifest }),
      prepareNewRun: async () => ({ ...fakeManifest }),
      saveManifest: async () => {},
    },
  };
  require.cache[orchPath] = {
    id: orchPath,
    filename: orchPath,
    loaded: true,
    exports: {
      ...origOrch,
      runManagerLoop: async (manifest) => manifest,
    },
  };
  require.cache[promptsPath] = {
    id: promptsPath,
    filename: promptsPath,
    loaded: true,
    exports: {
      ...origPrompts,
      loadWorkflows: () => [],
    },
  };

  const { SessionManager } = require(smPath);
  const session = new SessionManager(stubRenderer(), {
    repoRoot: tmpDir,
    stateRoot: tmpDir,
    postMessage: (msg) => posted.push(msg),
  });

  const cleanup = () => {
    session.dispose();
    delete require.cache[smPath];
    require.cache[statePath] = { id: statePath, filename: statePath, loaded: true, exports: origState };
    require.cache[orchPath] = { id: orchPath, filename: orchPath, loaded: true, exports: origOrch };
    require.cache[promptsPath] = { id: promptsPath, filename: promptsPath, loaded: true, exports: origPrompts };
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };

  return { session, posted, cleanup };
}

test('sendProgress restores only the latest progress tail for very large files', async () => {
  const lines = Array.from({ length: 6000 }, (_, index) =>
    `[12:${String(Math.floor((index / 60) % 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}] line ${index} ${'x'.repeat(120)}`);
  const content = `${lines.join('\n')}\n`;
  const { session, posted, cleanup } = buildSession(content);

  try {
    await session.reattachRun('progress-tail-run');
    posted.length = 0;

    await session.sendProgress();
    const msg = posted.find((entry) => entry.type === 'progressFull');
    assert.ok(msg, 'should post progressFull');
    assert.match(msg.text, /Showing only the latest progress tail for this run\./);
    assert.ok(msg.text.includes('line 5999'), 'should include the latest progress lines');
    assert.ok(!msg.text.includes('line 0 '), 'should omit the earliest progress lines');
  } finally {
    cleanup();
  }
});
