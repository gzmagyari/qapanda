const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const {
  allocateTestId,
  loadTasksData,
  loadTestsData,
  nowIso,
  saveTestsData,
} = require('./tests-store');

const DEFAULT_PANDA_TEST_SOURCES = ['qapanda-tests/**/*.md'];
const PANDA_TEST_SOURCE_KIND = 'panda-prompt';
const VALID_PANDA_TEST_ENVIRONMENTS = new Set(['browser', 'computer']);

function pandaTestConfigPath(repoRoot) {
  return path.join(repoRoot, 'qapanda.config.json');
}

function pandaTestsFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tests.json');
}

function pandaTasksFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tasks.json');
}

function normalizePathSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeOptionalText(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeTags(value) {
  const raw = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  const tags = [];
  const seen = new Set();
  for (const entry of raw) {
    const tag = normalizeText(entry).toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function normalizeEnvironment(value) {
  const environment = normalizeText(value).toLowerCase();
  if (!environment) return 'browser';
  if (!VALID_PANDA_TEST_ENVIRONMENTS.has(environment)) {
    throw new Error(`Unsupported Panda test environment "${value}".`);
  }
  return environment;
}

function readTrackedJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
}

function loadPandaTestConfig(repoRoot) {
  const filePath = pandaTestConfigPath(repoRoot);
  const config = readTrackedJson(filePath);
  const sources = Array.isArray(config && config.pandaTests && config.pandaTests.sources)
    ? config.pandaTests.sources.map((entry) => normalizeText(entry)).filter(Boolean)
    : [];
  return {
    filePath,
    pandaTests: {
      sources: sources.length > 0 ? sources : [...DEFAULT_PANDA_TEST_SOURCES],
    },
  };
}

function hasGlobMagic(value) {
  return /[*?[\]{}]/.test(String(value || ''));
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  const normalized = normalizePathSlashes(pattern);
  let regex = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*') {
      if (next === '*') {
        const afterNext = normalized[index + 2];
        if (afterNext === '/') {
          regex += '(?:.*/)?';
          index += 2;
        } else {
          regex += '.*';
          index += 1;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      regex += '[^/]';
      continue;
    }
    regex += escapeRegExp(char);
  }
  regex += '$';
  return new RegExp(regex);
}

function globBaseDirectory(repoRoot, pattern) {
  const normalized = normalizePathSlashes(pattern);
  const match = normalized.match(/^[^*?[\]{}]*/);
  const literalPrefix = match ? match[0] : '';
  const trimmed = literalPrefix.endsWith('/') ? literalPrefix.slice(0, -1) : literalPrefix;
  return path.resolve(repoRoot, trimmed || '.');
}

function walkMarkdownFiles(dirPath, result = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const absolute = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(absolute, result);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      result.push(absolute);
    }
  }
  return result;
}

function expandSourceSelector(repoRoot, selector, { requireMatch = false } = {}) {
  const normalized = normalizePathSlashes(selector);
  const absolute = path.resolve(repoRoot, selector);
  let matches = [];

  if (!hasGlobMagic(normalized)) {
    if (fs.existsSync(absolute)) {
      const stats = fs.statSync(absolute);
      if (stats.isDirectory()) {
        matches = walkMarkdownFiles(absolute);
      } else if (stats.isFile() && absolute.toLowerCase().endsWith('.md')) {
        matches = [absolute];
      }
    }
  } else {
    const baseDir = globBaseDirectory(repoRoot, normalized);
    if (fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()) {
      const matcher = globToRegExp(normalized);
      matches = walkMarkdownFiles(baseDir).filter((filePath) => matcher.test(normalizePathSlashes(path.relative(repoRoot, filePath))));
    }
  }

  if (requireMatch && matches.length === 0) {
    throw new Error(`No Panda tests matched "${selector}".`);
  }

  return matches;
}

