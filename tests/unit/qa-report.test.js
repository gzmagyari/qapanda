const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildFinalQaReportState,
  loadQaState,
  mergeQaArtifactIds,
  normalizeQaArtifactIds,
} = require('../../src/qa-report');

function writeProjectState(repoRoot, { tests = [], tasks = [] } = {}) {
  const qpandaDir = path.join(repoRoot, '.qpanda');
  fs.mkdirSync(qpandaDir, { recursive: true });
  fs.writeFileSync(path.join(qpandaDir, 'tests.json'), JSON.stringify({ nextId: tests.length + 1, tests }, null, 2));
  fs.writeFileSync(path.join(qpandaDir, 'tasks.json'), JSON.stringify({ nextId: tasks.length + 1, tasks }, null, 2));
}

describe('qa-report', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-qa-report-'));
  });

  afterEach(() => {
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
  });

  it('builds request and session sections from touched artifacts', () => {
    writeProjectState(repoRoot, {
      tests: [{
        id: 'test-1',
        title: 'Login works',
        description: 'Verify valid login',
        environment: 'browser',
        status: 'passing',
        linkedTaskIds: ['task-2'],
        steps: [{ id: 'step-1', description: 'Submit form', expectedResult: 'Dashboard loads', actualResult: 'Dashboard loads', status: 'pass' }],
      }],
      tasks: [{
        id: 'task-1',
        title: 'Legacy bug',
        status: 'todo',
        description: 'Existing task',
        detail_text: 'Prior task',
        comments: [],
        progress_updates: [],
      }, {
        id: 'task-2',
        title: 'Login title bug',
        status: 'review',
        description: 'Created from the current request',
        detail_text: 'Fix the title on /login',
        linkedTestIds: ['test-1'],
        comments: [],
        progress_updates: [],
      }],
    });

    const manifest = { repoRoot, qaReportSession: { tests: [], tasks: ['task-1'] } };
    const request = { id: 'req-1', qaReportArtifacts: { tests: ['test-1'], tasks: ['task-2'] }, qaReportLabel: 'QA Engineer (Browser)' };
    const result = buildFinalQaReportState({ manifest, request, state: loadQaState(repoRoot) });

    assert.ok(result, 'should create a report payload');
    assert.deepEqual(result.requestArtifacts, { tests: ['test-1'], tasks: ['task-2'] });
    assert.deepEqual(result.sessionArtifacts, { tests: ['test-1'], tasks: ['task-1', 'task-2'] });
    assert.equal(result.payload.run.testCount, 1);
    assert.equal(result.payload.run.taskCount, 1);
    assert.equal(result.payload.session.taskCount, 2);
    assert.equal(result.payload.run.tests[0].detail.id, 'test-1');
    assert.equal(result.payload.run.tasks[0].itemType, 'bug');
  });

  it('returns null when the request touched no tests or tasks', () => {
    writeProjectState(repoRoot);
    const manifest = { repoRoot, qaReportSession: { tests: ['test-1'], tasks: [] } };
    const request = { id: 'req-2', qaReportArtifacts: { tests: [], tasks: [] } };
    const result = buildFinalQaReportState({ manifest, request, state: loadQaState(repoRoot) });
    assert.equal(result, null);
  });

  it('normalizes and merges artifact ids without duplicates', () => {
    const left = normalizeQaArtifactIds({ tests: ['test-1', 'test-1'], tasks: ['task-1'] });
    const merged = mergeQaArtifactIds(left, { tests: ['test-2', 'test-1'], tasks: ['task-1', 'task-2'] });
    assert.deepEqual(merged, { tests: ['test-1', 'test-2'], tasks: ['task-1', 'task-2'] });
  });
});
