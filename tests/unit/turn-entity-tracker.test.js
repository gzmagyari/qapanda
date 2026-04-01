const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TurnEntityTracker } = require('../../src/turn-entity-tracker');

function writeProjectState(repoRoot, { tests = [], tasks = [] } = {}) {
  const qpandaDir = path.join(repoRoot, '.qpanda');
  fs.mkdirSync(qpandaDir, { recursive: true });
  fs.writeFileSync(path.join(qpandaDir, 'tests.json'), JSON.stringify({ nextId: tests.length + 1, tests }, null, 2));
  fs.writeFileSync(path.join(qpandaDir, 'tasks.json'), JSON.stringify({ nextId: tasks.length + 1, tasks }, null, 2));
}

describe('TurnEntityTracker', () => {
  let repoRoot;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-turn-tracker-'));
    writeProjectState(repoRoot);
  });

  afterEach(() => {
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
  });

  it('emits live and final test cards for changed tests', async () => {
    const posted = [];
    const request = { id: 'req-1' };
    const tracker = new TurnEntityTracker({
      manifest: { repoRoot },
      renderer: { _post: (msg) => posted.push(msg) },
      request,
    });

    writeProjectState(repoRoot, {
      tests: [{
        id: 'test-1',
        title: 'Consent dialog',
        description: 'Verify the Google consent modal',
        environment: 'browser',
        status: 'partial',
        linkedTaskIds: [],
        steps: [{
          id: 'step-1',
          description: 'Open Google',
          expectedResult: 'Consent dialog is visible',
          actualResult: '',
          status: 'untested',
        }],
      }],
    });
    await tracker.noteToolCompletion('create_test', {}, { id: 'test-1' }, 'QA Engineer (Browser)');

    writeProjectState(repoRoot, {
      tests: [{
        id: 'test-1',
        title: 'Consent dialog',
        description: 'Verify the Google consent modal',
        environment: 'browser',
        status: 'passing',
        linkedTaskIds: [],
        steps: [{
          id: 'step-1',
          description: 'Open Google',
          expectedResult: 'Consent dialog is visible',
          actualResult: 'Dialog displayed',
          status: 'pass',
        }],
      }],
    });
    await tracker.noteToolCompletion('complete_test_run', { test_id: 'test-1' }, {}, 'QA Engineer (Browser)');
    await tracker.finalize({ emitFinalCards: true });

    const liveCards = posted.filter((msg) => msg.type === 'liveEntityCard');
    const finalCards = posted.filter((msg) => msg.type === 'testCard');
    assert.ok(liveCards.length >= 1, 'should emit at least one live card');
    assert.equal(liveCards.at(-1).entityType, 'test');
    assert.equal(liveCards.at(-1).data.test_id, 'test-1');
    assert.equal(liveCards.at(-1).data.passed, 1);
    assert.equal(request.qaReportArtifacts.tests[0], 'test-1');
    assert.ok(posted.some((msg) => msg.type === 'clearLiveEntityCard'));
    assert.equal(finalCards.length, 1);
    assert.equal(finalCards[0].data.test_id, 'test-1');
    assert.equal(finalCards[0].data.steps.length, 1);
  });

  it('tracks bugs created from tests as changed tasks', async () => {
    const posted = [];
    const tracker = new TurnEntityTracker({
      manifest: { repoRoot },
      renderer: { _post: (msg) => posted.push(msg) },
    });

    writeProjectState(repoRoot, {
      tests: [{
        id: 'test-2',
        title: 'Login flow',
        description: 'Check invalid credentials',
        environment: 'browser',
        status: 'failing',
        linkedTaskIds: ['task-99'],
        steps: [{
          id: 'step-1',
          description: 'Submit invalid password',
          expectedResult: 'Error banner shown',
          actualResult: 'No banner shown',
          status: 'fail',
        }],
      }],
      tasks: [{
        id: 'task-99',
        title: 'Fix missing login error',
        status: 'todo',
        description: 'Bug created from test failure',
        detail_text: 'Investigate missing validation feedback',
        comments: [],
        progress_updates: [],
      }],
    });

    await tracker.noteToolCompletion(
      'create_bug_from_test',
      { test_id: 'test-2' },
      { test_id: 'test-2', task_id: 'task-99' },
      'QA Engineer (Browser)'
    );
    await tracker.finalize({ emitFinalCards: true });

    const liveCard = posted.find((msg) => msg.type === 'liveEntityCard');
    const taskCards = posted.filter((msg) => msg.type === 'taskCard');
    assert.ok(liveCard, 'should emit a live entity card');
    assert.equal(liveCard.entityType, 'task');
    assert.equal(liveCard.data.task_id, 'task-99');
    assert.equal(taskCards.length, 1);
    assert.equal(taskCards[0].data.task_id, 'task-99');
  });

  it('suppresses duplicate final cards when a display tool already rendered the entity', async () => {
    const posted = [];
    const tracker = new TurnEntityTracker({
      manifest: { repoRoot },
      renderer: { _post: (msg) => posted.push(msg) },
    });

    tracker.noteRenderedToolCard('display_task', { task_id: 'task-1', title: 'Fix login' }, 'Developer');
    writeProjectState(repoRoot, {
      tasks: [{
        id: 'task-1',
        title: 'Fix login',
        status: 'review',
        description: 'Duplicate card should be suppressed',
        detail_text: 'Already shown explicitly by display_task',
        comments: [],
        progress_updates: [],
      }],
    });

    await tracker.noteToolCompletion('create_task', {}, { id: 'task-1' }, 'Developer');
    await tracker.finalize({ emitFinalCards: true });

    assert.equal(posted.filter((msg) => msg.type === 'taskCard').length, 0);
  });

  it('suppresses fallback test cards when display_test_summary already rendered the test', async () => {
    const posted = [];
    const tracker = new TurnEntityTracker({
      manifest: { repoRoot },
      renderer: { _post: (msg) => posted.push(msg) },
    });

    tracker.noteRenderedToolCard('display_test_summary', { test_id: 'test-1', title: 'Consent dialog' }, 'QA Engineer (Browser)');
    writeProjectState(repoRoot, {
      tests: [{
        id: 'test-1',
        title: 'Consent dialog',
        description: 'Verify the Google consent modal',
        environment: 'browser',
        status: 'passing',
        linkedTaskIds: [],
        steps: [{
          id: 'step-1',
          description: 'Open Google',
          expectedResult: 'Consent dialog is visible',
          actualResult: 'Dialog displayed',
          status: 'pass',
        }],
      }],
    });

    await tracker.noteToolCompletion('complete_test_run', { test_id: 'test-1' }, {}, 'QA Engineer (Browser)');
    await tracker.finalize({ emitFinalCards: true });

    assert.equal(posted.filter((msg) => msg.type === 'testCard').length, 0);
  });
});
