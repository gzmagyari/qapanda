const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCloudBoundary } = require('../../src/cloud');
const { saveWorkflowPreset, workflowPresetsPath, listWorkflowPresets } = require('../../src/workflow-presets-store');
const { projectWorkflowsDir } = require('../../src/cloud/sync-adapters');

function makeRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-cloud-workflow-sync-'));
}

function writeWorkflow(repoRoot, dirName, content) {
  const filePath = path.join(projectWorkflowsDir(repoRoot), dirName, 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

async function createAdapters(repoRoot) {
  const boundary = createCloudBoundary({ target: 'cli', repoRoot, env: {} });
  return boundary.createRepositorySyncAdapters({
    identityOptions: {
      git: {
        localPath: repoRoot,
        remoteUrl: 'https://github.com/QA-Panda/cc-manager.git',
        branchName: 'cloud',
      },
    },
  });
}

test('project workflows sync as structured recipes and workflow profiles', async () => {
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
  const workflow = {
    scope: 'project',
    id: 'deep-login',
    name: 'Deep Login',
    inputs: [
      { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
      { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
    ],
  };
  saveWorkflowPreset(repoRoot, workflow, {
    name: 'staging-login',
    values: { environment_url: 'https://staging.example.test/login' },
    secretRefs: { login_password: 'secret-login-password' },
  });

  const adapters = await createAdapters(repoRoot);
  try {
    adapters.importAllLocal();
    const pending = adapters.store.listPendingMutations();
    const recipeMutation = pending.find((entry) => entry.objectType === 'recipe');
    const profileMutation = pending.find((entry) => entry.objectType === 'workflow_profile');
    assert.ok(recipeMutation);
    assert.ok(profileMutation);
    assert.equal(recipeMutation.payload.preferredMode, 'orchestrate');
    assert.equal(recipeMutation.payload.suggestedAgent, 'QA-Browser');
    assert.equal(recipeMutation.payload.inputs[1].secret, true);
    assert.equal(profileMutation.payload.workflowId, 'deep-login');
    assert.deepEqual(profileMutation.payload.values.login_password, {
      kind: 'secret-ref',
      secretId: 'secret-login-password',
    });
  } finally {
    adapters.close();
  }
});

test('remote recipe and workflow_profile entries hydrate back into local workflow files and presets', async () => {
  const repoRoot = makeRepoRoot();
  const adapters = await createAdapters(repoRoot);
  try {
    adapters.applyRemoteEntries([
      {
        sequenceNo: 50,
        objectType: 'recipe',
        objectId: 'deep-login',
        action: 'upsert',
        createdAt: '2026-04-06T10:00:00.000Z',
        payload: {
          id: 'deep-login',
          title: 'Deep Login',
          name: 'Deep Login',
          description: 'Hosted login workflow',
          preferredMode: 'orchestrate',
          suggestedAgent: 'QA-Browser',
          directoryName: 'deep-login',
          body: '# Goal\n\nTest the login page deeply.\n',
          inputs: [
            { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
            { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
          ],
        },
      },
      {
        sequenceNo: 51,
        objectType: 'workflow_profile',
        objectId: 'deep-login:staging-login',
        action: 'upsert',
        createdAt: '2026-04-06T10:01:00.000Z',
        payload: {
          id: 'deep-login:staging-login',
          workflowId: 'deep-login',
          profileId: 'staging-login',
          name: 'Staging Login',
          updatedAt: '2026-04-06T10:01:00.000Z',
          values: {
            environment_url: { kind: 'plain', value: 'https://staging.example.test/login' },
            login_password: { kind: 'secret-ref', secretId: 'secret-login-password' },
          },
        },
      },
    ]);

    const workflowPath = path.join(projectWorkflowsDir(repoRoot), 'deep-login', 'WORKFLOW.md');
    assert.ok(fs.existsSync(workflowPath));
    const workflowRaw = fs.readFileSync(workflowPath, 'utf8');
    assert.match(workflowRaw, /preferred_mode: orchestrate/);
    assert.match(workflowRaw, /suggested_agent: QA-Browser/);
    assert.match(workflowRaw, /secret: true/);

    const workflow = {
      scope: 'project',
      id: 'deep-login',
      name: 'Deep Login',
      inputs: [
        { id: 'environment_url', label: 'Environment URL', type: 'text', required: true },
        { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
      ],
    };
    const presets = listWorkflowPresets(repoRoot, workflow);
    assert.equal(presets.length, 1);
    assert.equal(presets[0].id, 'staging-login');
    assert.equal(presets[0].secretRefs.login_password, 'secret-login-password');

    const presetRaw = fs.readFileSync(workflowPresetsPath(repoRoot, workflow), 'utf8');
    assert.match(presetRaw, /secret-login-password/);
  } finally {
    adapters.close();
  }
});
