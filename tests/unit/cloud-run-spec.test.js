const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const {
  CLOUD_RUN_SPEC_VERSION,
  loadCloudRunSpec,
  validateCloudRunSpec,
  writeCloudRunArtifacts,
} = require('../../src/cloud-run');
const { parseCliRawEventLine } = require('@qapanda/run-protocol');

function createSpecFile(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-run-spec-'));
  const specPath = path.join(tempDir, 'run-spec.json');
  const spec = {
    version: CLOUD_RUN_SPEC_VERSION,
    runId: 'run_123',
    attemptId: 'attempt_123',
    repositoryId: 'repo_123',
    outputDir: path.join(tempDir, 'output'),
    repositoryContextId: 'ctx_123',
    title: 'Example run',
    prompt: 'Check the login form.',
    targetUrl: 'https://example.test/login',
    targetType: 'web',
    browserPreset: 'desktop_chrome',
    aiProfile: {
      profileId: 'profile_123',
      name: 'Default Browser QA',
      provider: 'openai',
      model: 'gpt-5',
    },
    ...overrides,
  };
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
  return { tempDir, specPath, spec };
}

test('validateCloudRunSpec accepts the documented v1 shape', () => {
  const { spec } = createSpecFile();
  assert.equal(validateCloudRunSpec(spec).version, CLOUD_RUN_SPEC_VERSION);
});

