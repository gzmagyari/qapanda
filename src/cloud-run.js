const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ensureDir, nowIso, pathExists, readText, writeJson, writeText } = require('./utils');

const CLOUD_RUN_SPEC_VERSION = 'qapanda.cloud-run/v1';

const CLOUD_RUN_ARG_SPEC = {
  'spec': { key: 'specPath', kind: 'value' },
  'repo': { key: 'repoRoot', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'controller-codex-mode': { key: 'controllerCodexMode', kind: 'value' },
  'raw-events': { key: 'rawEvents', kind: 'boolean' },
  'quiet': { key: 'quiet', kind: 'boolean' },
  'no-mcp-inject': { key: 'noMcpInject', kind: 'boolean' },
};

function fail(field, message) {
  throw new Error(`Invalid cloud-run spec: ${field} ${message}`);
}

function expectRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(field, 'must be a non-empty string.');
  }
  return value;
}

function expectOptionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') fail(field, 'must be a string or null.');
  return value;
}

function expectOptionalObject(value, field) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'must be an object or null.');
  }
  return value;
}

function validateAiProfile(value) {
  const aiProfile = expectOptionalObject(value, 'aiProfile');
  if (!aiProfile) return null;
  return {
    profileId: expectRequiredString(aiProfile.profileId, 'aiProfile.profileId'),
    name: expectOptionalString(aiProfile.name, 'aiProfile.name'),
    provider: expectOptionalString(aiProfile.provider, 'aiProfile.provider'),
    model: expectOptionalString(aiProfile.model, 'aiProfile.model'),
  };
}

function validateCloudRunSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid cloud-run spec: root must be a JSON object.');
  }
  if (input.version !== CLOUD_RUN_SPEC_VERSION) {
    throw new Error(
      `Invalid cloud-run spec: version must be "${CLOUD_RUN_SPEC_VERSION}".`,
    );
  }
  return {
    version: input.version,
    runId: expectRequiredString(input.runId, 'runId'),
    attemptId: expectRequiredString(input.attemptId, 'attemptId'),
    repositoryId: expectRequiredString(input.repositoryId, 'repositoryId'),
    outputDir: expectRequiredString(input.outputDir, 'outputDir'),
    repositoryContextId: expectOptionalString(input.repositoryContextId, 'repositoryContextId'),
    title: expectRequiredString(input.title, 'title'),
    prompt: expectRequiredString(input.prompt, 'prompt'),
    targetUrl: expectOptionalString(input.targetUrl, 'targetUrl'),
    targetType: expectOptionalString(input.targetType, 'targetType'),
    browserPreset: expectOptionalString(input.browserPreset, 'browserPreset'),
    aiProfile: validateAiProfile(input.aiProfile),
  };
}

