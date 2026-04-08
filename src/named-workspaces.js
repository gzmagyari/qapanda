const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { defaultStateRoot, manifestPath, resolveRunDir } = require('./state');
const { ensureDir, nowIso, pathExists, readJson, slugify, writeJson } = require('./utils');

const WORKSPACE_KIND = 'named-workspace';
const DEFAULT_RESUME_ALIAS = 'main';
const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ALIAS_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function appendWorkspaceDebugLog(repoRoot, text) {
  const candidates = [];
  if (repoRoot) candidates.push(path.join(repoRoot, '.qpanda', 'wizard-debug.log'));
  candidates.push(path.join(os.homedir(), '.qpanda', 'wizard-debug.log'));
  for (const logPath of candidates) {
    try {
      require('fs').mkdirSync(path.dirname(logPath), { recursive: true });
      require('fs').appendFileSync(logPath, `[${new Date().toISOString()}] [named-workspaces] ${text}\n`);
    } catch {}
  }
}

function workspacesRoot() {
  return path.join(os.homedir(), '.qpanda', 'workspaces');
}

function normalizeWorkspaceName(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  if (WORKSPACE_NAME_RE.test(value)) return value.toLowerCase();
  const slug = slugify(value, 64).replace(/^-+|-+$/g, '');
  return slug || '';
}

function normalizeResumeAlias(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  if (ALIAS_NAME_RE.test(value)) return value.toLowerCase();
  const slug = slugify(value, 64).replace(/^-+|-+$/g, '');
  return slug || '';
}

function assertWorkspaceName(name) {
  const normalized = normalizeWorkspaceName(name);
  if (!normalized) {
    throw new Error('Workspace name must contain at least one letter or number.');
  }
  return normalized;
}

function assertResumeAlias(name) {
  const normalized = normalizeResumeAlias(name);
  if (!normalized) {
    throw new Error('Resume alias must contain at least one letter or number.');
  }
  return normalized;
}

function normalizeChatTarget(target) {
  const value = String(target || '').trim();
  return value || null;
}

function workspaceRootFromName(name) {
  return path.join(workspacesRoot(), assertWorkspaceName(name));
}

function workspaceMetaPath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'workspace.json');
}

function resumeAliasesPath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'resume-aliases.json');
}

function createRepoRootIdentity(repoRoot) {
  return `repo:${path.resolve(repoRoot)}`;
}

function createNamedWorkspaceIdentity(name) {
  return `workspace:${assertWorkspaceName(name)}`;
}

function createRepoRootDescriptor(repoRoot) {
  const resolvedRoot = path.resolve(repoRoot || process.cwd());
  return {
    kind: 'repo',
    workspaceName: null,
    repoRoot: resolvedRoot,
    stateRoot: defaultStateRoot(resolvedRoot),
    rootIdentity: createRepoRootIdentity(resolvedRoot),
  };
}

function createNamedWorkspaceDescriptor(name) {
  const workspaceName = assertWorkspaceName(name);
  const repoRoot = workspaceRootFromName(workspaceName);
  return {
    kind: WORKSPACE_KIND,
    workspaceName,
    repoRoot,
    stateRoot: defaultStateRoot(repoRoot),
    rootIdentity: createNamedWorkspaceIdentity(workspaceName),
  };
}

function isNamedWorkspaceDescriptor(descriptor) {
  return !!(descriptor && descriptor.kind === WORKSPACE_KIND && descriptor.workspaceName);
}

async function resolveWorkspaceRoot(repoRoot, workspaceName, options = {}) {
  const requestedWorkspace = normalizeWorkspaceName(workspaceName);
  if (requestedWorkspace) {
    if (!options.enableNamedWorkspaces) {
      throw new Error('Named workspaces are disabled for this QA Panda workspace.');
    }
    return await ensureNamedWorkspace(requestedWorkspace, options.defaults || {});
  }
  return createRepoRootDescriptor(repoRoot);
}

async function loadWorkspaceMeta(repoRoot) {
  return await readJson(workspaceMetaPath(repoRoot), null);
}

async function saveWorkspaceMeta(repoRoot, meta) {
  await writeJson(workspaceMetaPath(repoRoot), meta);
}

