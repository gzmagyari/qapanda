const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, readJson, writeJson } = require('../helpers/test-utils');
const { loadTestsData, saveTestsData } = require('../../src/tests-store');
const { pandaTestsFilePath } = require('../../src/panda-tests');
const { buildJUnitReport, buildManagedPandaTestPrompt, listPandaTests, runPandaTestSuite } = require('../../src/panda-test-runner');

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeManifest(stateRoot, runId) {
  const filePath = path.join(stateRoot, 'runs', runId, 'manifest.json');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ runId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2));
}

function tasksFilePath(repoRoot) {
  return path.join(repoRoot, '.qpanda', 'tasks.json');
}

function writeTasks(repoRoot, tasks) {
  writeJson(tasksFilePath(repoRoot), {
    nextId: tasks.length + 1,
    nextCommentId: 10,
    nextProgressId: 10,
    tasks,
  });
}

function runtimeTestIdFromArgs(args) {
  const prompt = String(args.at(-1) || '');
  const match = prompt.match(/test_id "([^"]+)"/);
  return match ? match[1].trim() : '';
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = function patchedWrite(chunk, encoding, callback) {
    output += String(chunk);
    if (typeof callback === 'function') callback();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return output;
}

function createFakeSpawn(repoRoot, outcomes) {
  let index = 0;
  return async ({ args }) => {
    const outcome = outcomes[index++] || {};
    const runtimeTestId = runtimeTestIdFromArgs(args);
    const stateDirIndex = args.indexOf('--state-dir');
    const stateRoot = stateDirIndex >= 0 ? path.resolve(args[stateDirIndex + 1]) : path.join(repoRoot, '.qpanda');
    const data = loadTestsData(pandaTestsFilePath(repoRoot));
    const test = data.tests.find((entry) => entry.id === runtimeTestId);
    assert.ok(test, `expected managed runtime test ${runtimeTestId} to exist`);

    if (outcome.recordRun !== false) {
      const stepId = data.nextStepId++;
      const runNumericId = data.nextRunId++;
      test.steps = [{
        id: stepId,
        description: outcome.step || 'Execute test',
        expectedResult: 'Expected result',
        status: outcome.fail ? 'fail' : 'pass',
        actualResult: outcome.fail ? 'Observed failure' : 'Observed success',
      }];
      test.status = outcome.fail ? 'partial' : 'passing';
      test.linkedTaskIds = Array.isArray(outcome.linkedTaskIds) ? [...outcome.linkedTaskIds] : [];
      test.runs.push({
        id: runNumericId,
        date: new Date().toISOString(),
        agent: 'QA-Browser',
        status: outcome.fail ? 'partial' : 'passing',
        stepResults: [{
          stepId,
          status: outcome.fail ? 'fail' : 'pass',
          actualResult: outcome.fail ? 'Observed failure' : 'Observed success',
        }],
        notes: outcome.notes == null ? null : outcome.notes,
      });
      saveTestsData(pandaTestsFilePath(repoRoot), data);
      writeManifest(stateRoot, outcome.runId || `run-${runtimeTestId}-${runNumericId}`);
    }

    return {
      code: outcome.code == null ? 0 : outcome.code,
      stdout: outcome.stdout || '',
      stderr: outcome.stderr || '',
      signal: null,
      timedOut: Boolean(outcome.timedOut),
      timeoutMs: outcome.timeoutMs || null,
    };
  };
}