test('loadCloudRunSpec rejects unsupported versions clearly', () => {
  const { tempDir, specPath } = createSpecFile({ version: 'v0' });
  try {
    assert.throws(() => loadCloudRunSpec(specPath), /version must be "qapanda\.cloud-run\/v1"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadCloudRunSpec rejects missing prompt clearly', () => {
  const { tempDir, specPath } = createSpecFile({ prompt: null });
  try {
    assert.throws(() => loadCloudRunSpec(specPath), /prompt must be a non-empty string/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadCloudRunSpec rejects missing outputDir clearly', () => {
  const { tempDir, specPath } = createSpecFile({ outputDir: null });
  try {
    assert.throws(() => loadCloudRunSpec(specPath), /outputDir must be a non-empty string/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeCloudRunArtifacts writes deterministic report, logs, run files, and screenshots', async () => {
  const { tempDir, spec } = createSpecFile();
  const runDir = path.join(tempDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });

  const manifestPath = path.join(runDir, 'manifest.json');
  const eventsPath = path.join(runDir, 'events.jsonl');
  const transcriptPath = path.join(runDir, 'transcript.jsonl');
  const chatPath = path.join(runDir, 'chat.jsonl');
  const progressPath = path.join(runDir, 'progress.md');

  fs.writeFileSync(manifestPath, JSON.stringify({ runId: 'run_123' }, null, 2));
  fs.writeFileSync(eventsPath, '{"source":"launch-claude"}\n');
  fs.writeFileSync(chatPath, '{"type":"user","text":"hello"}\n');
  fs.writeFileSync(progressPath, '[00:00:01] Started\n');
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        v: 2,
        kind: 'tool_result',
        result: {
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: Buffer.from('fake-screenshot').toString('base64'),
            },
          ],
        },
      }),
    ].join('\n') + '\n',
  );

  const manifest = {
    runId: 'run_123',
    runDir,
    status: 'idle',
    stopReason: 'done',
    transcriptSummary: 'Completed',
    files: {
      manifest: manifestPath,
      events: eventsPath,
      transcript: transcriptPath,
      chatLog: chatPath,
      progress: progressPath,
    },
  };

  try {
    const artifacts = await writeCloudRunArtifacts(manifest, spec);
    const outputDir = spec.outputDir;
    assert.ok(fs.existsSync(path.join(outputDir, 'run-report.json')));
    assert.ok(fs.existsSync(path.join(outputDir, 'session.log')));
    assert.ok(fs.existsSync(path.join(outputDir, 'evidence-bundle.json')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'transcript.jsonl')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'chat.jsonl')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'progress.md')));
    assert.ok(fs.existsSync(path.join(outputDir, 'screenshots', 'screenshot-001.png')));
    assert.ok(artifacts.some((artifact) => artifact.artifactType === 'report_json'));
    assert.ok(artifacts.some((artifact) => artifact.artifactType === 'screenshot'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('main dispatches cloud-run spec into the one-shot pipeline', async () => {
  const { tempDir, specPath } = createSpecFile();
  const cliPath = require.resolve('../../src/cli');
  const originalLoad = Module._load;
  const calls = {
    prepareNewRun: [],
    runDirectWorkerTurn: [],
    saveManifest: 0,
    requestStarted: [],
    summary: [],
    rawEvents: [],
  };
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk, encoding, callback) => {
    calls.rawEvents.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  });

  Module._load = function patchedLoader(request, parent, isMain) {
    if (parent && parent.id === cliPath) {
      if (request === './state') {
        return {
          defaultStateRoot: () => path.join(tempDir, '.qpanda'),
          listRunManifests: async () => [],
          loadManifestFromDir: async () => { throw new Error('not used'); },
          lookupAgentConfig: () => null,
          prepareNewRun: async (message, options) => {
            calls.prepareNewRun.push({ message, options });
            const runDir = path.join(tempDir, 'run');
            const outputDir = path.join(tempDir, 'output');
            fs.mkdirSync(runDir, { recursive: true });
            fs.mkdirSync(outputDir, { recursive: true });
            const files = {
              manifest: path.join(runDir, 'manifest.json'),
              events: path.join(runDir, 'events.jsonl'),
              transcript: path.join(runDir, 'transcript.jsonl'),
              chatLog: path.join(runDir, 'chat.jsonl'),
              progress: path.join(runDir, 'progress.md'),
            };
            fs.writeFileSync(files.manifest, JSON.stringify({ runId: 'run_123' }, null, 2));
            fs.writeFileSync(files.events, '');
            fs.writeFileSync(files.transcript, '');
            fs.writeFileSync(files.chatLog, '');
            fs.writeFileSync(files.progress, '');
            return {
              runId: 'run_123',
              runDir,
              status: 'idle',
              stopReason: null,
              transcriptSummary: 'done',
              settings: { rawEvents: Boolean(options.rawEvents), quiet: Boolean(options.quiet) },
              worker: {},
              controller: {},
              files,
            };
          },
          resolveRunDir: async () => '',
          saveManifest: async () => { calls.saveManifest += 1; },
        };
      }
      if (request === './orchestrator') {
        return {
          printEventTail: async () => {},
          printRunSummary: async (manifest) => { calls.summary.push(manifest.runId); },
          runManagerLoop: async () => { throw new Error('cloud-run should use direct worker path'); },
          runDirectWorkerTurn: async (manifest, _renderer, options) => {
            calls.runDirectWorkerTurn.push({ manifest, options });
          },
        };
      }
      if (request === './render') {
        return {
          Renderer: class Renderer {
            constructor() {}
            requestStarted(runId) { calls.requestStarted.push(runId); }
            close() {}
          },
        };
      }
      if (request === './process-utils') {
        return {
          execForText: async () => ({ code: 0, stdout: 'codex 0.0.0', stderr: '' }),
        };
      }
      if (request === './config-loader') {
        return {
          findResourcesDir: () => tempDir,
          loadMergedAgents: () => ({ QA: { name: 'QA', cli: 'codex' } }),
          loadMergedModes: () => ({}),
          loadMergedMcpServers: () => ({ global: {}, project: {} }),
          enabledAgents: (data) => data,
          enabledModes: (data) => data,
          resolveByEnv: (value) => value,
          getCliDefaults: () => ({ controllerCli: 'codex', workerCli: 'codex' }),
          loadOnboarding: () => null,
          isOnboardingComplete: () => true,
        };
      }
      if (request === './mcp-injector') {
        return {
          mcpServersForRole: () => ({}),
        };
      }
      if (request === './cloud') {
        return {
          createCloudBoundary: () => ({ preload: async () => {} }),
        };
      }
      if (request === './cloud/cli-auth') {
        return {
          runCloudCommand: async () => {},
          CLOUD_COMMAND_USAGE: '  qapanda cloud status',
        };
      }
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[cliPath];
  try {
    const { main } = require('../../src/cli');
    await main(['cloud-run', '--spec', specPath, '--raw-events', '--controller-codex-mode', 'cli']);
    assert.equal(calls.prepareNewRun.length, 1);
    assert.equal(calls.prepareNewRun[0].message, 'Check the login form.');
    assert.equal(calls.prepareNewRun[0].options.rawEvents, true);
    assert.equal(calls.prepareNewRun[0].options.controllerCodexMode, 'cli');
    assert.equal(calls.runDirectWorkerTurn.length, 1);
    assert.equal(calls.runDirectWorkerTurn[0].options.userMessage, 'Check the login form.');
    assert.equal(typeof calls.runDirectWorkerTurn[0].options.onEvent, 'function');
    assert.deepEqual(calls.requestStarted, ['run_123']);
    assert.deepEqual(calls.summary, []);
    const rawLines = calls.rawEvents.join('').split(/\r?\n/).filter(Boolean).map((line) => parseCliRawEventLine(line));
    assert.ok(rawLines.some((event) => event && event.type === 'session.started'));
    assert.ok(rawLines.some((event) => event && event.type === 'browser.navigation'));
    assert.ok(rawLines.some((event) => event && event.type === 'artifact.created' && event.filename === 'run-report.json'));
    assert.ok(rawLines.some((event) => event && event.type === 'session.completed'));
  } finally {
    process.stdout.write = originalStdoutWrite;
    Module._load = originalLoad;
    delete require.cache[cliPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
