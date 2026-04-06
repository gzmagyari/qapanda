const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { replaceWorkflowPresets, saveWorkflowPreset, workflowPresetsPath, listWorkflowPresets, deleteWorkflowPreset } = require('../../src/workflow-presets-store');

function makeRepoRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-workflow-presets-'));
}

function makeWorkflow() {
  return {
    scope: 'project',
    id: 'deep-login',
    name: 'Deep Login',
    inputs: [
      { id: 'environment_url', label: 'Environment URL', type: 'text' },
      { id: 'login_password', label: 'Password', type: 'text', secret: true },
      { id: 'verify_sessions', label: 'Verify Sessions', type: 'checkbox' },
    ],
  };
}

test('workflow preset files persist secret refs instead of raw secret values', () => {
  const repoRoot = makeRepoRoot();
  const workflow = makeWorkflow();

  const saved = saveWorkflowPreset(repoRoot, workflow, {
    name: 'staging-login-deep',
    values: {
      environment_url: 'https://staging.example.test/login',
      verify_sessions: true,
    },
    secretRefs: {
      login_password: 'secret-login-password',
    },
  });

  const filePath = workflowPresetsPath(repoRoot, workflow);
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.match(raw, /secret-login-password/);
  assert.ok(!raw.includes('super-secret-password'));

  const reloaded = listWorkflowPresets(repoRoot, workflow);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].id, saved.id);
  assert.equal(reloaded[0].secretRefs.login_password, 'secret-login-password');
  assert.equal(reloaded[0].values.environment_url, 'https://staging.example.test/login');
  assert.equal(reloaded[0].values.verify_sessions, true);
  assert.ok(reloaded[0].updatedAt);
});

test('replacing and deleting workflow presets round-trips profile metadata', () => {
  const repoRoot = makeRepoRoot();
  const workflow = makeWorkflow();

  replaceWorkflowPresets(repoRoot, workflow, [
    {
      id: 'profile-a',
      name: 'Profile A',
      updatedAt: '2026-04-06T10:00:00.000Z',
      values: { environment_url: 'https://a.test' },
      secretRefs: { login_password: 'secret-a' },
    },
    {
      id: 'profile-b',
      name: 'Profile B',
      updatedAt: '2026-04-06T11:00:00.000Z',
      values: { environment_url: 'https://b.test', verify_sessions: false },
      secretRefs: {},
    },
  ]);

  const beforeDelete = listWorkflowPresets(repoRoot, workflow);
  assert.equal(beforeDelete.length, 2);
  assert.equal(beforeDelete[0].updatedAt, '2026-04-06T10:00:00.000Z');

  deleteWorkflowPreset(repoRoot, workflow, 'profile-a');
  const afterDelete = listWorkflowPresets(repoRoot, workflow);
  assert.equal(afterDelete.length, 1);
  assert.equal(afterDelete[0].id, 'profile-b');
});
