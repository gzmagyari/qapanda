const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { countJsonlLinesSync, countTranscriptLinesSync } = require('../../src/transcript');
const { countChatLinesSync } = require('../../src/direct-worker-handoff');

describe('jsonl line counting', () => {
  it('counts jsonl lines without full readFileSync loads', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-jsonl-count-'));
    const filePath = path.join(tmpDir, 'sample.jsonl');
    fs.writeFileSync(filePath, ['{"a":1}', '{"b":2}', '{"c":3}'].join('\n') + '\n', 'utf8');

    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedReadFileSync(targetPath, ...args) {
      if (targetPath === filePath) {
        throw new Error(`Unexpected readFileSync on ${targetPath}`);
      }
      return originalReadFileSync.call(this, targetPath, ...args);
    };

    try {
      assert.equal(countJsonlLinesSync(filePath), 3);
      assert.equal(countTranscriptLinesSync(filePath), 3);
      assert.equal(countChatLinesSync(filePath), 3);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('counts a final line even without a trailing newline', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qapanda-jsonl-count-'));
    const filePath = path.join(tmpDir, 'sample.jsonl');
    fs.writeFileSync(filePath, ['{"a":1}', '{"b":2}', '{"c":3}'].join('\n'), 'utf8');

    try {
      assert.equal(countJsonlLinesSync(filePath), 3);
      assert.equal(countTranscriptLinesSync(filePath), 3);
      assert.equal(countChatLinesSync(filePath), 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
