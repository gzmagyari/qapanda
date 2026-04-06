const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWorkflowDocument,
  parseWorkflowDocument,
  validateWorkflowDefinition,
  validateWorkflowLaunchInputValues,
} = require('../../src/workflow-store');

test('workflow documents round-trip structured inputs including secret text fields', () => {
  const document = buildWorkflowDocument({
    name: 'Deep Login Test',
    description: 'Exercise the login page deeply.',
    preferredMode: 'orchestrate',
    suggestedAgent: 'QA-Browser',
    inputs: [
      {
        id: 'environment_url',
        label: 'Environment URL',
        type: 'text',
        required: true,
        default: 'https://example.test/login',
      },
      {
        id: 'login_password',
        label: 'Login Password',
        type: 'text',
        secret: true,
        required: true,
      },
      {
        id: 'depth',
        label: 'Depth',
        type: 'select',
        required: true,
        options: [
          { value: 'quick', label: 'Quick' },
          { value: 'deep', label: 'Deep' },
        ],
        default: 'deep',
      },
    ],
    body: '# Goal\n\nTest the login page thoroughly.\n',
  });

  const parsed = parseWorkflowDocument(document);
  assert.ok(parsed);
  assert.equal(parsed.name, 'Deep Login Test');
  assert.equal(parsed.preferredMode, 'orchestrate');
  assert.equal(parsed.suggestedAgent, 'QA-Browser');
  assert.equal(parsed.inputs.length, 3);
  assert.equal(parsed.inputs[1].secret, true);
  assert.equal(parsed.inputs[2].options[1].value, 'deep');
});

test('workflow validation rejects secret flags on non-text inputs', () => {
  assert.throws(() => validateWorkflowDefinition({
    name: 'Bad Workflow',
    description: 'Should fail.',
    preferredMode: 'continue',
    body: 'Body',
    inputs: [
      {
        id: 'should_fail',
        label: 'Should Fail',
        type: 'textarea',
        secret: true,
      },
    ],
  }), /secret fields are only supported for text inputs/i);
});

test('launch input validation accepts secret refs without raw values', () => {
  const workflow = validateWorkflowDefinition({
    name: 'Hosted Deep Test',
    description: 'Hosted workflow.',
    preferredMode: 'orchestrate',
    body: 'Run it.',
    inputs: [
      { id: 'target', label: 'Target', type: 'text', required: true },
      { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
      { id: 'attempts', label: 'Attempts', type: 'number', min: 1, max: 5 },
    ],
  });

  const values = validateWorkflowLaunchInputValues(workflow, {
    target: 'login page',
    attempts: 3,
  }, {
    secretRefs: {
      login_password: 'secret-123',
    },
  });

  assert.deepEqual(values, {
    target: 'login page',
    attempts: 3,
  });
});

test('hosted launch input validation rejects plaintext secret fields', () => {
  const workflow = validateWorkflowDefinition({
    name: 'Hosted Deep Test',
    description: 'Hosted workflow.',
    preferredMode: 'orchestrate',
    body: 'Run it.',
    inputs: [
      { id: 'target', label: 'Target', type: 'text', required: true },
      { id: 'login_password', label: 'Password', type: 'text', secret: true, required: true },
    ],
  });

  assert.throws(() => validateWorkflowLaunchInputValues(workflow, {
    target: 'login page',
    login_password: 'plaintext-secret',
  }, {
    allowPlainSecretValues: false,
  }), /workflowSecretRefs/i);
});
