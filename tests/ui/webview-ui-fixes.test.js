const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { currentMode: 'dev', runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});

afterEach(() => {
  wv.cleanup();
});

describe('webview UI fixes', () => {
  it('copies original markdown for normal chat messages', async () => {
    wv.postMessage({ type: 'claude', label: 'QA Engineer (Browser)', text: '**bold** _text_' });
    wv.click('.entry-copy');
    await wv.flush();
    assert.equal(wv.clipboardWrites.at(-1), '**bold** _text_');
  });

  it('copies accumulated streamed raw text', async () => {
    wv.postMessage({ type: 'streamLine', label: 'QA Engineer (Browser)', text: '**First** line' });
    wv.postMessage({ type: 'streamLine', label: 'QA Engineer (Browser)', text: 'Second line' });
    wv.postMessage({ type: 'flushStream' });
    wv.click('.entry-copy');
    await wv.flush();
    assert.equal(wv.clipboardWrites.at(-1), '**First** line\nSecond line');
  });

  it('renders a live entity card that replaces itself and clears', () => {
    wv.postMessage({
      type: 'liveEntityCard',
      label: 'QA Engineer (Browser)',
      entityType: 'test',
      data: { title: 'Consent test', passed: 0, failed: 0, skipped: 1, steps: [{ name: 'Open page', status: 'skip' }] },
    });
    assert.equal(wv.document.querySelectorAll('.section-live-slot .live-entity-card').length, 1);
    assert.match(wv.text('.section-live-slot'), /Consent test/);

    wv.postMessage({
      type: 'liveEntityCard',
      label: 'QA Engineer (Browser)',
      entityType: 'task',
      data: { task_id: 'task-1', title: 'Fix login', status: 'in_progress', description: 'Investigate error banner' },
    });
    assert.equal(wv.document.querySelectorAll('.section-live-slot .live-entity-card').length, 1);
    assert.match(wv.text('.section-live-slot'), /Fix login/);

    wv.postMessage({ type: 'clearLiveEntityCard' });
    assert.equal(wv.document.querySelectorAll('.section-live-slot').length, 0);
  });

  it('renders a live QA report card and replaces it in place', () => {
    wv.postMessage({
      type: 'liveQaReportCard',
      label: 'QA Engineer (Browser)',
      data: {
        updatedAt: '2026-04-01T12:00:00Z',
        run: { tests: [{ id: 'test-1', title: 'Login works', status: 'passing', environment: 'browser', passed: 1, failed: 0, skipped: 0 }], tasks: [], testCount: 1, taskCount: 0 },
        session: { tests: [{ id: 'test-1', title: 'Login works', status: 'passing', environment: 'browser', passed: 1, failed: 0, skipped: 0 }], tasks: [], testCount: 1, taskCount: 0 },
      },
    });
    assert.equal(wv.document.querySelectorAll('.section-live-qa-slot .qa-report-card').length, 1);
    assert.match(wv.text('.section-live-qa-slot'), /QA Report/);
    assert.match(wv.text('.section-live-qa-slot'), /Login works/);

    wv.postMessage({
      type: 'liveQaReportCard',
      label: 'QA Engineer (Browser)',
      data: {
        updatedAt: '2026-04-01T12:01:00Z',
        run: { tests: [{ id: 'test-1', title: 'Login works', status: 'passing', environment: 'browser', passed: 1, failed: 0, skipped: 0 }], tasks: [{ id: 'task-1', title: 'Fix title', status: 'review', itemType: 'bug' }], testCount: 1, taskCount: 1 },
        session: { tests: [{ id: 'test-1', title: 'Login works', status: 'passing', environment: 'browser', passed: 1, failed: 0, skipped: 0 }], tasks: [{ id: 'task-1', title: 'Fix title', status: 'review', itemType: 'bug' }], testCount: 1, taskCount: 1 },
      },
    });
    assert.equal(wv.document.querySelectorAll('.section-live-qa-slot .qa-report-card').length, 1);
    assert.match(wv.text('.section-live-qa-slot'), /Fix title/);
  });

  it('keeps the live entity card at the end of the active section', () => {
    wv.postMessage({ type: 'claude', label: 'QA Engineer (Browser)', text: 'Starting test run' });
    wv.postMessage({
      type: 'liveEntityCard',
      label: 'QA Engineer (Browser)',
      entityType: 'test',
      data: { title: 'Consent test', passed: 0, failed: 0, skipped: 1, steps: [{ name: 'Open page', status: 'skip' }] },
    });

    let section = wv.document.querySelector('.section');
    assert.ok(section, 'section should exist');
    assert.equal(section.lastElementChild.classList.contains('section-live-slot'), true);

    wv.postMessage({ type: 'claude', label: 'QA Engineer (Browser)', text: 'More tool output arrived' });
    section = wv.document.querySelector('.section');
    assert.notEqual(section.lastElementChild.classList.contains('section-live-slot'), true);

    wv.postMessage({
      type: 'liveEntityCard',
      label: 'QA Engineer (Browser)',
      entityType: 'test',
      data: { title: 'Consent test', passed: 1, failed: 0, skipped: 0, steps: [{ name: 'Open page', status: 'pass' }] },
    });
    section = wv.document.querySelector('.section');
    assert.equal(section.lastElementChild.classList.contains('section-live-slot'), true);
  });

  it('uses a multiline textarea for task description', () => {
    wv.click('[data-tab="tasks"]');
    wv.postMessage({ type: 'tasksData', tasks: [] });
    wv.click('.kanban-toolbar .mcp-btn.mcp-btn-primary');
    const desc = wv.document.getElementById('task-f-desc');
    assert.ok(desc, 'description field should exist');
    assert.equal(desc.tagName, 'TEXTAREA');
    assert.equal(desc.getAttribute('rows'), '3');
  });

  it('copies issue cards from the Issues tab without opening the detail view', async () => {
    wv.click('[data-tab="tasks"]');
    wv.postMessage({
      type: 'tasksData',
      tasks: [{
        id: 'task-1',
        title: 'Fix login',
        status: 'todo',
        description: 'Short summary',
        detail_text: 'Detailed notes',
        comments: [{ id: 1, author: 'Agent', text: 'Comment', created_at: '2026-03-31T10:00:00Z' }],
        progress_updates: [],
        created_at: '2026-03-31T10:00:00Z',
        updated_at: '2026-03-31T10:00:00Z',
      }],
    });
    assert.match(wv.text('#tab-tasks'), /#1/);
    assert.match(wv.text('#tab-tasks'), /task-1/);
    wv.click('.kanban-card-copy');
    await wv.flush();
    assert.match(wv.clipboardWrites.at(-1), /\[Issue #1 \| task-1\] Fix login/);
    assert.notEqual(wv.document.getElementById('kanban-board').style.display, 'none');
  });

  it('copies test cards from the Tests tab', async () => {
    wv.click('[data-tab="tests"]');
    wv.postMessage({
      type: 'testsData',
      tests: [{
        id: 'test-1',
        title: 'Consent dialog',
        status: 'passing',
        environment: 'browser',
        description: 'Verify the dialog',
        tags: ['ui'],
        linkedTaskIds: ['task-1'],
        lastTestedAt: '2026-03-31T10:00:00Z',
        steps: [{
          id: 'step-1',
          description: 'Open Google',
          expectedResult: 'Consent dialog visible',
          actualResult: 'Dialog visible',
          status: 'pass',
        }],
      }],
    });
    wv.click('.kanban-card-copy');
    await wv.flush();
    assert.match(wv.clipboardWrites.at(-1), /\[Test #1 \| test-1\] Consent dialog/);
    assert.match(wv.clipboardWrites.at(-1), /Linked Issues: #1 \(task-1\)/);
  });

  it('test detail view shows the short badge and raw id', () => {
    wv.click('[data-tab="tests"]');
    wv.postMessage({
      type: 'testsData',
      tests: [{
        id: 'test-28',
        title: 'Protected route redirects',
        status: 'failing',
        environment: 'browser',
        description: 'Verify logout blocks access',
        tags: [],
        linkedTaskIds: [],
        lastTestedAt: '2026-03-31T10:00:00Z',
        steps: [],
      }],
    });
    wv.click('.test-card');
    assert.match(wv.text('#test-detail'), /#28/);
    assert.match(wv.text('#test-detail'), /test-28/);
  });

  it('copies structured text from chat task cards', async () => {
    wv.postMessage({
      type: 'taskCard',
      label: 'Developer',
      data: {
        task_id: 'task-7',
        title: 'Fix login',
        status: 'review',
        description: 'Short summary',
        detail_text: 'Detailed notes',
        comments_count: 2,
        progress_updates_count: 1,
      },
    });
    assert.match(wv.text('.task-card-entry'), /#7/);
    assert.match(wv.text('.task-card-entry'), /task-7/);
    wv.click('.task-card-entry .entity-card-copy');
    await wv.flush();
    const copied = wv.clipboardWrites.at(-1);
    assert.match(copied, /\[Issue #7 \| task-7\] Fix login/);
    assert.match(copied, /Status: review/);
    assert.match(copied, /Details: Detailed notes/);
  });

  it('copies structured text from chat test cards', async () => {
    wv.postMessage({
      type: 'testCard',
      label: 'QA Engineer (Browser)',
      data: {
        test_id: 'test-9',
        title: 'Consent dialog',
        environment: 'browser',
        status: 'passing',
        description: 'Verify the dialog',
        linkedTaskIds: ['task-1'],
        passed: 1,
        failed: 0,
        skipped: 0,
        steps: [{
          name: 'Open Google',
          expectedResult: 'Consent dialog visible',
          actualResult: 'Dialog visible',
          status: 'pass',
        }],
      },
    });
    assert.match(wv.text('.test-card-entry'), /#9/);
    assert.match(wv.text('.test-card-entry'), /test-9/);
    wv.click('.test-card-entry .entity-card-copy');
    await wv.flush();
    const copied = wv.clipboardWrites.at(-1);
    assert.match(copied, /\[Test #9 \| test-9\] Consent dialog/);
    assert.match(copied, /Linked Issues: #1 \(task-1\)/);
    assert.match(copied, /Expected: Consent dialog visible/);
  });

  it('renders a final QA report card and opens detail overlays from clickable rows', () => {
    wv.postMessage({
      type: 'qaReportCard',
      label: 'QA Engineer (Browser)',
      data: {
        updatedAt: '2026-04-01T12:02:00Z',
        run: {
          testCount: 1,
          taskCount: 1,
          tests: [{
            id: 'test-4',
            title: 'Protected route redirects',
            status: 'failing',
            environment: 'browser',
            passed: 0,
            failed: 1,
            skipped: 0,
            detail: {
              id: 'test-4',
              title: 'Protected route redirects',
              description: 'Verify logout blocks access',
              environment: 'browser',
              status: 'failing',
              linkedTaskIds: ['task-8'],
              steps: [{ id: 'step-1', description: 'Open /strategies', expectedResult: 'Redirect to /login', actualResult: 'Stayed on /strategies', status: 'fail' }],
            },
          }],
          tasks: [{
            id: 'task-8',
            title: 'Fix protected route redirect',
            status: 'review',
            itemType: 'bug',
            description: 'Created from the failing test',
            detail: {
              id: 'task-8',
              title: 'Fix protected route redirect',
              status: 'review',
              description: 'Created from the failing test',
              detail_text: 'Investigate auth guard handling after logout.',
              comments: [{ id: 1, author: 'QA', text: 'Observed after logout', created_at: '2026-04-01T12:00:00Z' }],
              progress_updates: [],
            },
          }],
        },
        session: {
          testCount: 1,
          taskCount: 1,
          tests: [{
            id: 'test-4',
            title: 'Protected route redirects',
            status: 'failing',
            environment: 'browser',
            passed: 0,
            failed: 1,
            skipped: 0,
            detail: {
              id: 'test-4',
              title: 'Protected route redirects',
              description: 'Verify logout blocks access',
              environment: 'browser',
              status: 'failing',
              linkedTaskIds: ['task-8'],
              steps: [{ id: 'step-1', description: 'Open /strategies', expectedResult: 'Redirect to /login', actualResult: 'Stayed on /strategies', status: 'fail' }],
            },
          }],
          tasks: [{
            id: 'task-8',
            title: 'Fix protected route redirect',
            status: 'review',
            itemType: 'bug',
            description: 'Created from the failing test',
            detail: {
              id: 'task-8',
              title: 'Fix protected route redirect',
              status: 'review',
              description: 'Created from the failing test',
              detail_text: 'Investigate auth guard handling after logout.',
              comments: [{ id: 1, author: 'QA', text: 'Observed after logout', created_at: '2026-04-01T12:00:00Z' }],
              progress_updates: [],
            },
          }],
        },
      },
    });

    assert.match(wv.text('.qa-report-card-entry'), /This Run/);
    assert.match(wv.text('.qa-report-card-entry'), /This Session/);
    wv.click('.qa-report-card-entry .qa-report-row[data-qa-kind="test"]');
    assert.match(wv.text('.agent-report-overlay-panel'), /Protected route redirects/);
    assert.match(wv.text('.agent-report-overlay-panel'), /Redirect to \/login/);
    wv.click('.agent-report-overlay-close');
    assert.equal(wv.document.querySelector('.agent-report-overlay'), null);

    wv.click('.qa-report-card-entry .qa-report-tab[data-qa-tab="session"]');
    wv.click('.qa-report-card-entry .qa-report-row[data-qa-kind="task"]');
    assert.match(wv.text('.agent-report-overlay-panel'), /Fix protected route redirect/);
    assert.match(wv.text('.agent-report-overlay-panel'), /Investigate auth guard handling after logout\./);
  });

  it('supports QA report row copy, overlay copy, bulk copy, and PDF export for the active tab', async () => {
    wv.postMessage({
      type: 'qaReportCard',
      label: 'QA Engineer (Browser)',
      data: {
        updatedAt: '2026-04-01T12:02:00Z',
        run: {
          testCount: 2,
          taskCount: 1,
          tests: [{
            id: 'test-10',
            title: 'Happy path login',
            status: 'passing',
            environment: 'browser',
            passed: 2,
            failed: 0,
            skipped: 0,
            detail: {
              id: 'test-10',
              title: 'Happy path login',
              environment: 'browser',
              status: 'passing',
              description: 'Valid credentials succeed',
              linkedTaskIds: [],
              steps: [{ description: 'Submit valid credentials', expectedResult: 'Dashboard loads', actualResult: 'Dashboard loads', status: 'pass' }],
            },
          }, {
            id: 'test-11',
            title: 'Validation blocks bad email',
            status: 'failing',
            environment: 'browser',
            passed: 0,
            failed: 1,
            skipped: 0,
            detail: {
              id: 'test-11',
              title: 'Validation blocks bad email',
              environment: 'browser',
              status: 'failing',
              description: 'Bad email should show validation',
              linkedTaskIds: ['task-11'],
              steps: [{ description: 'Enter invalid email', expectedResult: 'Validation appears', actualResult: 'No validation', status: 'fail' }],
            },
          }],
          tasks: [{
            id: 'task-11',
            title: 'Fix invalid-email validation',
            status: 'review',
            itemType: 'bug',
            description: 'Created from failing test',
            detail: {
              id: 'task-11',
              title: 'Fix invalid-email validation',
              status: 'review',
              description: 'Created from failing test',
              detail_text: 'Investigate email validation lifecycle.',
              comments: [],
              progress_updates: [],
            },
          }],
        },
        session: {
          testCount: 1,
          taskCount: 1,
          tests: [{
            id: 'test-12',
            title: 'Session-only passing test',
            status: 'passing',
            environment: 'browser',
            passed: 1,
            failed: 0,
            skipped: 0,
            detail: {
              id: 'test-12',
              title: 'Session-only passing test',
              environment: 'browser',
              status: 'passing',
              steps: [],
            },
          }],
          tasks: [{
            id: 'task-12',
            title: 'Session-only task',
            status: 'todo',
            itemType: 'task',
            detail: {
              id: 'task-12',
              title: 'Session-only task',
              status: 'todo',
              description: 'Session task',
              detail_text: 'Needs follow-up.',
              comments: [],
              progress_updates: [],
            },
          }],
        },
      },
    });

    assert.match(wv.text('.qa-report-card-entry'), /Copy all issues/);
    assert.match(wv.text('.qa-report-card-entry'), /Export PDF/);

    wv.click('.qa-report-card-entry .qa-report-row-copy[data-qa-copy-kind="test"][data-qa-copy-id="test-10"]');
    await wv.flush();
    assert.match(wv.clipboardWrites.at(-1), /\[Test #10 \| test-10\] Happy path login/);
    assert.equal(wv.document.querySelector('.agent-report-overlay'), null);

    wv.click('.qa-report-card-entry .qa-report-row[data-qa-kind="test"][data-qa-id="test-11"]');
    assert.match(wv.text('.agent-report-overlay-panel'), /Validation blocks bad email/);
    wv.click('.agent-report-overlay-copy');
    await wv.flush();
    assert.match(wv.clipboardWrites.at(-1), /\[Test #11 \| test-11\] Validation blocks bad email/);
    wv.click('.agent-report-overlay-close');

    wv.click('.qa-report-card-entry .qa-report-action[data-qa-action="copy-all-tests"]');
    await wv.flush();
    const allTests = wv.clipboardWrites.at(-1);
    assert.match(allTests, /\[Test #10 \| test-10\] Happy path login/);
    assert.match(allTests, /\[Test #11 \| test-11\] Validation blocks bad email/);
    assert.match(allTests, /==========/);

    wv.click('.qa-report-card-entry .qa-report-action[data-qa-action="copy-failing-tests"]');
    await wv.flush();
    const failingTests = wv.clipboardWrites.at(-1);
    assert.doesNotMatch(failingTests, /\[Test #10 \| test-10\]/);
    assert.match(failingTests, /\[Test #11 \| test-11\]/);

    wv.click('.qa-report-card-entry .qa-report-action[data-qa-action="copy-all-tasks"]');
    await wv.flush();
    assert.match(wv.clipboardWrites.at(-1), /\[Issue #11 \| task-11\] Fix invalid-email validation/);

    wv.click('.qa-report-card-entry .qa-report-action[data-qa-action="download-pdf"]');
    const pdfMessage = wv.messagesOfType('qaReportExportPdf').at(-1);
    assert.equal(pdfMessage.scope, 'run');
    assert.equal(pdfMessage.section.tests.length, 2);
    assert.equal(pdfMessage.section.tasks.length, 1);

    wv.click('.qa-report-card-entry .qa-report-tab[data-qa-tab="session"]');
    assert.equal(wv.document.querySelector('.qa-report-card-entry .qa-report-action[data-qa-action="copy-failing-tests"]').disabled, true);
    wv.click('.qa-report-card-entry .qa-report-action[data-qa-action="copy-all-tests"]');
    await wv.flush();
    const sessionTests = wv.clipboardWrites.at(-1);
    assert.match(sessionTests, /\[Test #12 \| test-12\] Session-only passing test/);
    assert.doesNotMatch(sessionTests, /\[Test #10 \| test-10\]/);
  });

  it('restores QA report cards from transcript history entries', () => {
    wv.postMessage({
      type: 'transcriptHistory',
      messages: [{
        type: 'qaReportCard',
        label: 'QA Engineer (Browser)',
        data: {
          updatedAt: '2026-04-01T12:05:00Z',
          run: { testCount: 1, taskCount: 0, tests: [{ id: 'test-7', title: 'Session restore', status: 'passing', environment: 'browser', passed: 1, failed: 0, skipped: 0, detail: { id: 'test-7', title: 'Session restore', steps: [] } }], tasks: [] },
          session: { testCount: 1, taskCount: 0, tests: [{ id: 'test-7', title: 'Session restore', status: 'passing', environment: 'browser', passed: 1, failed: 0, skipped: 0, detail: { id: 'test-7', title: 'Session restore', steps: [] } }], tasks: [] },
        },
      }],
    });
    assert.match(wv.text('.qa-report-card-entry'), /Session restore/);
    wv.click('.qa-report-card-entry .qa-report-row-copy[data-qa-copy-kind="test"]');
    assert.match(wv.clipboardWrites.at(-1), /\[Test #7 \| test-7\] Session restore/);
    wv.click('.qa-report-card-entry .qa-report-row[data-qa-kind="test"]');
    assert.match(wv.text('.agent-report-overlay-panel'), /Session restore/);
  });
});