describe('panda test runner', () => {
  it('lists discovered Panda tests with runtime binding info', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntagS: [smoke, login]\n---\n\nVerify login.\n`.replace('tagS', 'tags'));
      const entries = listPandaTests({ repoRoot: tmp.root });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, 'login-smoke');
      assert.equal(entries[0].managed, true);
      assert.equal(entries[0].runtimeTestId, null);
    } finally {
      tmp.cleanup();
    }
  });

  it('defaults computer Panda tests to the QA agent', () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'desktop.md'), `---\nid: desktop-smoke\ntitle: Desktop smoke\nenvironment: computer\n---\n\nVerify the desktop flow.\n`);
      const entries = listPandaTests({ repoRoot: tmp.root });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].agent, 'QA');
    } finally {
      tmp.cleanup();
    }
  });

  it('builds environment-specific managed prompts', () => {
    const browserPrompt = buildManagedPandaTestPrompt({
      id: 'login-smoke',
      title: 'Login smoke',
      relativePath: 'qapanda-tests/login.md',
      environment: 'browser',
      tags: ['smoke'],
      timeout: null,
    }, 'test-1');
    const computerPrompt = buildManagedPandaTestPrompt({
      id: 'desktop-smoke',
      title: 'Desktop smoke',
      relativePath: 'qapanda-tests/desktop.md',
      environment: 'computer',
      tags: ['smoke'],
      timeout: null,
    }, 'test-2');

    assert.match(browserPrompt, /Execute the browser test/);
    assert.match(browserPrompt, /QA Browser bug-logging workflow/);
    assert.match(computerPrompt, /Execute the computer test/);
    assert.match(computerPrompt, /normal QA bug-logging workflow/);
    assert.doesNotMatch(computerPrompt, /QA Browser bug-logging workflow/);
    assert.doesNotMatch(browserPrompt, /Managed source metadata:/);
    assert.doesNotMatch(browserPrompt, /Timeout:/);
    assert.doesNotMatch(browserPrompt, /Source id:/);
    assert.doesNotMatch(browserPrompt, /Title:/);
    assert.doesNotMatch(browserPrompt, /Tags:/);
  });

  it('runs selected Panda tests sequentially and writes JSON output', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke, login]\n---\n\nVerify login.\n`);
      writeText(path.join(tmp.root, 'qapanda-tests', 'billing.md'), `---\nid: billing-regression\ntitle: Billing regression\ntags: [billing]\n---\n\nVerify billing.\n`);

      const outputPath = path.join(tmp.root, 'reports', 'panda.json');
      const suite = await runPandaTestSuite({
        repoRoot: tmp.root,
        reporter: 'json',
        outputPath,
        tags: ['smoke', 'billing'],
      }, {
        spawnRun: createFakeSpawn(tmp.root, [
          { runId: 'run-login', fail: false },
          { runId: 'run-billing', fail: true },
        ]),
      });

      assert.equal(suite.suite.total, 2);
      assert.equal(suite.suite.passed, 1);
      assert.equal(suite.suite.failed, 1);
      assert.equal(suite.tests[0].status, 'passed');
      assert.equal(suite.tests[1].status, 'failed');
      assert.match(suite.tests[1].message, /Observed failure/);
      assert.deepEqual(suite.tests[0].linkedTaskIds, []);
      assert.deepEqual(suite.tests[0].issues, []);
      assert.deepEqual(suite.tests[0].issueSummaries, []);
      assert.equal(suite.tests[0].notes, null);

      const written = readJson(outputPath);
      assert.equal(written.suite.failed, 1);
      assert.equal(written.tests[1].runId, 'run-billing');
      assert.deepEqual(written.tests[1].issues, []);
      assert.deepEqual(written.tests[1].issueSummaries, []);
    } finally {
      tmp.cleanup();
    }
  });

  it('includes resolved linked issues and notes in JSON output', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke, login]\n---\n\nVerify login.\n`);
      writeTasks(tmp.root, [{
        id: 'task-1',
        title: 'Login title mismatch',
        description: 'The login page uses the wrong title.',
        detail_text: 'Document title should reference login.',
        status: 'todo',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        comments: [
          { id: 1, author: 'qa', text: 'First note', created_at: '2026-01-01T10:00:00.000Z' },
          { id: 2, author: 'qa', text: 'Newest note', created_at: '2026-01-02T10:00:00.000Z' },
        ],
        progress_updates: [
          { id: 1, author: 'qa', text: 'Initial repro', created_at: '2026-01-01T09:00:00.000Z' },
          { id: 2, author: 'qa', text: 'Still failing', created_at: '2026-01-02T09:00:00.000Z' },
        ],
        linkedTestIds: ['test-1'],
      }]);

      const outputPath = path.join(tmp.root, 'reports', 'panda.json');
      const suite = await runPandaTestSuite({
        repoRoot: tmp.root,
        reporter: 'json',
        outputPath,
      }, {
        spawnRun: createFakeSpawn(tmp.root, [
          { runId: 'run-login', fail: false, linkedTaskIds: ['task-1'], notes: 'Retest complete.' },
        ]),
      });

      const result = suite.tests[0];
      assert.deepEqual(result.linkedTaskIds, ['task-1']);
      assert.equal(result.notes, 'Retest complete.');
      assert.equal(result.issues.length, 1);
      assert.deepEqual(result.issueSummaries, [
        'task-1: Login title mismatch — Still failing',
      ]);
      assert.deepEqual(result.issues[0], {
        id: 'task-1',
        title: 'Login title mismatch',
        status: 'todo',
        description: 'The login page uses the wrong title.',
        detailText: 'Document title should reference login.',
        updatedAt: '2026-01-02T00:00:00.000Z',
        linkedTestIds: ['test-1'],
        latestProgressUpdate: {
          id: '2',
          author: 'qa',
          text: 'Still failing',
          createdAt: '2026-01-02T09:00:00.000Z',
        },
        latestComment: {
          id: '2',
          author: 'qa',
          text: 'Newest note',
          createdAt: '2026-01-02T10:00:00.000Z',
        },
        missing: false,
      });

      const written = readJson(outputPath);
      assert.deepEqual(written.tests[0].linkedTaskIds, ['task-1']);
      assert.equal(written.tests[0].notes, 'Retest complete.');
      assert.equal(written.tests[0].issues[0].title, 'Login title mismatch');
      assert.deepEqual(written.tests[0].issueSummaries, [
        'task-1: Login title mismatch — Still failing',
      ]);
    } finally {
      tmp.cleanup();
    }
  });

  it('emits linked issues in ndjson test.finish events', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\n---\n\nVerify login.\n`);
      writeTasks(tmp.root, [{
        id: 'task-9',
        title: 'Tracked login bug',
        description: 'Bug description',
        detail_text: '',
        status: 'testing',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z',
        comments: [],
        progress_updates: [],
        linkedTestIds: ['test-1'],
      }]);

      const outputPath = path.join(tmp.root, 'reports', 'panda.ndjson');
      await runPandaTestSuite({
        repoRoot: tmp.root,
        reporter: 'ndjson',
        outputPath,
      }, {
        spawnRun: createFakeSpawn(tmp.root, [
          { runId: 'run-login', fail: true, linkedTaskIds: ['task-9'], notes: 'Bug reproduced.' },
        ]),
      });

      const events = fs.readFileSync(outputPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const finish = events.find((event) => event.type === 'test.finish');
      assert.ok(finish, 'expected a test.finish event');
      assert.deepEqual(finish.linkedTaskIds, ['task-9']);
      assert.equal(finish.notes, 'Bug reproduced.');
      assert.equal(finish.issues.length, 1);
      assert.equal(finish.issues[0].id, 'task-9');
      assert.equal(finish.issues[0].title, 'Tracked login bug');
      assert.deepEqual(finish.issueSummaries, [
        'task-9: Tracked login bug — Bug description',
      ]);
    } finally {
      tmp.cleanup();
    }
  });

  it('preserves unresolved linked tasks as missing issue stubs', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\n---\n\nVerify login.\n`);

      const suite = await runPandaTestSuite({
        repoRoot: tmp.root,
        reporter: 'json',
        outputPath: path.join(tmp.root, 'reports', 'panda.json'),
      }, {
        spawnRun: createFakeSpawn(tmp.root, [
          { runId: 'run-login', fail: true, linkedTaskIds: ['task-missing'] },
        ]),
      });

      assert.deepEqual(suite.tests[0].linkedTaskIds, ['task-missing']);
      assert.deepEqual(suite.tests[0].issues, [{
        id: 'task-missing',
        title: null,
        status: null,
        description: null,
        detailText: null,
        updatedAt: null,
        linkedTestIds: [],
        latestProgressUpdate: null,
        latestComment: null,
        missing: true,
      }]);
      assert.deepEqual(suite.tests[0].issueSummaries, ['task-missing']);
    } finally {
      tmp.cleanup();
    }
  });

  it('marks a suite error when the child run does not record a new managed test run', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\n---\n\nVerify login.\n`);

      const suite = await runPandaTestSuite({
        repoRoot: tmp.root,
        reporter: 'json',
        outputPath: path.join(tmp.root, 'reports', 'suite.json'),
      }, {
        spawnRun: createFakeSpawn(tmp.root, [{ recordRun: false }]),
      });

      assert.equal(suite.suite.errors, 1);
      assert.equal(suite.tests[0].status, 'error');
      assert.match(suite.tests[0].message, /did not record a test run/i);
    } finally {
      tmp.cleanup();
    }
  });

  it('keeps human-mode child streaming enabled and prints a colored final summary', async () => {
    const tmp = createTempDir();
    try {
      writeText(path.join(tmp.root, 'qapanda-tests', 'login.md'), `---\nid: login-smoke\ntitle: Login smoke\ntags: [smoke]\n---\n\nVerify login.\n`);
      writeText(path.join(tmp.root, 'qapanda-tests', 'billing.md'), `---\nid: billing-regression\ntitle: Billing regression\n---\n\nVerify billing.\n`);
      writeTasks(tmp.root, [{
        id: 'task-7',
        title: 'Billing issue',
        description: 'Billing regression is still reproducible.',
        detail_text: '',
        status: 'todo',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        comments: [],
        progress_updates: [],
        linkedTestIds: ['test-2'],
      }]);

      const forwarded = [];
      const fakeSpawn = createFakeSpawn(tmp.root, [
        { runId: 'run-login', fail: false },
        { runId: 'run-billing', fail: true, linkedTaskIds: ['task-7'] },
      ]);
      const output = await captureStdout(async () => {
        await runPandaTestSuite({
          repoRoot: tmp.root,
          reporter: 'human',
        }, {
          spawnRun: async (options) => {
            forwarded.push(options.forwardOutput);
            return fakeSpawn(options);
          },
        });
      });

      assert.deepEqual(forwarded, [true, true]);
      assert.match(output, /\x1b\[32m\x1b\[1mPASS\x1b\[0m (login-smoke  Login smoke|billing-regression  Billing regression)/);
      assert.match(output, /\x1b\[31m\x1b\[1mFAIL\x1b\[0m (login-smoke  Login smoke|billing-regression  Billing regression)/);
      assert.match(output, /\x1b\[31mIssue task-7: Billing issue\x1b\[0m/);
      assert.match(output, /\x1b\[31mBilling regression is still reproducible\.\x1b\[0m/);
      assert.match(output, /Panda test results/);
      assert.match(output, /Suite summary/);
      assert.match(output, /\x1b\[32m1\x1b\[0m passed/);
      assert.match(output, /\x1b\[31m1\x1b\[0m failed/);
    } finally {
      tmp.cleanup();
    }
  });

  it('builds JUnit output from a suite result', () => {
    const xml = buildJUnitReport({
      suite: { total: 2, failed: 1, errors: 1, durationMs: 1234 },
      tests: [
        { id: 'login-smoke', status: 'passed', durationMs: 200, failures: [], message: 'Passed.', stderr: '', stdout: '' },
        { id: 'billing-regression', status: 'failed', durationMs: 300, failures: [{ step: 'Submit form', expectedResult: 'Saved', actualResult: '500' }], message: 'Observed failure', stderr: '', stdout: '' },
      ],
    });

    assert.match(xml, /testsuite name="qapanda-panda-tests"/);
    assert.match(xml, /testcase classname="qapanda.panda" name="login-smoke"/);
    assert.match(xml, /failure message="Observed failure"/);
  });
});
