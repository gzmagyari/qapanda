const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_PREVIEW_FILE_LIMIT = 8;

function emptyReviewState() {
  return {
    isGitRepo: false,
    hasChanges: false,
    hasUnstaged: false,
    hasStaged: false,
    unstagedCount: 0,
    stagedCount: 0,
    unstagedFiles: [],
    stagedFiles: [],
    defaultScope: null,
  };
}

function normalizeStatusPath(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return '';
  if (!text.includes(' -> ')) return text;
  const parts = text.split(' -> ');
  return parts[parts.length - 1].trim();
}

function parseGitStatusPorcelain(raw) {
  const unstaged = new Set();
  const staged = new Set();
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const filePath = normalizeStatusPath(line.slice(3));
    if (!filePath) continue;

    if (x === '?' && y === '?') {
      unstaged.add(filePath);
      continue;
    }

    if (x !== ' ') staged.add(filePath);
    if (y !== ' ') unstaged.add(filePath);
  }

  const unstagedFiles = Array.from(unstaged).sort();
  const stagedFiles = Array.from(staged).sort();

  return {
    hasUnstaged: unstagedFiles.length > 0,
    hasStaged: stagedFiles.length > 0,
    unstagedCount: unstagedFiles.length,
    stagedCount: stagedFiles.length,
    unstagedFiles,
    stagedFiles,
  };
}

function defaultReviewScope(state) {
  if (!state) return null;
  if (state.hasUnstaged) return 'unstaged';
  if (state.hasStaged) return 'staged';
  return null;
}

async function probeGitReviewState(repoRoot) {
  const empty = emptyReviewState();
  if (!repoRoot) return empty;

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {
      windowsHide: true,
      timeout: 10_000,
    });
    if (String(stdout || '').trim() !== 'true') {
      return empty;
    }
  } catch {
    return empty;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'status', '--porcelain=v1', '--untracked-files=all'], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = parseGitStatusPorcelain(stdout);
    return {
      isGitRepo: true,
      hasChanges: parsed.hasUnstaged || parsed.hasStaged,
      hasUnstaged: parsed.hasUnstaged,
      hasStaged: parsed.hasStaged,
      unstagedCount: parsed.unstagedCount,
      stagedCount: parsed.stagedCount,
      unstagedFiles: parsed.unstagedFiles,
      stagedFiles: parsed.stagedFiles,
      defaultScope: defaultReviewScope(parsed),
    };
  } catch {
    return { ...empty, isGitRepo: true };
  }
}

function uniqueFiles(files, limit = DEFAULT_PREVIEW_FILE_LIMIT) {
  return Array.from(new Set(Array.isArray(files) ? files.filter(Boolean) : [])).slice(0, Math.max(0, limit));
}

function buildScopedFileList(reviewState, scope) {
  if (!reviewState) return [];
  if (scope === 'unstaged') return Array.isArray(reviewState.unstagedFiles) ? reviewState.unstagedFiles : [];
  if (scope === 'staged') return Array.isArray(reviewState.stagedFiles) ? reviewState.stagedFiles : [];
  if (scope === 'both') {
    return Array.from(new Set([
      ...(Array.isArray(reviewState.unstagedFiles) ? reviewState.unstagedFiles : []),
      ...(Array.isArray(reviewState.stagedFiles) ? reviewState.stagedFiles : []),
    ]));
  }
  return [];
}

function buildReviewScopeSummaryLines(reviewState, scope, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles)
    ? Math.max(0, options.maxFiles)
    : DEFAULT_PREVIEW_FILE_LIMIT;
  if (!reviewState) return [];

  if (scope === 'unstaged') {
    const preview = uniqueFiles(reviewState.unstagedFiles, maxFiles);
    return [
      `Unstaged changes: ${Number(reviewState.unstagedCount || 0)} file(s).`,
      ...preview.map((file) => `- ${file}`),
      Number(reviewState.unstagedCount || 0) > preview.length
        ? `- ... and ${Number(reviewState.unstagedCount || 0) - preview.length} more`
        : null,
    ].filter(Boolean);
  }

  if (scope === 'staged') {
    const preview = uniqueFiles(reviewState.stagedFiles, maxFiles);
    return [
      `Staged changes: ${Number(reviewState.stagedCount || 0)} file(s).`,
      ...preview.map((file) => `- ${file}`),
      Number(reviewState.stagedCount || 0) > preview.length
        ? `- ... and ${Number(reviewState.stagedCount || 0) - preview.length} more`
        : null,
    ].filter(Boolean);
  }

  if (scope === 'both') {
    const combined = buildScopedFileList(reviewState, 'both');
    const preview = uniqueFiles(combined, maxFiles);
    return [
      `Combined review scope: ${combined.length} file(s).`,
      `- Unstaged: ${Number(reviewState.unstagedCount || 0)} file(s)`,
      `- Staged: ${Number(reviewState.stagedCount || 0)} file(s)`,
      ...preview.map((file) => `- ${file}`),
      combined.length > preview.length
        ? `- ... and ${combined.length - preview.length} more`
        : null,
    ].filter(Boolean);
  }

  return [];
}

module.exports = {
  buildReviewScopeSummaryLines,
  buildScopedFileList,
  defaultReviewScope,
  emptyReviewState,
  parseGitStatusPorcelain,
  probeGitReviewState,
};