async function ensureNamedWorkspace(name, defaults = {}) {
  const descriptor = createNamedWorkspaceDescriptor(name);
  const qpandaRoot = defaultStateRoot(descriptor.repoRoot);
  await ensureDir(qpandaRoot);

  const existingMeta = await loadWorkspaceMeta(descriptor.repoRoot);
  const nextMeta = {
    name: descriptor.workspaceName,
    kind: WORKSPACE_KIND,
    defaultAgent: defaults.defaultAgent !== undefined
      ? (defaults.defaultAgent || null)
      : (existingMeta && existingMeta.defaultAgent != null ? existingMeta.defaultAgent : null),
    defaultResume: defaults.defaultResume !== undefined
      ? (defaults.defaultResume || null)
      : (existingMeta && existingMeta.defaultResume != null ? existingMeta.defaultResume : DEFAULT_RESUME_ALIAS),
  };
  if (!existingMeta || JSON.stringify(existingMeta) !== JSON.stringify(nextMeta)) {
    await saveWorkspaceMeta(descriptor.repoRoot, nextMeta);
  }

  const aliasesFile = resumeAliasesPath(descriptor.repoRoot);
  const existingAliases = await readJson(aliasesFile, null);
  if (!existingAliases || typeof existingAliases !== 'object' || Array.isArray(existingAliases) || typeof existingAliases.aliases !== 'object' || Array.isArray(existingAliases.aliases)) {
    await writeJson(aliasesFile, { aliases: {}, updatedAt: nowIso() });
  }

  return descriptor;
}

async function listNamedWorkspaces() {
  const root = workspacesRoot();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const workspaces = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const descriptor = createNamedWorkspaceDescriptor(entry.name);
      const meta = await loadWorkspaceMeta(descriptor.repoRoot);
      workspaces.push({
        ...descriptor,
        meta: meta || null,
      });
    }
    workspaces.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
    return workspaces;
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function loadResumeAliases(repoRoot) {
  const data = await readJson(resumeAliasesPath(repoRoot), null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { aliases: {}, updatedAt: null };
  }
  const aliases = (data.aliases && typeof data.aliases === 'object' && !Array.isArray(data.aliases))
    ? data.aliases
    : {};
  return {
    aliases,
    updatedAt: data.updatedAt || null,
  };
}

function cloneAliasEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
  const next = {
    runId: entry.runId || null,
    chatTarget: entry.chatTarget || null,
    updatedAt: entry.updatedAt || null,
  };
  if (entry.targets && typeof entry.targets === 'object' && !Array.isArray(entry.targets)) {
    next.targets = {};
    for (const [key, value] of Object.entries(entry.targets)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      next.targets[key] = {
        runId: value.runId || null,
        chatTarget: value.chatTarget || key || null,
        updatedAt: value.updatedAt || null,
      };
    }
  }
  return next;
}

function ensureAliasTargets(entry) {
  const next = cloneAliasEntry(entry);
  if (!next.targets || typeof next.targets !== 'object') {
    next.targets = {};
  }
  const legacyTarget = normalizeChatTarget(next.chatTarget);
  if (legacyTarget && next.runId && !next.targets[legacyTarget]) {
    next.targets[legacyTarget] = {
      runId: next.runId,
      chatTarget: legacyTarget,
      updatedAt: next.updatedAt || null,
    };
  }
  return next;
}

async function saveResumeAliases(repoRoot, data) {
  const next = {
    aliases: (data && data.aliases && typeof data.aliases === 'object' && !Array.isArray(data.aliases))
      ? data.aliases
      : {},
    updatedAt: nowIso(),
  };
  await writeJson(resumeAliasesPath(repoRoot), next);
  return next;
}