function parseFrontmatter(raw, filePath) {
  const match = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`Missing YAML frontmatter in ${filePath}.`);
  }
  try {
    const parsed = YAML.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Frontmatter must be a YAML object.');
    }
    return {
      meta: parsed,
      body: raw.slice(match[0].length),
      raw,
    };
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter in ${filePath}: ${error.message}`);
  }
}

function loadPandaTestDefinition(repoRoot, filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw, filePath);
  const sourceId = normalizeText(meta.id);
  if (!sourceId) {
    throw new Error(`Panda test ${filePath} is missing required frontmatter field "id".`);
  }
  const prompt = String(body || '').trim();
  if (!prompt) {
    throw new Error(`Panda test ${filePath} has an empty prompt body.`);
  }
  const relativePath = normalizePathSlashes(path.relative(repoRoot, filePath));
  if (relativePath === '' || relativePath.startsWith('../')) {
    throw new Error(`Panda test ${filePath} must live under the selected repo/workspace root.`);
  }
  return {
    id: sourceId,
    title: normalizeText(meta.title || sourceId),
    description: normalizeOptionalText(meta.description),
    agent: normalizeOptionalText(meta.agent),
    environment: normalizeEnvironment(meta.environment),
    tags: normalizeTags(meta.tags),
    timeout: normalizeOptionalText(meta.timeout),
    prompt,
    absolutePath: path.resolve(filePath),
    relativePath,
    sourceHash: crypto.createHash('sha1').update(raw, 'utf8').digest('hex'),
  };
}

function discoverPandaTests(repoRoot, selectors = null) {
  const config = loadPandaTestConfig(repoRoot);
  const activeSelectors = Array.isArray(selectors) && selectors.length > 0
    ? selectors
    : config.pandaTests.sources;

  const files = new Map();
  for (const selector of activeSelectors) {
    const matches = expandSourceSelector(repoRoot, selector, {
      requireMatch: Array.isArray(selectors) && selectors.length > 0,
    });
    for (const filePath of matches) {
      const relativePath = normalizePathSlashes(path.relative(repoRoot, filePath));
      files.set(relativePath, path.resolve(filePath));
    }
  }

  const definitions = [...files.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, filePath]) => loadPandaTestDefinition(repoRoot, filePath));

  const ids = new Map();
  for (const definition of definitions) {
    const duplicate = ids.get(definition.id);
    if (duplicate) {
      throw new Error(`Duplicate Panda test id "${definition.id}" found in ${duplicate} and ${definition.relativePath}.`);
    }
    ids.set(definition.id, definition.relativePath);
  }

  return definitions;
}

function filterPandaTests(definitions, options = {}) {
  const requestedIds = new Set((options.ids || []).map((entry) => normalizeText(entry)).filter(Boolean));
  const requestedTags = new Set((options.tags || []).map((entry) => normalizeText(entry).toLowerCase()).filter(Boolean));
  return definitions.filter((definition) => {
    if (requestedIds.size > 0 && !requestedIds.has(definition.id)) return false;
    if (requestedTags.size > 0 && !definition.tags.some((tag) => requestedTags.has(tag))) return false;
    return true;
  });
}

function runtimeTestRecordFromSource(definition, testId = null) {
  return {
    id: testId,
    title: definition.title,
    description: definition.description || `Managed Panda test from ${definition.relativePath}`,
    environment: definition.environment || 'browser',
    status: 'untested',
    steps: [],
    linkedTaskIds: [],
    tags: [...definition.tags],
    lastTestedAt: null,
    lastTestedBy: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    runs: [],
    source: {
      kind: PANDA_TEST_SOURCE_KIND,
      id: definition.id,
      path: definition.relativePath,
      hash: definition.sourceHash,
    },
  };
}

function findManagedRuntimeTestRecord(tests, definition) {
  const matches = (tests || []).filter((test) => {
    const source = test && test.source;
    if (!source || source.kind !== PANDA_TEST_SOURCE_KIND) return false;
    if (source.id && source.id === definition.id) return true;
    return source.path && normalizePathSlashes(source.path) === definition.relativePath;
  });
  if (matches.length > 1) {
    throw new Error(`Multiple managed runtime tests match Panda test "${definition.id}".`);
  }
  return matches[0] || null;
}

function latestRuntimeRunId(test) {
  const latestRun = Array.isArray(test && test.runs) && test.runs.length > 0
    ? test.runs[test.runs.length - 1]
    : null;
  return latestRun && latestRun.id != null ? Number(latestRun.id) : null;
}

function compareTaskTimelineEntry(left, right) {
  const leftTime = Date.parse(left && left.created_at ? left.created_at : '') || 0;
  const rightTime = Date.parse(right && right.created_at ? right.created_at : '') || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  const leftId = left && left.id != null ? String(left.id) : '';
  const rightId = right && right.id != null ? String(right.id) : '';
  return leftId.localeCompare(rightId);
}

function latestTaskTimelineEntry(items) {
  const entries = Array.isArray(items) ? items.filter((entry) => entry && typeof entry === 'object') : [];
  if (entries.length === 0) return null;
  return entries.reduce((latest, entry) => {
    if (!latest) return entry;
    return compareTaskTimelineEntry(latest, entry) >= 0 ? latest : entry;
  }, null);
}

function summarizeTaskTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    id: entry.id != null ? String(entry.id) : null,
    author: normalizeOptionalText(entry.author),
    text: normalizeOptionalText(entry.text),
    createdAt: normalizeOptionalText(entry.created_at),
  };
}

function summarizeLinkedTask(task) {
  return {
    id: task && task.id != null ? String(task.id) : null,
    title: normalizeOptionalText(task && task.title),
    status: normalizeOptionalText(task && task.status),
    description: normalizeOptionalText(task && task.description),
    detailText: normalizeOptionalText(task && task.detail_text),
    updatedAt: normalizeOptionalText(task && task.updated_at),
    linkedTestIds: Array.isArray(task && task.linkedTestIds) ? task.linkedTestIds.map((id) => String(id)) : [],
    latestProgressUpdate: summarizeTaskTimelineEntry(latestTaskTimelineEntry(task && task.progress_updates)),
    latestComment: summarizeTaskTimelineEntry(latestTaskTimelineEntry(task && task.comments)),
    missing: false,
  };
}

function summarizeMissingTask(taskId) {
  return {
    id: String(taskId),
    title: null,
    status: null,
    description: null,
    detailText: null,
    updatedAt: null,
    linkedTestIds: [],
    latestProgressUpdate: null,
    latestComment: null,
    missing: true,
  };
}

function resolveLinkedIssues(repoRoot, test) {
  const linkedTaskIds = Array.isArray(test && test.linkedTaskIds)
    ? test.linkedTaskIds.map((taskId) => String(taskId))
    : [];
  if (linkedTaskIds.length === 0) return { linkedTaskIds: [], issues: [], tasksFilePath: pandaTasksFilePath(repoRoot) };
  const tasksData = loadTasksData(pandaTasksFilePath(repoRoot));
  const tasksById = new Map((tasksData.tasks || []).map((task) => [String(task.id), task]));
  return {
    linkedTaskIds,
    issues: linkedTaskIds.map((taskId) => {
      const task = tasksById.get(taskId);
      return task ? summarizeLinkedTask(task) : summarizeMissingTask(taskId);
    }),
    tasksFilePath: pandaTasksFilePath(repoRoot),
  };
}

function upsertManagedRuntimeTestRecord(repoRoot, definition) {
  const filePath = pandaTestsFilePath(repoRoot);
  const data = loadTestsData(filePath);
  let test = findManagedRuntimeTestRecord(data.tests, definition);
  const beforeLatestRunId = latestRuntimeRunId(test);

  if (!test) {
    const id = allocateTestId(data);
    test = runtimeTestRecordFromSource(definition, id);
    data.tests.push(test);
  } else {
    test.title = definition.title;
    test.description = definition.description || `Managed Panda test from ${definition.relativePath}`;
    test.environment = definition.environment || 'browser';
    test.tags = [...definition.tags];
    test.updated_at = nowIso();
    if (!test.source || typeof test.source !== 'object') test.source = {};
    test.source.kind = PANDA_TEST_SOURCE_KIND;
    test.source.id = definition.id;
    test.source.path = definition.relativePath;
    test.source.hash = definition.sourceHash;
  }

  saveTestsData(filePath, data);
  return {
    filePath,
    runtimeTestId: test.id,
    beforeLatestRunId,
    managed: true,
  };
}

function loadManagedRuntimeTestState(repoRoot, definition) {
  const data = loadTestsData(pandaTestsFilePath(repoRoot));
  const test = findManagedRuntimeTestRecord(data.tests, definition);
  const latestRun = Array.isArray(test && test.runs) && test.runs.length > 0
    ? test.runs[test.runs.length - 1]
    : null;
  const linkedIssues = resolveLinkedIssues(repoRoot, test);
  return {
    filePath: pandaTestsFilePath(repoRoot),
    tasksFilePath: linkedIssues.tasksFilePath,
    test,
    latestRun,
    linkedTaskIds: linkedIssues.linkedTaskIds,
    notes: latestRun && latestRun.notes ? String(latestRun.notes) : null,
    issues: linkedIssues.issues,
  };
}

module.exports = {
  DEFAULT_PANDA_TEST_SOURCES,
  PANDA_TEST_SOURCE_KIND,
  discoverPandaTests,
  filterPandaTests,
  findManagedRuntimeTestRecord,
  latestRuntimeRunId,
  loadManagedRuntimeTestState,
  loadPandaTestConfig,
  loadPandaTestDefinition,
  pandaTestConfigPath,
  pandaTasksFilePath,
  pandaTestsFilePath,
  runtimeTestRecordFromSource,
  upsertManagedRuntimeTestRecord,
};
