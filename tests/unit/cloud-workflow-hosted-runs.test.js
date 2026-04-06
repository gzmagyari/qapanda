const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUnavailableWorkflowSecretStore } = require('../../src/cloud/workflow-secrets');
const {
  buildHostedWorkflowCloudRunSpec,
  buildHostedWorkflowControllerSection,
  materializeHostedWorkflowRun,
  redactHostedWorkflowValue,
  setHostedWorkflowExecutionContext,
} = require('../../src/cloud/workflow-hosted-runs');
const { saveManifest } = require('../../src/state');
const { appendTranscriptRecord } = require('../../src/transcript');
const { projectWorkflowRoot } = require('../../src/workflow-store');
const { saveWorkflowPreset } = require('../../src/workflow-presets-store');

function makeRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-hosted-workflow-'));
}

function writeWorkflow(repoRoot, dirName, content) {
  const filePath = path.join(projectWorkflowRoot(repoRoot), dirName, 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('buildHostedWorkflowCloudRunSpec compiles local project workflow profiles into workflow-aware cloud-run specs', () => {
  const repoRoot = makeRepoRoot();
  writeWorkflow(repoRoot, 'deep-login', `---
name: Deep Login
description: Hosted login workflow
preferred_mode: orchestrate
suggested_agent: QA-Browser
inputs:
  - id: environment_url
    label: Environment URL
    type: text
    required: true
  - id: login_password
    label: Password
    type: text
    secret: true
    required: true
---

# Goal

Test the login page deeply.
`);
  saveWorkflowPreset(repoRoot, {
    scope: 'project',
    id: 'deep-login',
    name: 'Deep Login',
    inputs: [
      { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
      { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
    ],
  }, {
    name: 'staging-login',
    values: {
      environment_url: 'https://staging.example.test/login',
    },
    secretRefs: {
      login_password: 'secret-login-password',
    },
  });

  const spec = buildHostedWorkflowCloudRunSpec({
    repoRoot,
    runId: 'run_123',
    attemptId: 'attempt_123',
    repositoryId: 'repo_123',
    outputDir: path.join(repoRoot, 'output'),
    workflowId: 'deep-login',
    profileId: 'staging-login',
  });

  assert.equal(spec.workflowDefinition.id, 'deep-login');
  assert.equal(spec.workflowDefinition.preferredMode, 'orchestrate');
  assert.equal(spec.workflowProfile.profileId, 'staging-login');
  assert.equal(spec.workflowInputs.environment_url, 'https://staging.example.test/login');
  assert.equal(spec.workflowSecretRefs.login_password, 'secret-login-password');
});

test('materializeHostedWorkflowRun resolves secret refs and builds controller guidance without leaking raw refs', async () => {
  const repoRoot = makeRepoRoot();
  writeWorkflow(repoRoot, 'deep-login', `---
name: Deep Login
description: Hosted login workflow
preferred_mode: orchestrate
suggested_agent: QA-Browser
inputs:
  - id: environment_url
    label: Environment URL
    type: text
    required: true
  - id: login_password
    label: Password
    type: text
    secret: true
    required: true
---

# Goal

Test the login page deeply.
`);

  const context = await materializeHostedWorkflowRun({
    prompt: 'Run the hosted workflow "Deep Login".',
    workflowDefinition: {
      id: 'deep-login',
      name: 'Deep Login',
    },
    workflowInputs: {
      environment_url: 'https://staging.example.test/login',
    },
    workflowSecretRefs: {
      login_password: 'secret-login-password',
    },
  }, {
    repoRoot,
    secretStore: {
      isAvailable() {
        return true;
      },
      async resolveSecret(secretId) {
        assert.equal(secretId, 'secret-login-password');
        return 'super-secret-password';
      },
    },
  });

  const manifest = {};
  setHostedWorkflowExecutionContext(manifest, context);
  const section = buildHostedWorkflowControllerSection(manifest);

  assert.match(section, /Deep Login/);
  assert.match(section, /Environment URL \[environment_url\]: https:\/\/staging\.example\.test\/login/);
  assert.match(section, /Password \[login_password\]: super-secret-password/);
  assert.ok(!section.includes('secret-login-password'));
});

test('materializeHostedWorkflowRun fails clearly when secret refs are present but no secret capability exists', async () => {
  const repoRoot = makeRepoRoot();
  writeWorkflow(repoRoot, 'deep-login', `---
name: Deep Login
description: Hosted login workflow
preferred_mode: orchestrate
inputs:
  - id: login_password
    label: Password
    type: text
    secret: true
    required: true
---

Body
`);

  await assert.rejects(() => materializeHostedWorkflowRun({
    prompt: 'Run it.',
    workflowDefinition: {
      id: 'deep-login',
      name: 'Deep Login',
    },
    workflowSecretRefs: {
      login_password: 'secret-login-password',
    },
  }, {
    repoRoot,
    secretStore: createUnavailableWorkflowSecretStore(),
  }), /secret resolution is not available/i);
});

test('buildHostedWorkflowCloudRunSpec rejects plaintext hosted secret inputs', () => {
  const repoRoot = makeRepoRoot();
  writeWorkflow(repoRoot, 'deep-login', `---
name: Deep Login
description: Hosted login workflow
preferred_mode: orchestrate
inputs:
  - id: environment_url
    label: Environment URL
    type: text
    required: true
  - id: login_password
    label: Password
    type: text
    secret: true
    required: true
---

Body
`);

  assert.throws(() => buildHostedWorkflowCloudRunSpec({
    repoRoot,
    runId: 'run_123',
    attemptId: 'attempt_123',
    repositoryId: 'repo_123',
    outputDir: path.join(repoRoot, 'output'),
    workflowId: 'deep-login',
    workflowInputs: {
      environment_url: 'https://staging.example.test/login',
      login_password: 'plaintext-secret',
    },
  }), /workflowSecretRefs/i);
});

test('saveManifest redacts hosted workflow secrets and strips them from persisted cloudRunSpec', async () => {
  const repoRoot = makeRepoRoot();
  const runDir = path.join(repoRoot, '.qpanda', 'runs', 'run_123');
  const files = {
    manifest: path.join(runDir, 'manifest.json'),
  };
  fs.mkdirSync(runDir, { recursive: true });

  const manifest = {
    runId: 'run_123',
    runDir,
    files,
    worker: {},
    controller: {},
    apiConfig: null,
    transcriptSummary: 'Password is super-secret-password',
    cloudRunSpec: {
      workflowDefinition: {
        name: 'Deep Login',
        inputs: [
          { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
          { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
        ],
      },
      workflowInputs: {
        environment_url: 'https://staging.example.test/login',
        login_password: 'super-secret-password',
      },
      workflowSecretRefs: {
        login_password: 'secret-login-password',
      },
    },
  };
  setHostedWorkflowExecutionContext(manifest, {
    resolvedSecretValues: {
      login_password: 'super-secret-password',
    },
  });

  await saveManifest(manifest);
  const persisted = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));

  assert.equal(persisted.cloudRunSpec.workflowInputs.login_password, undefined);
  assert.match(persisted.transcriptSummary, /\[REDACTED_WORKFLOW_SECRET:login_password\]/);
  assert.doesNotMatch(JSON.stringify(persisted), /super-secret-password/);
});

test('appendTranscriptRecord redacts hosted workflow secrets before writing transcript files', async () => {
  const repoRoot = makeRepoRoot();
  const transcriptPath = path.join(repoRoot, '.qpanda', 'runs', 'run_123', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });

  const manifest = {
    files: {
      transcript: transcriptPath,
    },
  };
  setHostedWorkflowExecutionContext(manifest, {
    resolvedSecretValues: {
      login_password: 'super-secret-password',
    },
  });

  await appendTranscriptRecord(manifest, {
    kind: 'assistant_message',
    text: 'Use super-secret-password to sign in.',
    payload: {
      role: 'assistant',
      content: 'Use super-secret-password to sign in.',
    },
  });

  const raw = fs.readFileSync(transcriptPath, 'utf8');
  assert.match(raw, /\[REDACTED_WORKFLOW_SECRET:login_password\]/);
  assert.doesNotMatch(raw, /super-secret-password/);
});

test('redactHostedWorkflowValue replaces longer secrets first', () => {
  const redacted = redactHostedWorkflowValue({
    resolvedSecretValues: {
      token_prefix: 'abc',
      full_token: 'abc123',
    },
  }, 'Secret abc123 should redact fully before abc.');

  assert.match(redacted, /\[REDACTED_WORKFLOW_SECRET:full_token\]/);
  assert.match(redacted, /\[REDACTED_WORKFLOW_SECRET:token_prefix\]/);
  assert.doesNotMatch(redacted, /abc123/);
});
