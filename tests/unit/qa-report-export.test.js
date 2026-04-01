const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  artifactDisplayLabel,
  artifactShortBadge,
  defaultQaReportPdfFileName,
  formatArtifactReference,
  statusColor,
  writeQaReportPdf,
} = require('../../extension/qa-report-export');

describe('qa-report-export', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-qa-report-pdf-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('builds a stable default PDF filename', () => {
    const name = defaultQaReportPdfFileName({
      label: 'QA Engineer (Browser)',
      scope: 'session',
      updatedAt: '2026-04-01T12:34:56Z',
    });
    assert.match(name, /QA Engineer \(Browser\) - this-session - 2026-04-01T12-34\.pdf$/);
  });

  it('formats artifact labels and status colors consistently', () => {
    assert.equal(artifactShortBadge('test-28'), '#28');
    assert.equal(artifactDisplayLabel('test', 'test-28'), 'Test #28');
    assert.equal(artifactDisplayLabel('issue', 'task-9'), 'Issue #9');
    assert.equal(formatArtifactReference('task-9'), '#9 (task-9)');
    assert.equal(statusColor('passing'), '#2e7d32');
    assert.equal(statusColor('failing'), '#c62828');
    assert.equal(statusColor('todo'), '#1565c0');
  });

  it('writes a structured QA report PDF', async () => {
    const filePath = path.join(tmpDir, 'qa-report.pdf');
    await writeQaReportPdf(filePath, {
      label: 'QA Engineer (Browser)',
      scope: 'run',
      updatedAt: '2026-04-01T12:34:56Z',
      section: {
        tests: [{
          id: 'test-30',
          title: 'Login works',
          status: 'passing',
          passed: 1,
          failed: 0,
          skipped: 0,
          detail: {
            id: 'test-30',
            title: 'Login works',
            description: 'Valid login should succeed',
            environment: 'browser',
            status: 'passing',
            steps: [{
              description: 'Submit valid credentials',
              expectedResult: 'Dashboard loads',
              actualResult: 'Dashboard loads',
              status: 'pass',
            }],
          },
        }],
        tasks: [{
          id: 'task-30',
          title: 'Track login bug',
          status: 'review',
          itemType: 'bug',
          detail: {
            id: 'task-30',
            title: 'Track login bug',
            status: 'review',
            description: 'Created from the failing test',
            detail_text: 'Investigate auth regression.',
          },
        }],
      },
    });

    const buffer = fs.readFileSync(filePath);
    assert.equal(buffer.subarray(0, 5).toString('utf8'), '%PDF-');
    assert.ok(buffer.length > 500, 'expected a non-trivial PDF payload');
  });
});
