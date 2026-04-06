const fs = require('node:fs');
const path = require('node:path');

const { nowIso, slugify } = require('./utils');
const { projectWorkflowRoot } = require('./workflow-store');

const WORKFLOW_PRESETS_FILENAME = 'presets.json';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizePresetName(value) {
  return String(value == null ? '' : value).trim();
}

function normalizePresetEnvelope(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (entry.kind === 'secret-ref') {
    const secretId = String(entry.secretId || entry.key || '').trim();
    return secretId ? { kind: 'secret-ref', secretId } : null;
  }
  if (entry.kind === 'plain') {
    return { kind: 'plain', value: entry.value };
  }
  return null;
}

function materializeWorkflowPreset(workflow, preset) {
  const validFieldIds = new Set(((workflow && workflow.inputs) || []).map((field) => field.id));
  const values = {};
  const secretRefs = {};
  for (const [fieldId, envelope] of Object.entries((preset && preset.values) || {})) {
    if (!validFieldIds.has(fieldId)) continue;
    const normalized = normalizePresetEnvelope(envelope);
    if (!normalized) continue;
    if (normalized.kind === 'secret-ref') {
      secretRefs[fieldId] = normalized.secretId;
    } else {
      values[fieldId] = normalized.value;
    }
  }
  return {
    id: preset.id,
    name: preset.name,
    updatedAt: preset.updatedAt ? String(preset.updatedAt) : null,
    values,
    secretRefs,
  };
}

function compactWorkflowPresetValues(workflow, values = {}, secretRefs = {}) {
  const envelopes = {};
  const fields = Array.isArray(workflow && workflow.inputs) ? workflow.inputs : [];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(secretRefs, field.id)) {
      const secretId = String(secretRefs[field.id] || '').trim();
      if (secretId) {
        envelopes[field.id] = { kind: 'secret-ref', secretId };
      }
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(values, field.id)) continue;
    const value = values[field.id];
    if (field.type === 'checkbox') {
      if (value === true || value === false) {
        envelopes[field.id] = { kind: 'plain', value: !!value };
      }
      continue;
    }
    if (value === '' || value == null) continue;
    envelopes[field.id] = { kind: 'plain', value };
  }
  return envelopes;
}

function sortPresets(presets) {
  return presets.slice().sort((left, right) => {
    const a = `${left.name || ''}\u0000${left.id || ''}`.toLowerCase();
    const b = `${right.name || ''}\u0000${right.id || ''}`.toLowerCase();
    return a.localeCompare(b);
  });
}

function workflowPresetDir(repoRoot, workflow) {
  if (!workflow || workflow.scope !== 'project' || !workflow.id) {
    throw new Error('Project workflow identity is required for preset storage.');
  }
  return path.join(projectWorkflowRoot(repoRoot), workflow.id);
}

function workflowPresetsPath(repoRoot, workflow) {
  return path.join(workflowPresetDir(repoRoot, workflow), WORKFLOW_PRESETS_FILENAME);
}

function loadPresetFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) return { presets: parsed };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.presets)) {
      return { presets: parsed.presets };
    }
  } catch {}
  return { presets: [] };
}

function savePresetFile(filePath, presets) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify({ presets: sortPresets(presets) }, null, 2), 'utf8');
}

function listWorkflowPresets(repoRoot, workflow) {
  const filePath = workflowPresetsPath(repoRoot, workflow);
  const parsed = loadPresetFile(filePath);
  const valid = [];
  for (const entry of parsed.presets || []) {
    const id = String(entry && entry.id || '').trim();
    const name = normalizePresetName(entry && entry.name);
    if (!id || !name) continue;
    valid.push(materializeWorkflowPreset(workflow, {
      id,
      name,
      updatedAt: entry && entry.updatedAt ? String(entry.updatedAt) : null,
      values: entry.values && typeof entry.values === 'object' ? entry.values : {},
    }));
  }
  return sortPresets(valid);
}

function loadWorkflowPreset(repoRoot, workflow, presetId) {
  return listWorkflowPresets(repoRoot, workflow).find((preset) => preset.id === presetId) || null;
}

function allocatePresetId(existingPresets, name) {
  const baseSlug = slugify(name || 'profile', 48) || 'profile';
  const used = new Set(existingPresets.map((preset) => preset.id));
  if (!used.has(baseSlug)) return baseSlug;
  let suffix = 2;
  while (used.has(`${baseSlug}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseSlug}-${suffix}`;
}

function saveWorkflowPreset(repoRoot, workflow, data = {}) {
  const name = normalizePresetName(data.name);
  if (!name) {
    throw new Error('Workflow profile name is required.');
  }
  const currentPresets = listWorkflowPresets(repoRoot, workflow);
  const presetId = String(data.id || '').trim() || allocatePresetId(currentPresets, name);
  const duplicate = currentPresets.find((preset) => preset.id !== presetId && preset.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    throw new Error(`A workflow profile named "${name}" already exists for this workflow.`);
  }

  const nextPreset = {
    id: presetId,
    name,
    updatedAt: String(data.updatedAt || nowIso()),
    values: compactWorkflowPresetValues(workflow, data.values || {}, data.secretRefs || {}),
  };

  const nextPresets = currentPresets
    .filter((preset) => preset.id !== presetId)
    .map((preset) => ({
      id: preset.id,
      name: preset.name,
      updatedAt: preset.updatedAt ? String(preset.updatedAt) : null,
      values: compactWorkflowPresetValues(workflow, preset.values || {}, preset.secretRefs || {}),
    }));
  nextPresets.push(nextPreset);
  savePresetFile(workflowPresetsPath(repoRoot, workflow), nextPresets);
  return materializeWorkflowPreset(workflow, nextPreset);
}

function replaceWorkflowPresets(repoRoot, workflow, presets = []) {
  const normalized = [];
  for (const preset of presets) {
    const id = String(preset && preset.id || '').trim();
    const name = normalizePresetName(preset && preset.name);
    if (!id || !name) continue;
    normalized.push({
      id,
      name,
      updatedAt: String(preset.updatedAt || nowIso()),
      values: compactWorkflowPresetValues(workflow, preset.values || {}, preset.secretRefs || {}),
    });
  }
  const filePath = workflowPresetsPath(repoRoot, workflow);
  if (normalized.length === 0) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
    return [];
  }
  savePresetFile(filePath, normalized);
  return normalized.map((preset) => materializeWorkflowPreset(workflow, preset));
}

function deleteWorkflowPreset(repoRoot, workflow, presetId) {
  const currentPresets = listWorkflowPresets(repoRoot, workflow);
  const removed = currentPresets.find((preset) => preset.id === presetId) || null;
  if (!removed) {
    throw new Error('Workflow profile not found.');
  }
  replaceWorkflowPresets(repoRoot, workflow, currentPresets.filter((preset) => preset.id !== presetId));
  return removed;
}

module.exports = {
  WORKFLOW_PRESETS_FILENAME,
  allocatePresetId,
  compactWorkflowPresetValues,
  deleteWorkflowPreset,
  listWorkflowPresets,
  loadWorkflowPreset,
  materializeWorkflowPreset,
  normalizePresetEnvelope,
  replaceWorkflowPresets,
  saveWorkflowPreset,
  workflowPresetDir,
  workflowPresetsPath,
};
