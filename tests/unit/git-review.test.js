const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReviewScopeSummaryLines,
  defaultReviewScope,
  emptyReviewState,
  parseGitStatusPorcelain,
} = require('../../src/git-review');

describe('git review helpers', () => {
  it('parses unstaged, staged, and untracked changes from porcelain status', () => {
    const parsed = parseGitStatusPorcelain([
      ' M src/unstaged.js',
      'M  src/staged.js',
      'MM src/both.js',
      '?? src/new-file.js',
      'R  old-name.js -> src/renamed.js',
    ].join('\n'));

    assert.equal(parsed.hasUnstaged, true);
    assert.equal(parsed.hasStaged, true);
    assert.deepEqual(parsed.unstagedFiles, [
      'src/both.js',
      'src/new-file.js',
      'src/unstaged.js',
    ]);
    assert.deepEqual(parsed.stagedFiles, [
      'src/both.js',
      'src/renamed.js',
      'src/staged.js',
    ]);
  });

  it('derives the default review scope from git state', () => {
    assert.equal(defaultReviewScope({ hasUnstaged: true, hasStaged: true }), 'unstaged');
    assert.equal(defaultReviewScope({ hasUnstaged: false, hasStaged: true }), 'staged');
    assert.equal(defaultReviewScope({ hasUnstaged: false, hasStaged: false }), null);
  });

  it('builds a scoped summary for review prompts', () => {
    const state = {
      ...emptyReviewState(),
      isGitRepo: true,
      hasChanges: true,
      hasUnstaged: true,
      hasStaged: true,
      unstagedCount: 2,
      stagedCount: 1,
      unstagedFiles: ['src/a.js', 'src/b.js'],
      stagedFiles: ['src/c.js'],
    };

    const unstagedSummary = buildReviewScopeSummaryLines(state, 'unstaged', { maxFiles: 5 });
    const bothSummary = buildReviewScopeSummaryLines(state, 'both', { maxFiles: 5 });

    assert.deepEqual(unstagedSummary, [
      'Unstaged changes: 2 file(s).',
      '- src/a.js',
      '- src/b.js',
    ]);
    assert.deepEqual(bothSummary, [
      'Combined review scope: 3 file(s).',
      '- Unstaged: 2 file(s)',
      '- Staged: 1 file(s)',
      '- src/a.js',
      '- src/b.js',
      '- src/c.js',
    ]);
  });
});
