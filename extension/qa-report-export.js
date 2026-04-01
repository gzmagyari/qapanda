const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

function sanitizeFileSegment(value, fallback) {
  const base = String(value || fallback || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base || fallback || 'qa-report';
}

function qaScopeTitle(scope) {
  return scope === 'session' ? 'This Session' : 'This Run';
}

function ensurePdfExtension(filePath) {
  return /\.pdf$/i.test(filePath) ? filePath : `${filePath}.pdf`;
}

function defaultQaReportPdfFileName({ label, scope, updatedAt }) {
  const title = sanitizeFileSegment(label, 'QA Report');
  const suffix = scope === 'session' ? 'this-session' : 'this-run';
  const stamp = String(updatedAt || '')
    .replace(/[:]/g, '-')
    .replace(/[^\dTZ-]/g, '')
    .replace(/T$/, '')
    .slice(0, 16);
  const parts = [title, suffix];
  if (stamp) parts.push(stamp);
  return `${parts.join(' - ')}.pdf`;
}

function text(value, fallback = '') {
  const normalized = value == null ? fallback : value;
  return String(normalized == null ? '' : normalized);
}

function artifactRawId(value) {
  return text(value).trim();
}

function artifactNumericSuffix(value) {
  const match = artifactRawId(value).match(/(\d+)(?!.*\d)/);
  return match ? match[1] : '';
}

function artifactShortBadge(value) {
  const raw = artifactRawId(value);
  if (!raw) return '';
  const suffix = artifactNumericSuffix(raw);
  return suffix ? `#${suffix}` : raw;
}

function artifactDisplayLabel(kind, id) {
  const raw = artifactRawId(id);
  const label = kind === 'test' ? 'Test' : 'Issue';
  const badge = artifactShortBadge(raw);
  if (!raw) return label;
  return badge && badge !== raw ? `${label} ${badge}` : `${label} ${raw}`;
}

function formatArtifactReference(value) {
  const raw = artifactRawId(value);
  if (!raw) return '';
  const badge = artifactShortBadge(raw);
  return badge && badge !== raw ? `${badge} (${raw})` : raw;
}

function statusColor(status) {
  const normalized = text(status).toLowerCase();
  if (['pass', 'passed', 'passing', 'done'].includes(normalized)) return '#2e7d32';
  if (['fail', 'failed', 'failing', 'review'].includes(normalized)) return '#c62828';
  if (['in_progress', 'partial', 'running', 'testing'].includes(normalized)) return '#ef6c00';
  if (['todo', 'backlog', 'untested'].includes(normalized)) return '#1565c0';
  return '#455a64';
}

function writeDivider(doc, color = '#d7dee6') {
  const y = doc.y;
  doc.save();
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.75)
    .strokeColor(color)
    .stroke();
  doc.restore();
  doc.moveDown(0.6);
}

function writeLabeledText(doc, label, value, options = {}) {
  const labelColor = options.labelColor || '#23404f';
  const valueColor = options.valueColor || '#263238';
  const fontSize = options.fontSize || 11;
  doc.fontSize(fontSize);
  doc.font('Helvetica-Bold').fillColor(labelColor).text(label, { continued: true });
  doc.font('Helvetica').fillColor(valueColor).text(value || '—');
}

function writeSectionHeading(doc, title, color) {
  doc.font('Helvetica-Bold').fontSize(15).fillColor(color).text(title);
  doc.moveDown(0.25);
}

function writeTestCounts(doc, item) {
  const passed = item && item.passed ? item.passed : 0;
  const failed = item && item.failed ? item.failed : 0;
  const skipped = item && item.skipped ? item.skipped : 0;
  doc.fontSize(10);
  doc.font('Helvetica-Bold').fillColor('#2e7d32').text(`${passed} passed`, { continued: true });
  doc.font('Helvetica').fillColor('#607d8b').text('  ·  ', { continued: true });
  doc.font('Helvetica-Bold').fillColor('#c62828').text(`${failed} failed`, { continued: true });
  doc.font('Helvetica').fillColor('#607d8b').text('  ·  ', { continued: true });
  doc.font('Helvetica-Bold').fillColor('#546e7a').text(`${skipped} skipped`);
}

function writeArtifactHeader(doc, kind, item, index) {
  const detail = item && item.detail ? item.detail : (item || {});
  const rawId = detail.id || item.id;
  const displayLabel = artifactDisplayLabel(kind, rawId);
  const title = text(detail.title || item.title, kind === 'test' ? 'Test' : 'Issue');
  const normalizedStatus = text(detail.status || item.status || (kind === 'test' ? 'untested' : 'todo')).replace(/_/g, ' ');
  const color = statusColor(detail.status || item.status);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(color)
    .text(`${index + 1}. ${displayLabel}${rawId ? ` | ${rawId}` : ''}`);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111111').text(title);
  writeLabeledText(doc, 'Status: ', normalizedStatus, { valueColor: color });
}

