const fs = require('node:fs');
const path = require('node:path');

const VALID_TEST_STATUSES = ['untested', 'passing', 'failing', 'partial'];
const VALID_STEP_STATUSES = ['untested', 'pass', 'fail', 'skip'];
const VALID_ENVIRONMENTS = ['browser', 'computer'];

function emptyTestsData() {
  return { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] };
}

function emptyTasksData() {
  return { nextId: 1, nextCommentId: 1, nextProgressId: 1, tasks: [] };
}

function nowIso() {
  return new Date().toISOString();
}

function ensureTestsDataShape(data) {
  const next = data && typeof data === 'object' ? { ...data } : {};
  if (!Number.isInteger(next.nextId) || next.nextId < 1) next.nextId = 1;
  if (!Number.isInteger(next.nextStepId) || next.nextStepId < 1) next.nextStepId = 1;
  if (!Number.isInteger(next.nextRunId) || next.nextRunId < 1) next.nextRunId = 1;
  next.tests = Array.isArray(next.tests) ? next.tests : [];
  return next;
}

function ensureTasksDataShape(data) {
  const next = data && typeof data === 'object' ? { ...data } : {};
  if (!Number.isInteger(next.nextId) || next.nextId < 1) next.nextId = 1;
  if (!Number.isInteger(next.nextCommentId) || next.nextCommentId < 1) next.nextCommentId = 1;
  if (!Number.isInteger(next.nextProgressId) || next.nextProgressId < 1) next.nextProgressId = 1;
  next.tasks = Array.isArray(next.tasks) ? next.tasks : [];
  return next;
}

function loadTestsData(filePath) {
  try {
    return ensureTestsDataShape(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyTestsData();
    throw error;
  }
}

function loadTasksData(filePath) {
  try {
    return ensureTasksDataShape(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyTasksData();
    throw error;
  }
}

function saveTestsData(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ensureTestsDataShape(data), null, 2), 'utf8');
}

function saveTasksData(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(ensureTasksDataShape(data), null, 2), 'utf8');
}

function computeOverallStatus(steps) {
  if (!steps || steps.length === 0) return 'untested';
  const statuses = steps.map((step) => step.status);
  if (statuses.every((status) => status === 'untested')) return 'untested';
  if (statuses.every((status) => status === 'pass' || status === 'skip')) return 'passing';
  if (statuses.every((status) => status === 'fail')) return 'failing';
  if (statuses.some((status) => status === 'fail')) return 'partial';
  if (statuses.some((status) => status === 'pass')) return 'partial';
  return 'untested';
}

function allocateTestId(data) {
  const target = data && typeof data === 'object' ? data : {};
  const normalized = ensureTestsDataShape(target);
  Object.assign(target, normalized);
  const id = `test-${target.nextId++}`;
  return id;
}

module.exports = {
  VALID_ENVIRONMENTS,
  VALID_STEP_STATUSES,
  VALID_TEST_STATUSES,
  allocateTestId,
  computeOverallStatus,
  emptyTasksData,
  emptyTestsData,
  ensureTasksDataShape,
  ensureTestsDataShape,
  loadTasksData,
  loadTestsData,
  nowIso,
  saveTasksData,
  saveTestsData,
};
