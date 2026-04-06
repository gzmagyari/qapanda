const path = require('node:path');

const { loadWorkflowPreset } = require('../workflow-presets-store');
const {
  parseWorkflowDocument,
  resolveWorkflowByIdentity,
  resolveWorkflowByName,
  validateWorkflowLaunchInputValues,
} = require('../workflow-store');

const CLOUD_RUN_SPEC_VERSION = 'qapanda.cloud-run/v1';
const HOSTED_WORKFLOW_CONTEXT = Symbol.for('qapanda.cloud.hostedWorkflowContext');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  const text = String(value == null ? '' : value).trim();
  return text || null;
}

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = String(key || '').trim();
    if (!id) continue;
    normalized[id] = entry;
  }
  return normalized;
}

function normalizeSecretRefs(value) {
  const source = normalizeStringMap(value);
  const normalized = {};
  for (const [fieldId, secretId] of Object.entries(source)) {
    const normalizedSecretId = String(secretId || '').trim();
    if (!normalizedSecretId) continue;
    normalized[fieldId] = normalizedSecretId;
  }
  return normalized;
}

function secretFieldIdsForWorkflow(workflow) {
  const ids = new Set();
  for (const field of Array.isArray(workflow && workflow.inputs) ? workflow.inputs : []) {
    const fieldId = normalizeOptionalString(field && field.id);
    if (field && field.secret === true && fieldId) {
      ids.add(fieldId);
    }
  }
  return ids;
}

function buildHostedWorkflowRedactionRules(resolvedSecretValues = {}) {
  return Object.entries(
    resolvedSecretValues && typeof resolvedSecretValues === 'object' && !Array.isArray(resolvedSecretValues)
      ? resolvedSecretValues
      : {}
  )
    .map(([fieldId, rawValue]) => ({
      fieldId: normalizeOptionalString(fieldId),
      rawValue: typeof rawValue === 'string' ? rawValue : '',
    }))
    .filter((entry) => entry.fieldId && entry.rawValue)
    .sort((left, right) => right.rawValue.length - left.rawValue.length)
    .map((entry) => ({
      fieldId: entry.fieldId,
      rawValue: entry.rawValue,
      replacement: `[REDACTED_WORKFLOW_SECRET:${entry.fieldId}]`,
    }));
}

function redactStringWithRules(value, rules) {
  let output = String(value == null ? '' : value);
  for (const rule of rules) {
    output = output.split(rule.rawValue).join(rule.replacement);
  }
  return output;
}

function redactValueWithRules(value, rules) {
  if (!rules || rules.length === 0) return value;
  if (typeof value === 'string') {
    return redactStringWithRules(value, rules);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValueWithRules(entry, rules));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValueWithRules(entry, rules)])
    );
  }
  return value;
}

function resolvedSecretValuesFromTarget(target) {
  if (!target || typeof target !== 'object') return {};
  if (target.resolvedSecretValues && typeof target.resolvedSecretValues === 'object') {
    return target.resolvedSecretValues;
  }
  const context = getHostedWorkflowExecutionContext(target);
  if (context && context.resolvedSecretValues && typeof context.resolvedSecretValues === 'object') {
    return context.resolvedSecretValues;
  }
  return {};
}

function createHostedWorkflowRedactor(target) {
  const rules = buildHostedWorkflowRedactionRules(resolvedSecretValuesFromTarget(target));
  if (rules.length === 0) return null;
  return {
    rules,
    redactString(value) {
      return redactStringWithRules(value, rules);
    },
    redactValue(value) {
      return redactValueWithRules(value, rules);
    },
  };
}

function redactHostedWorkflowValue(target, value) {
  const redactor = createHostedWorkflowRedactor(target);
  return redactor ? redactor.redactValue(value) : value;
}

function sanitizeHostedWorkflowCloudRunSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const sanitized = cloneJson(spec);
  const secretFieldIds = secretFieldIdsForWorkflow(sanitized.workflowDefinition);
  if (sanitized.workflowInputs && typeof sanitized.workflowInputs === 'object' && !Array.isArray(sanitized.workflowInputs)) {
    const nextInputs = { ...sanitized.workflowInputs };
    for (const fieldId of secretFieldIds) {
      delete nextInputs[fieldId];
    }
    sanitized.workflowInputs = Object.keys(nextInputs).length > 0 ? nextInputs : null;
  }
  const normalizedSecretRefs = normalizeSecretRefs(sanitized.workflowSecretRefs);
  sanitized.workflowSecretRefs = Object.keys(normalizedSecretRefs).length > 0 ? normalizedSecretRefs : null;
  return sanitized;
}

function workflowDirectoryName(workflow) {
  return path.basename(workflow.dir || workflow.path || workflow.id || workflow.name || 'workflow');
}

function workflowRelativePath(repoRoot, workflow) {
  if (!repoRoot || !workflow || !workflow.path) return null;
  return path.relative(repoRoot, workflow.path).split(path.sep).join('/');
}

function buildWorkflowDefinitionBlock(workflow, repoRoot) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || '',
    preferredMode: workflow.preferredMode || 'continue',
    suggestedAgent: workflow.suggestedAgent || null,
    inputs: cloneJson(workflow.inputs || []),
    directoryName: workflowDirectoryName(workflow),
    relativePath: workflowRelativePath(repoRoot, workflow),
    body: workflow.body || '',
    content: workflow.raw || null,
  };
}

function workflowFromDefinitionBlock(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  if (typeof block.content === 'string' && block.content.trim()) {
    const parsed = parseWorkflowDocument(block.content);
    if (parsed) {
      return {
        id: normalizeOptionalString(block.id) || normalizeOptionalString(block.workflowId) || normalizeOptionalString(block.directoryName) || parsed.name,
        scope: 'project',
        name: parsed.name,
        description: parsed.description || '',
        preferredMode: parsed.preferredMode || 'continue',
        suggestedAgent: parsed.suggestedAgent || null,
        inputs: parsed.inputs || [],
        body: parsed.body || '',
        raw: parsed.raw || block.content,
        path: null,
        dir: normalizeOptionalString(block.directoryName) || null,
      };
    }
  }
  const name = normalizeOptionalString(block.name);
  if (!name) return null;
  return {
    id: normalizeOptionalString(block.id) || normalizeOptionalString(block.workflowId) || normalizeOptionalString(block.directoryName) || name,
    scope: 'project',
    name,
    description: normalizeOptionalString(block.description) || '',
    preferredMode: normalizeOptionalString(block.preferredMode) === 'orchestrate' ? 'orchestrate' : 'continue',
    suggestedAgent: normalizeOptionalString(block.suggestedAgent),
    inputs: Array.isArray(block.inputs) ? cloneJson(block.inputs) : [],
    body: normalizeOptionalString(block.body) || '',
    raw: typeof block.content === 'string' ? block.content : null,
    path: null,
    dir: normalizeOptionalString(block.directoryName) || null,
  };
}

function resolveProjectWorkflow(repoRoot, definition = {}) {
  let workflow = null;
  const workflowId = normalizeOptionalString(definition.id) || normalizeOptionalString(definition.workflowId);
  if (repoRoot && workflowId) {
    workflow = resolveWorkflowByIdentity(repoRoot, { scope: 'project', id: workflowId });
  }
  if (!workflow && repoRoot && normalizeOptionalString(definition.name)) {
    const byName = resolveWorkflowByName(repoRoot, definition.name);
    if (byName && byName.scope === 'project') {
      workflow = byName;
    }
  }
  return workflow || workflowFromDefinitionBlock(definition);
}

async function resolveHostedWorkflowSecrets(secretRefs, secretStore) {
  const normalizedRefs = normalizeSecretRefs(secretRefs);
  if (Object.keys(normalizedRefs).length === 0) {
    return { secretRefs: {}, resolvedSecretValues: {} };
  }
  if (!secretStore || typeof secretStore.isAvailable !== 'function' || !secretStore.isAvailable()) {
    throw new Error('Hosted workflow secret resolution is not available in this environment.');
  }
  const resolvedSecretValues = {};
  for (const [fieldId, secretId] of Object.entries(normalizedRefs)) {
    resolvedSecretValues[fieldId] = await secretStore.resolveSecret(secretId, { fieldId });
  }
  return {
    secretRefs: normalizedRefs,
    resolvedSecretValues,
  };
}

