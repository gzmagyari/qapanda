const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const {
  CLOUD_RUN_SPEC_VERSION,
  buildDirectCloudRunPrompt,
  buildCloudRunOptions,
  createCloudRunEventBridge,
  detectCloudRunExecutionIssue,
  extractMeasuredUsageFromTranscriptEntries,
  loadCloudRunSpec,
  validateCloudRunSpec,
  writeCloudRunArtifacts,
} = require('../../src/cloud-run');
const { setHostedWorkflowExecutionContext } = require('../../src/cloud/workflow-hosted-runs');
const { parseCliRawEventLine } = require('@qapanda/run-protocol');

const originalProcessExitCode = process.exitCode;

test.after(() => {
  process.exitCode = originalProcessExitCode;
});

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

test('buildCloudRunOptions launches direct cloud runs through the QA-Browser agent instead of print mode', () => {
  const { spec } = createSpecFile();
  const options = buildCloudRunOptions(spec, { agentCli: 'api' });
  assert.equal(options.agent, 'QA-Browser');
  assert.equal(options.agentCli, 'api');
  assert.equal(options.print, false);
  assert.equal(options.cloudRunSpec.targetUrl, 'https://example.test/login');
});

test('buildCloudRunOptions preserves runtime API config for API-backed hosted runs', () => {
  const { spec } = createSpecFile({
    runtimeApiConfig: {
      source: 'ai_profile',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test-123',
    },
  });
  const options = buildCloudRunOptions(spec, {});
  assert.equal(options.controllerCli, 'api');
  assert.equal(options.workerCli, 'api');
  assert.equal(options.apiConfig.provider, 'openai');
  assert.equal(options.apiConfig.model, 'gpt-5');
  assert.equal(options.apiConfig.apiKey, 'sk-test-123');
});