function loadCloudRunSpec(specPath) {
  const resolvedPath = path.resolve(expectRequiredString(specPath, 'specPath'));
  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read cloud-run spec file: ${resolvedPath} (${message})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid cloud-run spec JSON in ${resolvedPath}: ${message}`);
  }

  return { specPath: resolvedPath, spec: validateCloudRunSpec(parsed) };
}

function buildCloudRunOptions(spec, cliOptions = {}) {
  return {
    repoRoot: cliOptions.repoRoot ? path.resolve(cliOptions.repoRoot) : process.cwd(),
    stateRoot: cliOptions.stateRoot ? path.resolve(cliOptions.stateRoot) : undefined,
    runId: spec.runId,
    controllerCodexMode: cliOptions.controllerCodexMode || undefined,
    print: true,
    rawEvents: Boolean(cliOptions.rawEvents),
    quiet: Boolean(cliOptions.quiet),
    noMcpInject: Boolean(cliOptions.noMcpInject),
    cloudRunSpec: {
      version: spec.version,
      runId: spec.runId,
      attemptId: spec.attemptId,
      repositoryId: spec.repositoryId,
      repositoryContextId: spec.repositoryContextId,
      title: spec.title,
      outputDir: path.resolve(spec.outputDir),
      targetUrl: spec.targetUrl,
      targetType: spec.targetType,
      browserPreset: spec.browserPreset,
      aiProfile: spec.aiProfile,
    },
  };
}

function emitCloudRunRawEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function createCloudRunEventBridge(spec) {
  return async (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.source === 'launch-claude' || event.source === 'launch-claude-direct') {
      emitCloudRunRawEvent({
        type: 'session.note',
        message: `Delegated worker execution for ${spec.title}.`,
      });
      return;
    }
    if (event.source === 'worker-result') {
      emitCloudRunRawEvent({
        type: 'session.note',
        message: typeof event.text === 'string' && event.text.trim()
          ? event.text.trim()
          : 'Worker turn completed.',
      });
      return;
    }
    if (event.source === 'run-error') {
      emitCloudRunRawEvent({
        type: 'session.failed',
        message: typeof event.text === 'string' && event.text.trim()
          ? event.text.trim()
          : 'QA Panda cloud-run failed.',
      });
    }
  };
}

function screenshotArtifactsFromEntry(entry, fallbackIndex) {
  const artifacts = [];
  if (!entry || typeof entry !== 'object') return artifacts;
  const addImage = (mimeType, data, index) => {
    if (typeof data !== 'string' || !data.trim()) return;
    const normalizedMime = typeof mimeType === 'string' && mimeType ? mimeType : 'image/png';
    const extension = normalizedMime.includes('jpeg') || normalizedMime.includes('jpg') ? 'jpg' : 'png';
    artifacts.push({
      filename: `screenshot-${String(index).padStart(3, '0')}.${extension}`,
      mimeType: normalizedMime,
      data,
    });
  };

  if (entry.result && Array.isArray(entry.result.content)) {
    for (const block of entry.result.content) {
      if (block && block.type === 'image' && block.data) {
        addImage(block.mimeType, block.data, fallbackIndex + artifacts.length);
      }
    }
  }
  if (entry.payload && entry.payload.type === 'chatScreenshot' && typeof entry.payload.data === 'string') {
    const match = entry.payload.data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      addImage(match[1], match[2], fallbackIndex + artifacts.length);
    }
  }
  return artifacts;
}

async function writeCloudRunArtifacts(manifest, spec) {
  const outputDir = path.resolve(spec.outputDir);
  const runFilesDir = path.join(outputDir, 'run-files');
  const screenshotsDir = path.join(outputDir, 'screenshots');
  await ensureDir(runFilesDir);
  await ensureDir(screenshotsDir);

  const copiedArtifacts = [];
  const copyTargets = [
    ['manifest.json', manifest.files && manifest.files.manifest],
    ['events.jsonl', manifest.files && manifest.files.events],
    ['transcript.jsonl', manifest.files && manifest.files.transcript],
    ['chat.jsonl', manifest.files && manifest.files.chatLog],
    ['progress.md', manifest.files && manifest.files.progress],
  ];

  for (const [filename, sourcePath] of copyTargets) {
    if (!sourcePath || !(await pathExists(sourcePath))) continue;
    await fsp.copyFile(sourcePath, path.join(runFilesDir, filename));
    copiedArtifacts.push({ artifactType: filename.endsWith('.md') || filename.endsWith('.jsonl') ? 'log' : 'evidence_bundle', filename: `run-files/${filename}` });
  }

  const transcriptRaw = manifest.files && manifest.files.transcript
    ? await readText(manifest.files.transcript, '')
    : '';
  const transcriptEntries = transcriptRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const screenshotArtifacts = [];
  let screenshotIndex = 1;
  for (const entry of transcriptEntries) {
    const entryArtifacts = screenshotArtifactsFromEntry(entry, screenshotIndex);
    screenshotIndex += entryArtifacts.length;
    screenshotArtifacts.push(...entryArtifacts);
  }
  for (const screenshot of screenshotArtifacts) {
    await fsp.writeFile(path.join(screenshotsDir, screenshot.filename), Buffer.from(screenshot.data, 'base64'));
    copiedArtifacts.push({ artifactType: 'screenshot', filename: `screenshots/${screenshot.filename}` });
  }

  const summary = {
    runId: manifest.runId,
    attemptId: spec.attemptId,
    repositoryId: spec.repositoryId,
    repositoryContextId: spec.repositoryContextId,
    title: spec.title,
    targetUrl: spec.targetUrl,
    targetType: spec.targetType,
    browserPreset: spec.browserPreset,
    aiProfile: spec.aiProfile,
    status: manifest.status,
    stopReason: manifest.stopReason || null,
    summary: manifest.transcriptSummary || null,
    generatedAt: nowIso(),
    runDir: manifest.runDir,
  };
  await writeJson(path.join(outputDir, 'run-report.json'), summary);
  copiedArtifacts.push({ artifactType: 'report_json', filename: 'run-report.json' });

  const eventLog = manifest.files && manifest.files.events ? await readText(manifest.files.events, '') : '';
  await writeText(path.join(outputDir, 'session.log'), eventLog);
  copiedArtifacts.push({ artifactType: 'log', filename: 'session.log' });

  await writeJson(path.join(outputDir, 'evidence-bundle.json'), {
    generatedAt: nowIso(),
    runId: manifest.runId,
    artifacts: copiedArtifacts,
  });
  copiedArtifacts.push({ artifactType: 'evidence_bundle', filename: 'evidence-bundle.json' });

  return copiedArtifacts;
}

module.exports = {
  CLOUD_RUN_ARG_SPEC,
  CLOUD_RUN_SPEC_VERSION,
  buildCloudRunOptions,
  createCloudRunEventBridge,
  emitCloudRunRawEvent,
  loadCloudRunSpec,
  validateCloudRunSpec,
  writeCloudRunArtifacts,
};
