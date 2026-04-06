const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

const { slugify } = require('./utils');

const WORKFLOW_FILENAME = 'WORKFLOW.md';
const WORKFLOW_MODES = new Set(['continue', 'orchestrate']);
const WORKFLOW_INPUT_TYPES = ['text', 'textarea', 'select', 'checkbox', 'number', 'date'];
const WORKFLOW_INPUT_TYPE_SET = new Set(WORKFLOW_INPUT_TYPES);
const WORKFLOW_FIELD_ID_RE = /^[a-z][a-z0-9_-]*$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function qpandaRoot() {
  return path.join(os.homedir(), '.qpanda');
}

function projectWorkflowRoot(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'workflows');
}

function globalWorkflowRoot() {
  return path.join(qpandaRoot(), 'workflows');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeOptionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeWorkflowMode(value) {
  return value === 'orchestrate' ? 'orchestrate' : 'continue';
}

function normalizeSuggestedAgent(value) {
  return normalizeOptionalText(value);
}

function normalizeWorkflowFieldId(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeOptionalFiniteNumber(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function normalizeOptionalPositiveInteger(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : value;
}

function normalizeWorkflowFieldOption(option = {}) {
  const value = normalizeText(option.value);
  const label = normalizeText(option.label || option.value);
  return {
    value,
    label: label || value,
  };
}

function normalizeWorkflowFieldDefault(type, value) {
  if (value == null || value === '') return null;
  if (type === 'checkbox') return !!value;
  if (type === 'number') return normalizeOptionalFiniteNumber(value);
  return normalizeText(value);
}

function normalizeWorkflowField(field = {}) {
  const type = normalizeText(field.type).toLowerCase();
  const normalized = {
    id: normalizeWorkflowFieldId(field.id),
    label: normalizeText(field.label),
    type,
    secret: field.secret === true,
    description: normalizeOptionalText(field.description),
    required: field.required === true,
    placeholder: normalizeOptionalText(field.placeholder),
    default: normalizeWorkflowFieldDefault(type, field.default),
  };

  if (type === 'textarea') {
    normalized.rows = normalizeOptionalPositiveInteger(field.rows);
  }
  if (type === 'select') {
    normalized.options = Array.isArray(field.options)
      ? field.options.map((option) => normalizeWorkflowFieldOption(option))
      : [];
  }
  if (type === 'number') {
    normalized.min = normalizeOptionalFiniteNumber(field.min);
    normalized.max = normalizeOptionalFiniteNumber(field.max);
    normalized.step = normalizeOptionalFiniteNumber(field.step);
  }

  return normalized;
}

function serializeWorkflowField(field = {}) {
  const normalized = normalizeWorkflowField(field);
  const serialized = {
    id: normalized.id,
    label: normalized.label,
    type: normalized.type,
  };

  if (normalized.secret) serialized.secret = true;
  if (normalized.description) serialized.description = normalized.description;
  if (normalized.required) serialized.required = true;
  if (normalized.placeholder) serialized.placeholder = normalized.placeholder;
  if (normalized.default !== null) serialized.default = normalized.default;
  if (normalized.type === 'textarea' && typeof normalized.rows === 'number') serialized.rows = normalized.rows;
  if (normalized.type === 'select') serialized.options = normalized.options || [];
  if (normalized.type === 'number') {
    if (typeof normalized.min === 'number') serialized.min = normalized.min;
    if (typeof normalized.max === 'number') serialized.max = normalized.max;
    if (typeof normalized.step === 'number') serialized.step = normalized.step;
  }

  return serialized;
}

function normalizeWorkflowInput(data = {}) {
  return {
    name: normalizeText(data.name),
    description: normalizeText(data.description),
    preferredMode: normalizeWorkflowMode(data.preferredMode || data.preferred_mode),
    suggestedAgent: normalizeSuggestedAgent(data.suggestedAgent || data.suggested_agent),
    body: normalizeText(data.body),
    inputs: Array.isArray(data.inputs) ? data.inputs.map((field) => normalizeWorkflowField(field)) : [],
  };
}

function parseWorkflowDocument(content) {
  const raw = String(content || '');
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const body = frontmatterMatch ? raw.slice(frontmatterMatch[0].length) : raw;
  let meta = {};
  if (frontmatterMatch) {
    try {
      const parsed = YAML.parse(frontmatterMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed;
      }
    } catch {
      return null;
    }
  }

  const normalized = normalizeWorkflowInput({
    ...meta,
    body: body.trim(),
  });
  if (!normalized.name) return null;

  return {
    name: normalized.name,
    description: normalized.description,
    preferredMode: normalized.preferredMode,
    suggestedAgent: normalized.suggestedAgent,
    inputs: normalized.inputs,
    body: normalized.body,
    raw,
  };
}

function buildWorkflowDocument(data) {
  const normalized = normalizeWorkflowInput(data);
  const frontmatter = {
    name: normalized.name,
    description: normalized.description,
    preferred_mode: normalized.preferredMode,
  };
  if (normalized.suggestedAgent) {
    frontmatter.suggested_agent = normalized.suggestedAgent;
  }
  if (normalized.inputs.length > 0) {
    frontmatter.inputs = normalized.inputs.map((field) => serializeWorkflowField(field));
  }
  const yamlBlock = YAML.stringify(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlBlock}\n---\n\n${normalized.body.trim()}\n`;
}

function validateWorkflowField(field, index, seenIds) {
  const errors = [];
  const name = field.label || `Field ${index + 1}`;

  if (!field.id) {
    errors.push(`${name}: id is required.`);
  } else if (!WORKFLOW_FIELD_ID_RE.test(field.id)) {
    errors.push(`${name}: id must start with a letter and use only lowercase letters, numbers, underscores, or hyphens.`);
  } else if (seenIds.has(field.id)) {
    errors.push(`${name}: duplicate field id "${field.id}".`);
  }
  seenIds.add(field.id);

  if (!field.label) {
    errors.push(`${field.id || name}: label is required.`);
  }

  if (!WORKFLOW_INPUT_TYPE_SET.has(field.type)) {
    errors.push(`${name}: unsupported type "${field.type}".`);
  }

  if (field.secret && field.type !== 'text') {
    errors.push(`${name}: secret fields are only supported for text inputs.`);
  }

  if (field.type === 'select') {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      errors.push(`${name}: select fields require at least one option.`);
    } else {
      const optionIds = new Set();
      for (const option of field.options) {
        if (!option.value) {
          errors.push(`${name}: select option values are required.`);
          continue;
        }
        if (optionIds.has(option.value)) {
          errors.push(`${name}: duplicate select option "${option.value}".`);
        }
        optionIds.add(option.value);
      }
      if (field.default != null && !optionIds.has(field.default)) {
        errors.push(`${name}: default must match one of the defined options.`);
      }
    }
  }

  if (field.type === 'number') {
    if (field.default != null && !Number.isFinite(field.default)) {
      errors.push(`${name}: default must be a valid number.`);
    }
    if (field.min != null && !Number.isFinite(field.min)) {
      errors.push(`${name}: min must be a valid number.`);
    }
    if (field.max != null && !Number.isFinite(field.max)) {
      errors.push(`${name}: max must be a valid number.`);
    }
    if (field.step != null && !Number.isFinite(field.step)) {
      errors.push(`${name}: step must be a valid number.`);
    }
  }

  if (field.type === 'date' && field.default != null && !ISO_DATE_RE.test(field.default)) {
    errors.push(`${name}: default dates must use YYYY-MM-DD.`);
  }

  return errors;
}

function validateWorkflowDefinition(data = {}) {
  const normalized = normalizeWorkflowInput(data);
  const errors = [];

  if (!normalized.name) errors.push('Workflow name is required.');
  if (!normalized.description) errors.push('Workflow description is required.');
  if (!normalized.body) errors.push('Workflow body is required.');
  if (!WORKFLOW_MODES.has(normalized.preferredMode)) {
    errors.push(`Workflow preferred mode must be one of: ${Array.from(WORKFLOW_MODES).join(', ')}.`);
  }

  const seenIds = new Set();
  normalized.inputs.forEach((field, index) => {
    errors.push(...validateWorkflowField(field, index, seenIds));
  });

  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    throw error;
  }

  return normalized;
}

function workflowEntryFromFile(scope, id, workflowFile) {
  try {
    const content = fs.readFileSync(workflowFile, 'utf8');
    const parsed = parseWorkflowDocument(content);
    if (!parsed) return null;
    return {
      id,
      scope,
      name: parsed.name,
      description: parsed.description,
      preferredMode: parsed.preferredMode,
      suggestedAgent: parsed.suggestedAgent,
      inputs: parsed.inputs,
      body: parsed.body,
      raw: parsed.raw,
      path: workflowFile,
      dir: path.dirname(workflowFile),
      removed: false,
      hasUserOverride: false,
    };
  } catch {
    return null;
  }
}

function scanWorkflowDir(scope, baseDir) {
  const results = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workflowFile = path.join(baseDir, entry.name, WORKFLOW_FILENAME);
      const workflow = workflowEntryFromFile(scope, entry.name, workflowFile);
      if (workflow) {
        results.push(workflow);
      }
    }
  } catch {}
  return results.sort((left, right) => {
    const a = `${left.name || ''}\u0000${left.id || ''}`.toLowerCase();
    const b = `${right.name || ''}\u0000${right.id || ''}`.toLowerCase();
    return a.localeCompare(b);
  });
}

function listProjectWorkflows(repoRoot) {
  return scanWorkflowDir('project', projectWorkflowRoot(repoRoot));
}

function listGlobalWorkflows() {
  return scanWorkflowDir('global', globalWorkflowRoot());
}

function loadWorkflows(repoRoot) {
  const seen = new Set();
  const all = [];
  for (const workflow of listProjectWorkflows(repoRoot)) {
    seen.add(workflow.name);
    all.push(workflow);
  }
  for (const workflow of listGlobalWorkflows()) {
    if (seen.has(workflow.name)) continue;
    seen.add(workflow.name);
    all.push(workflow);
  }
  return all;
}

function resolveWorkflowByName(repoRoot, name) {
  const target = normalizeText(name);
  if (!target) return null;
  return loadWorkflows(repoRoot).find((workflow) => workflow.name === target) || null;
}

function resolveWorkflowByIdentity(repoRoot, identity) {
  if (!identity || !identity.scope || !identity.id) return null;
  if (identity.scope === 'project') {
    return workflowEntryFromFile(
      'project',
      identity.id,
      path.join(projectWorkflowRoot(repoRoot), identity.id, WORKFLOW_FILENAME),
    );
  }
  if (identity.scope === 'global') {
    return workflowEntryFromFile(
      'global',
      identity.id,
      path.join(globalWorkflowRoot(), identity.id, WORKFLOW_FILENAME),
    );
  }
  return null;
}

function validateWorkflowLaunchInputValues(workflow, rawValues = {}, options = {}) {
  const fields = Array.isArray(workflow && workflow.inputs) ? workflow.inputs : [];
  const source = (rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)) ? rawValues : {};
  const secretRefs = options && options.secretRefs && typeof options.secretRefs === 'object' && !Array.isArray(options.secretRefs)
    ? options.secretRefs
    : {};
  const allowPlainSecretValues = !options || options.allowPlainSecretValues !== false;
  const errors = [];
  const values = {};

  for (const field of fields) {
    const hasExplicitValue = Object.prototype.hasOwnProperty.call(source, field.id);
    const rawValue = hasExplicitValue ? source[field.id] : field.default;
    let normalizedValue = null;
    const hasSecretRef = field.secret === true && !!String(secretRefs[field.id] || '').trim();

    if (field.secret === true && !allowPlainSecretValues) {
      const hasPlainSecretValue = rawValue !== '' && rawValue != null;
      if (hasPlainSecretValue) {
        errors.push(`${field.label}: hosted workflow secret fields must be provided via workflowSecretRefs.`);
      }
      if (field.required && !hasSecretRef) {
        errors.push(`${field.label}: this field is required.`);
      }
      continue;
    }

    if (field.type === 'checkbox') {
      normalizedValue = rawValue == null ? false : !!rawValue;
      if (field.required && normalizedValue !== true) {
        errors.push(`${field.label}: this checkbox must be checked.`);
      }
      values[field.id] = normalizedValue;
      continue;
    }

    if (rawValue === '' || rawValue == null) {
      normalizedValue = null;
    } else if (field.type === 'number') {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) {
        errors.push(`${field.label}: enter a valid number.`);
        continue;
      }
      if (typeof field.min === 'number' && parsed < field.min) {
        errors.push(`${field.label}: must be at least ${field.min}.`);
      }
      if (typeof field.max === 'number' && parsed > field.max) {
        errors.push(`${field.label}: must be at most ${field.max}.`);
      }
      normalizedValue = parsed;
    } else {
      normalizedValue = normalizeText(rawValue);
    }

    if (field.type === 'date' && normalizedValue != null && !ISO_DATE_RE.test(normalizedValue)) {
      errors.push(`${field.label}: dates must use YYYY-MM-DD.`);
    }

    if (field.type === 'select' && normalizedValue != null && !field.options.some((option) => option.value === normalizedValue)) {
      errors.push(`${field.label}: choose one of the defined options.`);
    }

    const isMissing = normalizedValue == null || normalizedValue === '';
    if (field.required && isMissing && !hasSecretRef) {
      errors.push(`${field.label}: this field is required.`);
    }

    if (!isMissing) {
      values[field.id] = normalizedValue;
    }
  }

  if (errors.length > 0) {
    const error = new Error(errors.join(' '));
    error.validationErrors = errors;
    throw error;
  }

  return values;
}

function allocateWorkflowId(repoRoot, scope, name) {
  const root = scope === 'global' ? globalWorkflowRoot() : projectWorkflowRoot(repoRoot);
  const baseSlug = slugify(name || 'workflow', 48) || 'workflow';
  let next = baseSlug;
  let suffix = 2;
  while (fs.existsSync(path.join(root, next))) {
    next = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  return next;
}

function saveWorkflow(repoRoot, data = {}) {
  const normalized = validateWorkflowDefinition(data);
  const scope = data.scope === 'global' ? 'global' : 'project';
  const workflowRoot = scope === 'global' ? globalWorkflowRoot() : projectWorkflowRoot(repoRoot);
  ensureDir(workflowRoot);
  const id = normalizeText(data.id) || allocateWorkflowId(repoRoot, scope, normalized.name);

  const existing = (scope === 'global' ? listGlobalWorkflows() : listProjectWorkflows(repoRoot))
    .find((workflow) => workflow.id !== id && workflow.name === normalized.name);
  if (existing) {
    throw new Error(`A workflow named "${normalized.name}" already exists in ${scope} scope.`);
  }

  const workflowDir = path.join(workflowRoot, id);
  ensureDir(workflowDir);
  fs.writeFileSync(path.join(workflowDir, WORKFLOW_FILENAME), buildWorkflowDocument(normalized), 'utf8');
  return resolveWorkflowByIdentity(repoRoot, { scope, id });
}

module.exports = {
  ISO_DATE_RE,
  WORKFLOW_FILENAME,
  WORKFLOW_INPUT_TYPES,
  WORKFLOW_MODES,
  allocateWorkflowId,
  buildWorkflowDocument,
  globalWorkflowRoot,
  listGlobalWorkflows,
  listProjectWorkflows,
  loadWorkflows,
  normalizeWorkflowInput,
  parseWorkflowDocument,
  projectWorkflowRoot,
  resolveWorkflowByIdentity,
  resolveWorkflowByName,
  saveWorkflow,
  serializeWorkflowField,
  validateWorkflowDefinition,
  validateWorkflowLaunchInputValues,
  workflowEntryFromFile,
};
