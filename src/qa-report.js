const fs = require('node:fs');
const path = require('node:path');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniqueOrdered(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    if (!value) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function normalizeQaArtifactIds(value) {
  const normalized = value && typeof value === 'object' ? value : {};
  return {
    tests: uniqueOrdered(normalized.tests || normalized.testIds || []),
    tasks: uniqueOrdered(normalized.tasks || normalized.taskIds || []),
  };
}

function emptyQaArtifactIds() {
  return { tests: [], tasks: [] };
}

function hasQaArtifacts(value) {
  const normalized = normalizeQaArtifactIds(value);
  return normalized.tests.length > 0 || normalized.tasks.length > 0;
}

function mergeQaArtifactIds(base, extra) {
  const left = normalizeQaArtifactIds(base);
  const right = normalizeQaArtifactIds(extra);
  return {
    tests: uniqueOrdered([...left.tests, ...right.tests]),
    tasks: uniqueOrdered([...left.tasks, ...right.tasks]),
  };
}

function testsFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tests.json');
}

function tasksFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tasks.json');
}

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function mapById(list) {
  return new Map((list || [])
    .filter((item) => item && item.id)
    .map((item) => [String(item.id), item]));
}

function loadQaState(repoRoot) {
  const testsDoc = loadJsonFile(testsFilePath(repoRoot), { tests: [] });
  const tasksDoc = loadJsonFile(tasksFilePath(repoRoot), { tasks: [] });
  const tests = Array.isArray(testsDoc.tests) ? testsDoc.tests : [];
  const tasks = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
  return {
    tests,
    tasks,
    testsById: mapById(tests),
    tasksById: mapById(tasks),
  };
}

function normalizeStepStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'passing') return 'pass';
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'failing') return 'fail';
  return 'skip';
}

function buildTestSummary(test) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const step of Array.isArray(test && test.steps) ? test.steps : []) {
    const status = normalizeStepStatus(step && step.status);
    if (status === 'pass') passed++;
    else if (status === 'fail') failed++;
    else skipped++;
  }
  return { passed, failed, skipped };
}

function buildQaReportTestItem(test) {
  const counts = buildTestSummary(test);
  return {
    id: String(test && test.id || ''),
    title: (test && test.title) || 'Test',
    status: (test && test.status) || 'untested',
    environment: (test && test.environment) || '',
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    detail: clone(test || {}),
  };
}

function buildQaReportTaskItem(task) {
  const linkedTestIds = Array.isArray(task && task.linkedTestIds) ? task.linkedTestIds.map(String) : [];
  const itemType = linkedTestIds.length > 0 ? 'bug' : 'task';
  return {
    id: String(task && task.id || ''),
    title: (task && task.title) || 'Task',
    status: (task && task.status) || 'todo',
    itemType,
    linkedTestIds,
    description: (task && task.description) || '',
    detail: clone(task || {}),
  };
}

function buildQaReportSection(artifactIds, state) {
  const normalized = normalizeQaArtifactIds(artifactIds);
  const tests = normalized.tests
    .map((id) => state.testsById.get(id))
    .filter(Boolean)
    .map(buildQaReportTestItem);
  const tasks = normalized.tasks
    .map((id) => state.tasksById.get(id))
    .filter(Boolean)
    .map(buildQaReportTaskItem);
  return {
    testCount: tests.length,
    taskCount: tasks.length,
    tests,
    tasks,
  };
}

function buildQaReportPayload({ requestArtifacts, sessionArtifacts, state, requestId = null, updatedAt = null }) {
  return {
    requestId: requestId || null,
    updatedAt: updatedAt || new Date().toISOString(),
    run: buildQaReportSection(requestArtifacts, state),
    session: buildQaReportSection(sessionArtifacts, state),
  };
}

function buildFinalQaReportState({ manifest, request, state }) {
  const requestArtifacts = normalizeQaArtifactIds(request && request.qaReportArtifacts);
  if (!hasQaArtifacts(requestArtifacts)) {
    return null;
  }
  const priorSessionArtifacts = normalizeQaArtifactIds(manifest && manifest.qaReportSession);
  const sessionArtifacts = mergeQaArtifactIds(priorSessionArtifacts, requestArtifacts);
  return {
    payload: buildQaReportPayload({
      requestArtifacts,
      sessionArtifacts,
      state,
      requestId: request && request.id,
      updatedAt: new Date().toISOString(),
    }),
    requestArtifacts,
    sessionArtifacts,
    label: request && request.qaReportLabel ? String(request.qaReportLabel) : null,
  };
}

module.exports = {
  buildFinalQaReportState,
  buildQaReportPayload,
  emptyQaArtifactIds,
  hasQaArtifacts,
  loadQaState,
  mergeQaArtifactIds,
  normalizeQaArtifactIds,
};