function formatHostedWorkflowInputs(workflow, plainInputs = {}, resolvedSecretValues = {}) {
  const merged = { ...plainInputs, ...resolvedSecretValues };
  if (!workflow || !Array.isArray(workflow.inputs) || workflow.inputs.length === 0) return null;
  const lines = [];
  for (const field of workflow.inputs) {
    if (!Object.prototype.hasOwnProperty.call(merged, field.id)) continue;
    const value = merged[field.id];
    lines.push(`- ${field.label} [${field.id}]: ${field.type === 'checkbox' ? (value ? 'true' : 'false') : String(value)}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function buildHostedWorkflowControllerSection(manifest) {
  const context = getHostedWorkflowExecutionContext(manifest);
  if (!context || !context.workflow) return null;
  const lines = [
    'Hosted workflow execution context (cloud-run):',
    `- Workflow: ${context.workflow.name}`,
    `- Description: ${context.workflow.description || 'No description provided.'}`,
    `- Preferred mode: ${context.workflow.preferredMode || 'continue'}`,
  ];
  if (context.workflow.suggestedAgent) {
    lines.push(`- Suggested agent: ${context.workflow.suggestedAgent}`);
  }
  if (context.profile && context.profile.name) {
    lines.push(`- Launch profile: ${context.profile.name}`);
  }
  if (context.targetUrl) {
    lines.push(`- Target URL: ${context.targetUrl}`);
  }
  if (context.targetType) {
    lines.push(`- Target type: ${context.targetType}`);
  }
  if (context.browserPreset) {
    lines.push(`- Browser preset: ${context.browserPreset}`);
  }
  if (context.launchInstruction) {
    lines.push('');
    lines.push(`Hosted run request:\n${context.launchInstruction}`);
  }
  const inputsBlock = formatHostedWorkflowInputs(context.workflow, context.plainInputs, context.resolvedSecretValues);
  if (inputsBlock) {
    lines.push('');
    lines.push(`Workflow Inputs:\n${inputsBlock}`);
  }
  lines.push('');
  lines.push('Workflow Instructions:');
  lines.push(context.workflow.body || 'No workflow body was provided.');
  lines.push('');
  lines.push('Treat the workflow instructions and workflow inputs above as high-priority execution guidance for this hosted run.');
  return lines.join('\n');
}

function setHostedWorkflowExecutionContext(manifest, context) {
  Object.defineProperty(manifest, HOSTED_WORKFLOW_CONTEXT, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: context,
  });
}

function getHostedWorkflowExecutionContext(manifest) {
  if (!manifest) return null;
  return manifest[HOSTED_WORKFLOW_CONTEXT] || null;
}

function visibleHostedWorkflowPrompt(workflow, prompt) {
  const instruction = normalizeOptionalString(prompt);
  if (instruction) return instruction;
  return `Run the hosted workflow "${workflow.name}".`;
}

function materializeHostedWorkflowRunSync(spec, options = {}) {
  const definition = spec && spec.workflowDefinition;
  if (!definition) return null;
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : null;
  const workflow = resolveProjectWorkflow(repoRoot, definition);
  if (!workflow) {
    throw new Error('Hosted workflow definition could not be resolved.');
  }
  if (workflow.scope && workflow.scope !== 'project') {
    throw new Error('Hosted workflow execution currently supports project workflows only.');
  }
  if ((workflow.preferredMode || 'continue') !== 'orchestrate') {
    throw new Error('Hosted workflow execution currently supports orchestrate workflows only.');
  }
  const workflowProfile = spec.workflowProfile && typeof spec.workflowProfile === 'object'
    ? {
        profileId: normalizeOptionalString(spec.workflowProfile.profileId) || normalizeOptionalString(spec.workflowProfile.id),
        name: normalizeOptionalString(spec.workflowProfile.name),
      }
    : null;
  const secretRefs = normalizeSecretRefs(spec.workflowSecretRefs);
  const plainInputs = validateWorkflowLaunchInputValues(workflow, spec.workflowInputs || {}, {
    secretRefs,
    allowPlainSecretValues: false,
  });
  return {
    workflow,
    profile: workflowProfile,
    plainInputs,
    secretRefs,
    launchInstruction: visibleHostedWorkflowPrompt(workflow, spec.prompt),
  };
}

async function materializeHostedWorkflowRun(spec, options = {}) {
  const syncContext = materializeHostedWorkflowRunSync(spec, options);
  if (!syncContext) return null;
  const resolvedSecrets = await resolveHostedWorkflowSecrets(syncContext.secretRefs, options.secretStore || null);
  return {
    ...syncContext,
    secretRefs: resolvedSecrets.secretRefs,
    resolvedSecretValues: resolvedSecrets.resolvedSecretValues,
  };
}

function buildHostedWorkflowCloudRunSpec(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const workflowId = normalizeOptionalString(options.workflowId);
  const workflowName = normalizeOptionalString(options.workflowName);
  let workflow = workflowId
    ? resolveWorkflowByIdentity(repoRoot, { scope: 'project', id: workflowId })
    : null;
  if (!workflow && workflowName) {
    const byName = resolveWorkflowByName(repoRoot, workflowName);
    if (byName && byName.scope === 'project') {
      workflow = byName;
    }
  }
  if (!workflow) {
    throw new Error('A project workflow id or name is required to build a hosted workflow run spec.');
  }
  if ((workflow.preferredMode || 'continue') !== 'orchestrate') {
    throw new Error('Hosted workflow execution currently supports orchestrate workflows only.');
  }

  const profile = normalizeOptionalString(options.profileId)
    ? loadWorkflowPreset(repoRoot, workflow, options.profileId)
    : null;
  if (options.profileId && !profile) {
    throw new Error(`Workflow profile "${options.profileId}" was not found for workflow "${workflow.name}".`);
  }

  const secretRefs = {
    ...(profile ? profile.secretRefs || {} : {}),
    ...normalizeSecretRefs(options.workflowSecretRefs || options.secretRefs || {}),
  };
  const plainInputValues = {
    ...(profile ? profile.values || {} : {}),
    ...normalizeStringMap(options.workflowInputs || options.inputValues || {}),
  };
  const validatedInputs = validateWorkflowLaunchInputValues(workflow, plainInputValues, {
    secretRefs,
    allowPlainSecretValues: false,
  });

  return sanitizeHostedWorkflowCloudRunSpec({
    version: CLOUD_RUN_SPEC_VERSION,
    runId: String(options.runId || ''),
    attemptId: String(options.attemptId || ''),
    repositoryId: String(options.repositoryId || ''),
    outputDir: String(options.outputDir || ''),
    repositoryContextId: normalizeOptionalString(options.repositoryContextId),
    title: normalizeOptionalString(options.title) || `Workflow: ${workflow.name}`,
    prompt: visibleHostedWorkflowPrompt(workflow, options.prompt),
    targetUrl: normalizeOptionalString(options.targetUrl),
    targetType: normalizeOptionalString(options.targetType),
    browserPreset: normalizeOptionalString(options.browserPreset),
    aiProfile: options.aiProfile || null,
    workflowDefinition: buildWorkflowDefinitionBlock(workflow, repoRoot),
    workflowProfile: profile ? { profileId: profile.id, name: profile.name } : null,
    workflowInputs: validatedInputs,
    workflowSecretRefs: Object.keys(secretRefs).length > 0 ? secretRefs : null,
  });
}

module.exports = {
  buildHostedWorkflowCloudRunSpec,
  buildHostedWorkflowControllerSection,
  createHostedWorkflowRedactor,
  getHostedWorkflowExecutionContext,
  materializeHostedWorkflowRun,
  materializeHostedWorkflowRunSync,
  redactHostedWorkflowValue,
  sanitizeHostedWorkflowCloudRunSpec,
  setHostedWorkflowExecutionContext,
};
