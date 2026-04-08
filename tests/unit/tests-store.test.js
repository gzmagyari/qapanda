const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir } = require('../helpers/test-utils');
const { loadTasksData, loadTestsData } = require('../../src/tests-store');

describe('tests store', () => {
  it('returns empty data for missing stores', () => {
    const tmp = createTempDir();
    try {
      assert.deepEqual(loadTestsData(path.join(tmp.root, '.qpanda', 'tests.json')), {
        nextId: 1,
        nextStepId: 1,
        nextRunId: 1,
        tests: [],
      });
      assert.deepEqual(loadTasksData(path.join(tmp.root, '.qpanda', 'tasks.json')), {
        nextId: 1,
        nextCommentId: 1,
        nextProgressId: 1,
        tasks: [],
      });
    } finally {
      tmp.cleanup();
    }
  });

  it('throws when tests.json is unreadable or malformed', () => {
    const tmp = createTempDir();
    try {
      const filePath = path.join(tmp.root, '.qpanda', 'tests.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{not-json', 'utf8');
      assert.throws(() => loadTestsData(filePath), SyntaxError);
    } finally {
      tmp.cleanup();
    }
  });

  it('throws when tasks.json is unreadable or malformed', () => {
    const tmp = createTempDir();
    try {
      const filePath = path.join(tmp.root, '.qpanda', 'tasks.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{not-json', 'utf8');
      assert.throws(() => loadTasksData(filePath), SyntaxError);
    } finally {
      tmp.cleanup();
    }
  });
});