test('loadCloudRunSpec preserves runtime API keys in memory for execution', () => {
  const { tempDir, specPath } = createSpecFile({
    runtimeApiConfig: {
      source: 'ai_profile',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      apiKey: 'sk-or-v1-test-123',
      baseURL: 'https://openrouter.ai/api/v1',
    },
  });
  try {
    const loaded = loadCloudRunSpec(specPath);
    assert.equal(loaded.spec.runtimeApiConfig.provider, 'openrouter');
    assert.equal(loaded.spec.runtimeApiConfig.model, 'anthropic/claude-haiku-4.5');
    assert.equal(loaded.spec.runtimeApiConfig.apiKey, 'sk-or-v1-test-123');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildDirectCloudRunPrompt includes hosted target context for browser QA runs', () => {
  const { spec } = createSpecFile();
  const prompt = buildDirectCloudRunPrompt(spec);
  assert.match(prompt, /Check the login form\./);
  assert.match(prompt, /Hosted run execution requirements:/);
  assert.match(prompt, /Use this exact target URL for the test: https:\/\/example\.test\/login/);
  assert.match(prompt, /Do not try to discover the app URL from the repository or environment/);
  assert.match(prompt, /Start by opening that URL in the browser and testing there/);
  assert.match(prompt, /Browser preset: desktop_chrome/);
});

test('validateCloudRunSpec accepts optional hosted workflow metadata blocks', () => {
  const { spec } = createSpecFile({
    workflowDefinition: {
      id: 'deep-login',
      name: 'Deep Login',
      description: 'Hosted login workflow',
      preferredMode: 'orchestrate',
      suggestedAgent: 'QA-Browser',
      body: '# Goal\n\nTest the login page deeply.\n',
      inputs: [
        { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
        { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
      ],
    },
    workflowProfile: {
      profileId: 'staging-login',
      name: 'Staging Login',
    },
    workflowInputs: {
      environment_url: 'https://staging.example.test/login',
    },
    workflowSecretRefs: {
      login_password: 'secret-login-password',
    },
  });
  const validated = validateCloudRunSpec(spec);
  assert.equal(validated.workflowDefinition.id, 'deep-login');
  assert.equal(validated.workflowProfile.profileId, 'staging-login');
  assert.equal(validated.workflowInputs.environment_url, 'https://staging.example.test/login');
  assert.equal(validated.workflowSecretRefs.login_password, 'secret-login-password');
});

test('validateCloudRunSpec rejects plaintext secret workflow inputs', () => {
  const { spec } = createSpecFile({
    workflowDefinition: {
      id: 'deep-login',
      name: 'Deep Login',
      preferredMode: 'orchestrate',
      inputs: [
        { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
        { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
      ],
    },
    workflowInputs: {
      environment_url: 'https://staging.example.test/login',
      login_password: 'plaintext-secret',
    },
    workflowSecretRefs: {
      login_password: 'secret-login-password',
    },
  });

  assert.throws(() => validateCloudRunSpec(spec), /workflowInputs\.login_password must not include secret field values/i);
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
  const { tempDir, spec } = createSpecFile({
    runtimeApiConfig: {
      source: 'ai_profile',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
      apiKey: 'sk-or-v1-secret-test',
      baseURL: 'https://openrouter.ai/api/v1',
    },
  });
  const runDir = path.join(tempDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });

  const manifestPath = path.join(runDir, 'manifest.json');
  const eventsPath = path.join(runDir, 'events.jsonl');
  const transcriptPath = path.join(runDir, 'transcript.jsonl');
  const chatPath = path.join(runDir, 'chat.jsonl');
  const progressPath = path.join(runDir, 'progress.md');

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      runId: 'run_123',
      runDir,
      status: 'idle',
      createdAt: '2026-04-18T21:18:06.248Z',
      updatedAt: '2026-04-18T21:20:18.416Z',
      controller: {
        cli: 'api',
        apiConfig: {
          provider: 'openrouter',
          model: 'anthropic/claude-haiku-4.5',
          apiKey: 'controller-secret',
        },
      },
      worker: {
        cli: 'api',
        apiConfig: {
          provider: 'openrouter',
          model: 'anthropic/claude-haiku-4.5',
          apiKey: 'worker-secret',
        },
      },
    }, null, 2),
  );
  fs.writeFileSync(eventsPath, '{"source":"launch-claude"}\n');
  fs.writeFileSync(chatPath, '{"type":"user","text":"hello"}\n');
  fs.writeFileSync(progressPath, '[00:00:01] Started\n');
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        v: 2,
        kind: 'backend_event',
        sessionKey: 'worker-default',
        payload: {
          source: 'worker-api',
          type: 'start',
          provider: 'openai',
          model: 'gpt-5',
        },
      }),
      JSON.stringify({
        v: 2,
        kind: 'backend_event',
        sessionKey: 'worker-default',
        payload: {
          source: 'worker-api',
          type: 'complete',
          totalUsage: {
            promptTokens: 1200,
            completionTokens: 300,
          },
        },
      }),
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
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'run-report.json'), 'utf8'));
    const publicManifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'run-files', 'manifest.json'), 'utf8'));
    assert.equal(report.measuredUsage.totals.totalTokens, 1500);
    assert.equal(report.measuredUsage.sessions[0].provider, 'openai');
    assert.equal(report.status, 'succeeded');
    assert.deepEqual(report.runtime, {
      source: 'ai_profile',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
    });
    assert.equal(report.runtimeApiConfig, undefined);
    assert.equal(report.runDir, undefined);
    assert.doesNotMatch(JSON.stringify(report), /sk-or-v1-secret-test|controller-secret|worker-secret/);
    assert.ok(fs.existsSync(path.join(outputDir, 'session.log')));
    assert.ok(fs.existsSync(path.join(outputDir, 'evidence-bundle.json')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'transcript.jsonl')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'chat.jsonl')));
    assert.ok(fs.existsSync(path.join(outputDir, 'run-files', 'progress.md')));
    assert.ok(fs.existsSync(path.join(outputDir, 'screenshots', 'screenshot-001.png')));
    assert.equal(publicManifest.status, 'succeeded');
    assert.deepEqual(publicManifest.runtime, {
      source: 'ai_profile',
      provider: 'openrouter',
      model: 'anthropic/claude-haiku-4.5',
    });
    assert.deepEqual(publicManifest.files, {
      events: 'run-files/events.jsonl',
      transcript: 'run-files/transcript.jsonl',
      chatLog: 'run-files/chat.jsonl',
      progress: 'run-files/progress.md',
    });
    assert.equal(publicManifest.controller, undefined);
    assert.equal(publicManifest.worker, undefined);
    assert.equal(publicManifest.runDir, undefined);
    assert.doesNotMatch(JSON.stringify(publicManifest), /sk-or-v1-secret-test|controller-secret|worker-secret/);
    assert.ok(artifacts.some((artifact) => artifact.artifactType === 'report_json'));
    assert.ok(artifacts.some((artifact) => artifact.artifactType === 'screenshot'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('extractMeasuredUsageFromTranscriptEntries aggregates backend token usage from transcript events', () => {
  const usage = extractMeasuredUsageFromTranscriptEntries([
    {
      v: 2,
      kind: 'backend_event',
      sessionKey: 'worker-default',
      payload: {
        source: 'worker-api',
        type: 'start',
        provider: 'openai',
        model: 'gpt-5',
      },
    },
    {
      v: 2,
      kind: 'backend_event',
      sessionKey: 'worker-default',
      payload: {
        source: 'worker-api',
        type: 'complete',
        totalUsage: {
          promptTokens: 800,
          completionTokens: 200,
        },
      },
    },
  ]);
  assert.equal(usage.totals.totalTokens, 1000);
  assert.equal(usage.sessions[0].provider, 'openai');
  assert.equal(usage.sessions[0].model, 'gpt-5');
});

test('createCloudRunEventBridge forwards raw worker json lines into cloud-run events', async () => {
  const { spec } = createSpecFile();
  const events = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    events.push(String(chunk).trim());
    return true;
  };
  try {
    const bridge = createCloudRunEventBridge(spec);
    await bridge({
      source: 'worker-json',
      rawLine: '{"type":"thread.started","thread_id":"real-session"}',
      parsed: { type: 'thread.started', thread_id: 'real-session' },
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(events.length, 1);
  const rawEvent = parseCliRawEventLine(events[0]);
  assert.equal(rawEvent.type, 'session.note');
  assert.equal(rawEvent.source, 'worker-json');
  assert.equal(rawEvent.parsed.type, 'thread.started');
});

test('createCloudRunEventBridge emits structured assistant messages for API-backed worker events', async () => {
  const { spec } = createSpecFile();
  const events = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    events.push(String(chunk).trim());
    return true;
  };
  try {
    const bridge = createCloudRunEventBridge(spec);
    await bridge({
      source: 'worker-api',
      type: 'assistant_message',
      text: 'Opened the login page and found the submit button.',
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(events.length, 1);
  const rawEvent = parseCliRawEventLine(events[0]);
  assert.equal(rawEvent.type, 'session.note');
  assert.equal(rawEvent._streamDetail, true);
  assert.equal(rawEvent.liveItem.kind, 'assistant_message');
  assert.equal(rawEvent.liveItem.actor, 'worker');
  assert.match(rawEvent.liveItem.text, /Opened the login page/);
});

test('createCloudRunEventBridge emits structured tool events for API-backed worker activity', async () => {
  const { spec } = createSpecFile();
  const events = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    events.push(String(chunk).trim());
    return true;
  };
  try {
    const bridge = createCloudRunEventBridge(spec);
    await bridge({
      source: 'worker-api',
      type: 'tool_call',
      name: 'builtin_tools__read_file',
      input: { path: '/workspace/app.ts' },
    });
    await bridge({
      source: 'worker-api',
      type: 'tool_result',
      name: 'builtin_tools__read_file',
      summary: 'Read /workspace/app.ts successfully.',
    });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(events.length, 2);
  const toolCallEvent = parseCliRawEventLine(events[0]);
  const toolResultEvent = parseCliRawEventLine(events[1]);
  assert.equal(toolCallEvent.liveItem.kind, 'tool_call');
  assert.equal(toolCallEvent.liveItem.toolName, 'builtin_tools__read_file');
  assert.equal(toolResultEvent.liveItem.kind, 'tool_result');
  assert.match(toolResultEvent.liveItem.summary, /Read \/workspace\/app\.ts successfully/);
});

test('detectCloudRunExecutionIssue flags fake codex sessions in manifest events', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-run-events-'));
  const eventsPath = path.join(tempDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, '{"source":"worker-json","rawLine":"{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"fake-codex-session-0001\\"}"}\n', 'utf8');
  try {
    const issue = await detectCloudRunExecutionIssue({
      files: {
        events: eventsPath,
      },
    });
    assert.match(issue, /fake codex shim/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeCloudRunArtifacts redacts hosted workflow secrets in copied text artifacts and reports', async () => {
  const { tempDir, spec } = createSpecFile({
    workflowDefinition: {
      id: 'deep-login',
      name: 'Deep Login',
      preferredMode: 'orchestrate',
      inputs: [
        { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
      ],
    },
    workflowSecretRefs: {
      login_password: 'secret-login-password',
    },
  });
  const runDir = path.join(tempDir, 'run');
  fs.mkdirSync(runDir, { recursive: true });

  const manifestPath = path.join(runDir, 'manifest.json');
  const eventsPath = path.join(runDir, 'events.jsonl');
  const transcriptPath = path.join(runDir, 'transcript.jsonl');
  const chatPath = path.join(runDir, 'chat.jsonl');
  const progressPath = path.join(runDir, 'progress.md');

  fs.writeFileSync(manifestPath, JSON.stringify({ note: 'super-secret-password' }, null, 2));
  fs.writeFileSync(eventsPath, '{"text":"super-secret-password"}\n');
  fs.writeFileSync(chatPath, '{"text":"super-secret-password"}\n');
  fs.writeFileSync(progressPath, 'Password: super-secret-password\n');
  fs.writeFileSync(transcriptPath, '{"text":"super-secret-password"}\n');

  const manifest = {
    runId: 'run_123',
    runDir,
    status: 'idle',
    stopReason: 'done',
    transcriptSummary: 'super-secret-password',
    files: {
      manifest: manifestPath,
      events: eventsPath,
      transcript: transcriptPath,
      chatLog: chatPath,
      progress: progressPath,
    },
  };
  setHostedWorkflowExecutionContext(manifest, {
    resolvedSecretValues: {
      login_password: 'super-secret-password',
    },
  });

  try {
    await writeCloudRunArtifacts(manifest, spec);
    const outputDir = spec.outputDir;
    const reportRaw = fs.readFileSync(path.join(outputDir, 'run-report.json'), 'utf8');
    const sessionLogRaw = fs.readFileSync(path.join(outputDir, 'session.log'), 'utf8');
    const transcriptRaw = fs.readFileSync(path.join(outputDir, 'run-files', 'transcript.jsonl'), 'utf8');

    assert.match(reportRaw, /\[REDACTED_WORKFLOW_SECRET:login_password\]/);
    assert.match(sessionLogRaw, /\[REDACTED_WORKFLOW_SECRET:login_password\]/);
    assert.match(transcriptRaw, /\[REDACTED_WORKFLOW_SECRET:login_password\]/);
    assert.doesNotMatch(reportRaw, /super-secret-password/);
    assert.doesNotMatch(sessionLogRaw, /super-secret-password/);
    assert.doesNotMatch(transcriptRaw, /super-secret-password/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('createCloudRunEventBridge redacts hosted workflow secrets in raw worker result events', async () => {
  const rawEvents = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk, encoding, callback) => {
    rawEvents.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    const bridge = createCloudRunEventBridge({ title: 'Deep Login' }, {
      redactValue(value) {
        return String(value).split('super-secret-password').join('[REDACTED_WORKFLOW_SECRET:login_password]');
      },
    });
    await bridge({
      source: 'worker-result',
      text: 'Use super-secret-password to sign in.',
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const event = parseCliRawEventLine(rawEvents[0]);
  assert.equal(event.type, 'session.note');
  assert.equal(event._streamDetail, true);
  assert.equal(event.liveItem.kind, 'assistant_message');
  assert.match(event.message, /\[REDACTED_WORKFLOW_SECRET:login_password\]/);
  assert.doesNotMatch(event.message, /super-secret-password/);
});

test('createCloudRunEventBridge treats worker result as the final transcript item and hides turn-complete noise', async () => {
  const rawEvents = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk, encoding, callback) => {
    rawEvents.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    const bridge = createCloudRunEventBridge({ title: 'Login2' });
    await bridge({ source: 'worker-api', type: 'complete', iterations: 10 });
    await bridge({
      source: 'worker-result',
      exitCode: 0,
      text: '## Test Execution Report\n\nThe login page is blocked by a Cloudflare 521 error.',
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  assert.equal(rawEvents.length, 1);
  const event = parseCliRawEventLine(rawEvents[0]);
  assert.equal(event.type, 'session.note');
  assert.equal(event.phase, 'results');
  assert.equal(event.liveItem.kind, 'assistant_message');
  assert.match(event.liveItem.text, /Test Execution Report/);
});

test('createCloudRunEventBridge promotes controller guidance and progress into customer-facing raw events', async () => {
  const rawEvents = [];
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk, encoding, callback) => {
    rawEvents.push(String(chunk));
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    const bridge = createCloudRunEventBridge({ title: 'Checkout smoke' });
    await bridge({ source: 'launch-claude', text: 'delegating' });
    await bridge({ source: 'controller-message', text: 'Checking authentication before attempting checkout.' });
    await bridge({ source: 'progress-update', text: 'Reviewing login state and current workspace.' });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const events = rawEvents.map((line) => parseCliRawEventLine(line)).filter(Boolean);
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'session.progress');
  assert.equal(events[0].phase, 'execution');
  assert.equal(events[0].progressPercent, 15);
  assert.equal(events[1].type, 'session.note');
  assert.equal(events[1].phase, 'planning');
  assert.equal(events[2].type, 'session.progress');
  assert.equal(events[2].phase, 'execution');
  assert.match(events[2].message, /Reviewing login state/);
});

test('main dispatches cloud-run spec into the one-shot pipeline', async () => {
  const { tempDir, specPath } = createSpecFile();
  const cliPath = require.resolve('../../src/cli');
  const originalLoad = Module._load;
  const calls = {
    prepareNewRun: [],
    runDirectWorkerTurn: [],
    closeAllMcpToolBridge: 0,
    saveManifest: 0,
    requestStarted: [],
    summary: [],
    rawEvents: [],
  };
  const originalStdoutWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
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
      if (request === './mcp-tool-bridge') {
        return {
          closeAll: async () => { calls.closeAllMcpToolBridge += 1; },
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
    assert.match(calls.prepareNewRun[0].message, /Check the login form\./);
    assert.match(calls.prepareNewRun[0].message, /Use this exact target URL for the test: https:\/\/example\.test\/login/);
    assert.equal(calls.prepareNewRun[0].options.rawEvents, true);
    assert.equal(calls.prepareNewRun[0].options.controllerCodexMode, 'cli');
    assert.equal(calls.prepareNewRun[0].options.agentCli, undefined);
    assert.equal(calls.runDirectWorkerTurn.length, 1);
    assert.match(calls.runDirectWorkerTurn[0].options.userMessage, /Check the login form\./);
    assert.equal(calls.runDirectWorkerTurn[0].options.agentId, 'QA-Browser');
    assert.equal(typeof calls.runDirectWorkerTurn[0].options.onEvent, 'function');
    assert.equal(calls.closeAllMcpToolBridge, 1);
    assert.deepEqual(calls.requestStarted, ['run_123']);
    assert.deepEqual(calls.summary, []);
    const rawLines = calls.rawEvents.join('').split(/\r?\n/).filter(Boolean).map((line) => parseCliRawEventLine(line));
    assert.ok(rawLines.some((event) => event && event.type === 'session.started'));
    assert.ok(rawLines.some((event) => event && event.type === 'session.note' && event.liveItem && event.liveItem.kind === 'user_message' && /Check the login form\./.test(event.liveItem.text)));
    assert.ok(rawLines.some((event) => event && event.type === 'browser.navigation'));
    assert.ok(rawLines.some((event) => event && event.type === 'artifact.created' && event.filename === 'run-report.json'));
    assert.ok(rawLines.some((event) => event && event.type === 'session.completed'));
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
    Module._load = originalLoad;
    delete require.cache[cliPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('main dispatches workflow-backed cloud-run specs through the controller path', async () => {
  const { tempDir, specPath } = createSpecFile({
    prompt: 'Run the hosted workflow "Deep Login".',
    workflowDefinition: {
      id: 'deep-login',
      name: 'Deep Login',
      description: 'Hosted login workflow',
      preferredMode: 'orchestrate',
      suggestedAgent: 'QA-Browser',
      body: '# Goal\n\nTest the login page deeply.\n',
      inputs: [
        { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
      ],
    },
    workflowInputs: {
      environment_url: 'https://staging.example.test/login',
    },
  });
  const cliPath = require.resolve('../../src/cli');
  const originalLoad = Module._load;
  const calls = {
    prepareNewRun: [],
    runManagerLoop: [],
    runDirectWorkerTurn: [],
    closeAllMcpToolBridge: 0,
    saveManifest: 0,
    requestStarted: [],
    rawEvents: [],
  };
  const originalStdoutWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
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
              settings: { rawEvents: true, quiet: false },
              controller: { cli: 'codex', extraInstructions: null },
              worker: { cli: 'codex' },
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
          printRunSummary: async () => {},
          runManagerLoop: async (manifest, _renderer, options) => {
            calls.runManagerLoop.push({ manifest, options });
          },
          runDirectWorkerTurn: async () => {
            calls.runDirectWorkerTurn.push(true);
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
      if (request === './mcp-tool-bridge') {
        return {
          closeAll: async () => { calls.closeAllMcpToolBridge += 1; },
        };
      }
      if (request === './cloud') {
        return {
          createCloudBoundary: () => ({
            preload: async () => {},
            createWorkflowSecretStore: () => ({
              isAvailable() {
                return false;
              },
            }),
          }),
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
    await main(['cloud-run', '--spec', specPath, '--raw-events']);
    const expectedWorkflowPrompt = [
      'Use this exact target URL for the workflow: https://example.test/login',
      'Do not try to discover the app URL from the repository or environment unless the page fails to load.',
      'Start by opening that URL in the browser and execute the workflow against it.',
      'Target type: web',
      'Browser preset: desktop_chrome',
      'Run the hosted workflow "Deep Login".',
      '',
      'Workflow input values:',
      '- environment_url: https://staging.example.test/login',
      '',
      'Full workflow recipe for "Deep Login":',
      '# Goal',
      '',
      'Test the login page deeply.',
    ].join('\n');
    assert.equal(calls.prepareNewRun.length, 1);
    assert.equal(calls.prepareNewRun[0].message, expectedWorkflowPrompt);
    assert.equal(calls.runDirectWorkerTurn.length, 0);
    assert.equal(calls.runManagerLoop.length, 1);
    assert.equal(calls.runManagerLoop[0].options.userMessage, expectedWorkflowPrompt);
    assert.equal(calls.closeAllMcpToolBridge, 1);
    assert.deepEqual(calls.requestStarted, ['run_123']);
    const rawLines = calls.rawEvents.join('').split(/\r?\n/).filter(Boolean).map((line) => parseCliRawEventLine(line));
    assert.ok(rawLines.some((event) => event && event.type === 'session.completed'));
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.exitCode = originalExitCode;
    Module._load = originalLoad;
    delete require.cache[cliPath];
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