function writeTestSection(doc, tests) {
  writeSectionHeading(doc, `Tests (${tests.length})`, '#1976d2');
  if (!tests.length) {
    doc.font('Helvetica').fontSize(11).fillColor('#607d8b').text('No tests in this section.');
    doc.moveDown(0.8);
    return;
  }

  tests.forEach((item, index) => {
    const detail = item && item.detail ? item.detail : (item || {});
    writeArtifactHeader(doc, 'test', item, index);
    if (detail.environment) writeLabeledText(doc, 'Environment: ', text(detail.environment, 'browser'));
    writeTestCounts(doc, item);
    const description = text(detail.description, '').trim();
    if (description) {
      writeLabeledText(doc, 'Description: ', description);
    }
    const linkedTaskIds = Array.isArray(detail.linkedTaskIds) ? detail.linkedTaskIds : [];
    if (linkedTaskIds.length) {
      writeLabeledText(doc, 'Linked Issues: ', linkedTaskIds.map(formatArtifactReference).join(', '));
    }
    const steps = Array.isArray(detail.steps) ? detail.steps : [];
    if (steps.length) {
      doc.moveDown(0.25);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#23404f').text('Steps');
      steps.forEach((step, stepIndex) => {
        const stepStatus = text(step.status, 'unknown');
        const stepColor = statusColor(stepStatus);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(stepColor)
          .text(`${stepIndex + 1}. [${stepStatus}] ${text(step.name || step.description, '(unnamed step)')}`);
        if (step.expectedResult) {
          writeLabeledText(doc, 'Expected: ', text(step.expectedResult), { fontSize: 10, labelColor: '#455a64', valueColor: '#37474f' });
        }
        if (step.actualResult) {
          writeLabeledText(doc, 'Actual: ', text(step.actualResult), { fontSize: 10, labelColor: '#455a64', valueColor: '#37474f' });
        }
      });
    }
    doc.moveDown(0.6);
    writeDivider(doc, '#dbe7f4');
  });
}

function writeIssueSection(doc, tasks) {
  writeSectionHeading(doc, `Issues (${tasks.length})`, '#8e24aa');
  if (!tasks.length) {
    doc.font('Helvetica').fontSize(11).fillColor('#607d8b').text('No issues in this section.');
    doc.moveDown(0.8);
    return;
  }

  tasks.forEach((item, index) => {
    const detail = item && item.detail ? item.detail : (item || {});
    const itemType = text(item && item.itemType, 'task');
    writeArtifactHeader(doc, 'issue', item, index);
    writeLabeledText(doc, 'Type: ', itemType === 'bug' ? 'bug' : 'issue', { valueColor: itemType === 'bug' ? '#ef6c00' : '#1565c0' });
    const description = text(detail.description || item.description, '').trim();
    if (description) {
      writeLabeledText(doc, 'Description: ', description);
    }
    const detailText = text(detail.detail_text, '').trim();
    if (detailText) {
      writeLabeledText(doc, 'Details: ', detailText);
    }
    const linkedTestIds = Array.isArray(item && item.linkedTestIds)
      ? item.linkedTestIds
      : (Array.isArray(detail && detail.linkedTestIds) ? detail.linkedTestIds : []);
    if (linkedTestIds.length) {
      writeLabeledText(doc, 'Linked Tests: ', linkedTestIds.map(formatArtifactReference).join(', '));
    }
    doc.moveDown(0.6);
    writeDivider(doc, '#eadbf1');
  });
}

function writeQaReportPdf(filePath, payload) {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const doc = new PDFDocument({ margin: 48, size: 'A4' });
      const stream = fs.createWriteStream(filePath);
      const section = payload && payload.section ? payload.section : {};
      const tests = Array.isArray(section.tests) ? section.tests : [];
      const tasks = Array.isArray(section.tasks) ? section.tasks : [];

      stream.on('finish', resolve);
      stream.on('error', reject);
      doc.on('error', reject);

      doc.pipe(stream);
      doc.info.Title = text(payload && payload.label, 'QA Report');
      doc.info.Subject = `QA Report - ${qaScopeTitle(payload && payload.scope)}`;

      doc.font('Helvetica-Bold').fontSize(22).fillColor('#0f766e')
        .text(text(payload && payload.label, 'QA Report'));
      doc.moveDown(0.15);
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#134e4a')
        .text(qaScopeTitle(payload && payload.scope));
      if (payload && payload.updatedAt) {
        doc.font('Helvetica').fontSize(11).fillColor('#546e7a')
          .text(`Updated: ${new Date(payload.updatedAt).toLocaleString()}`);
      }
      doc.moveDown(0.4);
      writeDivider(doc, '#9bd9d1');
      writeLabeledText(doc, 'Tests: ', String(tests.length), { valueColor: '#1976d2' });
      writeLabeledText(doc, 'Issues: ', String(tasks.length), { valueColor: '#8e24aa' });
      doc.moveDown(0.8);

      writeTestSection(doc, tests);
      writeIssueSection(doc, tasks);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function exportQaReportPdf({ repoRoot, label, scope, updatedAt, section }) {
  const vscode = require('vscode');
  const defaultUri = vscode.Uri.file(path.join(
    repoRoot || process.cwd(),
    defaultQaReportPdfFileName({ label, scope, updatedAt })
  ));
  const saveUri = await vscode.window.showSaveDialog({
    saveLabel: 'Save QA Report PDF',
    defaultUri,
    filters: {
      PDF: ['pdf'],
    },
  });
  if (!saveUri) {
    return { canceled: true };
  }
  const filePath = ensurePdfExtension(saveUri.fsPath);
  await writeQaReportPdf(filePath, { label, scope, updatedAt, section });
  return { canceled: false, filePath };
}

module.exports = {
  artifactDisplayLabel,
  artifactShortBadge,
  defaultQaReportPdfFileName,
  exportQaReportPdf,
  formatArtifactReference,
  statusColor,
  writeQaReportPdf,
};
