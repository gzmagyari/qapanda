const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  encodeClaudeProjectDir,
  sanitizeClaudeSessionImagesForResume,
} = require('../../src/claude-session-sanitizer');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-claude-session-'));
}

function pngBase64(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString('base64');
}

function writeClaudeSession(homeDir, repoRoot, sessionId, imageData) {
  const sessionDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(repoRoot));
  fs.mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  const record = {
    type: 'user',
    cwd: repoRoot,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_test',
          content: [
            { type: 'text', text: 'Took a screenshot.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
          ],
        },
      ],
    },
    toolUseResult: [
      { type: 'text', text: 'Took a screenshot.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
    ],
  };
  fs.writeFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return filePath;
}

describe('Claude session image sanitizer', () => {
  it('replaces oversized persisted image blocks before resume', async () => {
    const root = tempRoot();
    const homeDir = path.join(root, 'home');
    const repoRoot = path.join(root, 'repo');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const filePath = writeClaudeSession(homeDir, repoRoot, sessionId, pngBase64(560, 2576));

    const stats = await sanitizeClaudeSessionImagesForResume({ homeDir, repoRoot, sessionId });

    assert.equal(stats.changed, true);
    assert.equal(stats.replacedImages, 2);
    assert.equal(stats.changedLines, 1);
    assert.ok(stats.backupPath);
    assert.ok(fs.existsSync(stats.backupPath));
    const repaired = fs.readFileSync(filePath, 'utf8');
    assert.match(repaired, /Image omitted by QA Panda/);
    assert.doesNotMatch(repaired, /"type":"image"/);
  });

  it('leaves compatible image blocks untouched', async () => {
    const root = tempRoot();
    const homeDir = path.join(root, 'home');
    const repoRoot = path.join(root, 'repo');
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const filePath = writeClaudeSession(homeDir, repoRoot, sessionId, pngBase64(1264, 625));

    const before = fs.readFileSync(filePath, 'utf8');
    const stats = await sanitizeClaudeSessionImagesForResume({ homeDir, repoRoot, sessionId });
    const after = fs.readFileSync(filePath, 'utf8');

    assert.equal(stats.changed, false);
    assert.equal(stats.replacedImages, 0);
    assert.equal(stats.backupPath, null);
    assert.equal(after, before);
  });
});