async function listResumeAliases(repoRoot) {
  const data = await loadResumeAliases(repoRoot);
  const rows = [];
  for (const [name, rawValue] of Object.entries(data.aliases || {})) {
    const value = ensureAliasTargets(rawValue);
    const targets = value.targets && Object.keys(value.targets).length > 0
      ? value.targets
      : null;
    if (targets) {
      for (const [targetKey, targetValue] of Object.entries(targets)) {
        rows.push({
          name,
          runId: targetValue && targetValue.runId ? targetValue.runId : null,
          chatTarget: targetValue && targetValue.chatTarget ? targetValue.chatTarget : targetKey,
          updatedAt: targetValue && targetValue.updatedAt ? targetValue.updatedAt : null,
        });
      }
      continue;
    }
    rows.push({
      name,
      runId: value && value.runId ? value.runId : null,
      chatTarget: value && value.chatTarget ? value.chatTarget : null,
      updatedAt: value && value.updatedAt ? value.updatedAt : null,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

async function bindResumeAlias(repoRoot, alias, runId, metadata = {}) {
  const normalizedAlias = assertResumeAlias(alias);
  const data = await loadResumeAliases(repoRoot);
  const previousEntry = ensureAliasTargets(data.aliases[normalizedAlias] || null);
  const normalizedTarget = normalizeChatTarget(metadata.chatTarget);
  const previous = normalizedTarget
    ? (previousEntry.targets && previousEntry.targets[normalizedTarget]) || null
    : (previousEntry.runId ? previousEntry : null);
  const updatedAt = nowIso();
  const nextEntry = ensureAliasTargets(previousEntry);
  nextEntry.runId = String(runId || '').trim();
  nextEntry.chatTarget = normalizedTarget || null;
  nextEntry.updatedAt = updatedAt;
  if (normalizedTarget) {
    nextEntry.targets[normalizedTarget] = {
      runId: nextEntry.runId,
      chatTarget: normalizedTarget,
      updatedAt,
    };
  }
  data.aliases[normalizedAlias] = nextEntry;
  await saveResumeAliases(repoRoot, data);
  appendWorkspaceDebugLog(repoRoot, `bindResumeAlias alias=${normalizedAlias} runId=${nextEntry.runId || ''} chatTarget=${normalizedTarget || ''} overwritten=${!!(previous && previous.runId && previous.runId !== nextEntry.runId)}`);
  return {
    alias: normalizedAlias,
    previous,
    current: normalizedTarget
      ? data.aliases[normalizedAlias].targets[normalizedTarget]
      : data.aliases[normalizedAlias],
    overwritten: !!(previous && previous.runId && previous.runId !== nextEntry.runId),
  };
}

async function removeResumeAlias(repoRoot, alias) {
  const normalizedAlias = assertResumeAlias(alias);
  const data = await loadResumeAliases(repoRoot);
  const existing = data.aliases[normalizedAlias] || null;
  if (existing) {
    delete data.aliases[normalizedAlias];
    await saveResumeAliases(repoRoot, data);
    appendWorkspaceDebugLog(repoRoot, `removeResumeAlias alias=${normalizedAlias} removed=yes`);
  } else {
    appendWorkspaceDebugLog(repoRoot, `removeResumeAlias alias=${normalizedAlias} removed=no`);
  }
  return existing;
}

function pickPrimaryAliasTarget(targets) {
  const rows = Object.entries(targets || {})
    .filter(([, value]) => value && value.runId)
    .map(([key, value]) => ({
      key,
      value,
      updatedAt: value.updatedAt || '',
    }));
  if (rows.length === 0) return null;
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.key.localeCompare(b.key));
  return rows[0];
}

async function removeResumeAliasTarget(repoRoot, alias, chatTarget) {
  const normalizedAlias = assertResumeAlias(alias);
  const normalizedTarget = normalizeChatTarget(chatTarget);
  if (!normalizedTarget) {
    appendWorkspaceDebugLog(repoRoot, `removeResumeAliasTarget alias=${normalizedAlias} chatTarget=<none> fallback=removeResumeAlias`);
    return await removeResumeAlias(repoRoot, normalizedAlias);
  }

  const data = await loadResumeAliases(repoRoot);
  const existing = ensureAliasTargets(data.aliases[normalizedAlias] || null);
  if (!existing.targets || !existing.targets[normalizedTarget]) {
    appendWorkspaceDebugLog(repoRoot, `removeResumeAliasTarget alias=${normalizedAlias} chatTarget=${normalizedTarget} removed=no availableTargets=${Object.keys(existing.targets || {}).join(',')}`);
    return null;
  }

  const removed = existing.targets[normalizedTarget];
  delete existing.targets[normalizedTarget];

  const primary = pickPrimaryAliasTarget(existing.targets);
  if (primary) {
    existing.runId = primary.value.runId || null;
    existing.chatTarget = primary.value.chatTarget || primary.key || null;
    existing.updatedAt = primary.value.updatedAt || nowIso();
    data.aliases[normalizedAlias] = existing;
  } else {
    delete data.aliases[normalizedAlias];
  }

  await saveResumeAliases(repoRoot, data);
  appendWorkspaceDebugLog(
    repoRoot,
    `removeResumeAliasTarget alias=${normalizedAlias} chatTarget=${normalizedTarget} removed=yes remainingTargets=${Object.keys(existing.targets || {}).join(',')}`
  );
  return removed;
}

async function runExists(runId, stateRoot) {
  if (!runId) return false;
  try {
    const runDir = await resolveRunDir(runId, stateRoot);
    return await pathExists(manifestPath(runDir));
  } catch {
    return false;
  }
}

async function resolveResumeToken(token, repoRoot, stateRoot, options = {}) {
  const rawToken = String(token || '').trim();
  const requestedTarget = normalizeChatTarget(options.chatTarget);
  if (!rawToken) {
    appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=<empty> kind=none chatTarget=${requestedTarget || ''} allowPendingAlias=${!!options.allowPendingAlias}`);
    return { kind: 'none', token: '' };
  }

  const normalizedAlias = normalizeResumeAlias(rawToken);
  if (normalizedAlias) {
    const aliases = await loadResumeAliases(repoRoot);
    const aliasEntry = ensureAliasTargets(aliases.aliases[normalizedAlias] || null);
    let selectedEntry = null;
    if (requestedTarget && aliasEntry.targets && aliasEntry.targets[requestedTarget] && aliasEntry.targets[requestedTarget].runId) {
      selectedEntry = aliasEntry.targets[requestedTarget];
    } else if (requestedTarget && aliasEntry.chatTarget && aliasEntry.chatTarget === requestedTarget && aliasEntry.runId) {
      selectedEntry = aliasEntry;
    } else if (!requestedTarget && aliasEntry.runId) {
      selectedEntry = aliasEntry;
    }

    if (selectedEntry && selectedEntry.runId) {
      const exists = await runExists(selectedEntry.runId, stateRoot);
      if (exists) {
        appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=${rawToken} kind=alias alias=${normalizedAlias} runId=${selectedEntry.runId} chatTarget=${selectedEntry.chatTarget || requestedTarget || ''}`);
        return {
          kind: 'alias',
          token: rawToken,
          alias: normalizedAlias,
          runId: selectedEntry.runId,
          chatTarget: selectedEntry.chatTarget || requestedTarget || null,
        };
      }
      appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=${rawToken} kind=stale-alias alias=${normalizedAlias} runId=${selectedEntry.runId}`);
      return {
        kind: 'stale-alias',
        token: rawToken,
        alias: normalizedAlias,
        runId: selectedEntry.runId,
      };
    }

  }

  if (await runExists(rawToken, stateRoot)) {
    appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=${rawToken} kind=run runId=${rawToken}`);
    return { kind: 'run', token: rawToken, runId: rawToken };
  }

  if (normalizedAlias && requestedTarget && options.allowPendingAlias) {
    appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=${rawToken} kind=pending-alias alias=${normalizedAlias} chatTarget=${requestedTarget}`);
    return {
      kind: 'pending-alias',
      token: rawToken,
      alias: normalizedAlias,
    };
  }

  if (normalizedAlias && options.allowPendingAlias) {
    appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=${rawToken} kind=pending-alias alias=${normalizedAlias} chatTarget=${requestedTarget || ''}`);
    return {
      kind: 'pending-alias',
      token: rawToken,
      alias: normalizedAlias,
    };
  }

  appendWorkspaceDebugLog(repoRoot, `resolveResumeToken token=${rawToken} kind=missing alias=${normalizedAlias || ''} chatTarget=${requestedTarget || ''}`);
  return {
    kind: 'missing',
    token: rawToken,
    alias: normalizedAlias || null,
  };
}

async function resolveNamedWorkspaceRoot(name, defaults = {}) {
  return await ensureNamedWorkspace(name, defaults);
}

module.exports = {
  DEFAULT_RESUME_ALIAS,
  WORKSPACE_KIND,
  assertResumeAlias,
  assertWorkspaceName,
  bindResumeAlias,
  createNamedWorkspaceDescriptor,
  createNamedWorkspaceIdentity,
  createRepoRootDescriptor,
  createRepoRootIdentity,
  ensureNamedWorkspace,
  isNamedWorkspaceDescriptor,
  listNamedWorkspaces,
  listResumeAliases,
  loadResumeAliases,
  loadWorkspaceMeta,
  normalizeResumeAlias,
  normalizeWorkspaceName,
  removeResumeAlias,
  removeResumeAliasTarget,
  resolveNamedWorkspaceRoot,
  resolveWorkspaceRoot,
  resolveResumeToken,
  saveResumeAliases,
  saveWorkspaceMeta,
  workspaceMetaPath,
  workspaceRootFromName,
  workspacesRoot,
};
