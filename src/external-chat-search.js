const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const { safeJsonParse, truncate } = require('./utils');
const { normalizeFsPath } = require('./external-chat-discovery');
const { normalizeExternalChatRecord } = require('./external-chat-parser');

const DEFAULT_SEARCH_LIMIT = 20;

function fileSessionId(filePath) {
  const base = path.basename(String(filePath || ''), '.jsonl');
  const match = base.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  if (match) return match[1];
  return base;
}

async function listJsonlFilesRecursive(rootDir) {
  const results = [];
  if (!rootDir) return results;
  let entries;
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await listJsonlFilesRecursive(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
      try {
        const stat = await fsp.stat(fullPath);
        results.push({
          filePath: fullPath,
          mtimeMs: Number(stat.mtimeMs) || 0,
        });
      } catch {}
    }
  }
  return results;
}

function buildMatchPreview(text, query) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return truncate(source, 180);
  const haystack = source.toLowerCase();
  const matchIndex = haystack.indexOf(needle);
  if (matchIndex === -1) return truncate(source, 180);

  const contextBefore = 60;
  const contextAfter = 100;
  const start = Math.max(0, matchIndex - contextBefore);
  const end = Math.min(source.length, matchIndex + needle.length + contextAfter);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < source.length ? '...' : '';
  return `${prefix}${source.slice(start, end)}${suffix}`;
}

function buildSearchRoots(provider, homeDir) {
  if (provider === 'codex') {
    return [
      { provider: 'codex', rootDir: path.join(homeDir, '.codex', 'sessions') },
      { provider: 'codex', rootDir: path.join(homeDir, '.codex', 'archived_sessions') },
    ];
  }
  if (provider === 'claude') {
    return [
      { provider: 'claude', rootDir: path.join(homeDir, '.claude', 'projects') },
    ];
  }
  return [
    { provider: 'codex', rootDir: path.join(homeDir, '.codex', 'sessions') },
    { provider: 'codex', rootDir: path.join(homeDir, '.codex', 'archived_sessions') },
    { provider: 'claude', rootDir: path.join(homeDir, '.claude', 'projects') },
  ];
}

async function listCandidateFiles(provider, homeDir) {
  const roots = buildSearchRoots(provider, homeDir);
  const candidates = [];
  for (const root of roots) {
    const files = await listJsonlFilesRecursive(root.rootDir);
    for (const file of files) {
      candidates.push({
        provider: root.provider,
        filePath: file.filePath,
        mtimeMs: file.mtimeMs,
      });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

function buildDescriptor(provider, fileInfo, context, preview) {
  const sessionId = context.sessionId || fileSessionId(fileInfo.filePath);
  return {
    provider,
    sessionId,
    filePath: fileInfo.filePath,
    cwd: context.cwd || null,
    startedAt: context.startedAt || null,
    updatedAt: new Date(fileInfo.mtimeMs || Date.now()).toISOString(),
    preview: preview || '',
    title: preview || `${provider === 'codex' ? 'Codex' : 'Claude'} session ${sessionId}`,
  };
}

async function scanFileForMatch(fileInfo, repoRoot, query) {
  const normalizedRepoRoot = repoRoot ? normalizeFsPath(repoRoot) : null;
  const context = {
    provider: fileInfo.provider,
    sessionId: fileSessionId(fileInfo.filePath),
    cwd: null,
    startedAt: null,
  };
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;

  let preview = '';
  let repoMatches = !normalizedRepoRoot;
  let matchPreview = '';

  const input = fs.createReadStream(fileInfo.filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      const parsed = safeJsonParse(line);
      if (!parsed) continue;

      const messages = [];
      normalizeExternalChatRecord(fileInfo.provider, parsed, context, messages);

      if (normalizedRepoRoot && context.cwd) {
        const normalizedCwd = normalizeFsPath(context.cwd);
        if (!normalizedCwd || normalizedCwd !== normalizedRepoRoot) {
          return null;
        }
        repoMatches = true;
      }

      for (const message of messages) {
        const text = message && message.text ? String(message.text).replace(/\s+/g, ' ').trim() : '';
        if (!text) continue;
        if (!preview) preview = truncate(text, 140);
        if (!repoMatches) continue;
        if (text.toLowerCase().includes(needle)) {
          matchPreview = buildMatchPreview(text, needle);
          return {
            ...buildDescriptor(fileInfo.provider, fileInfo, context, preview),
            matchPreview,
          };
        }
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  if (normalizedRepoRoot && !repoMatches) {
    return null;
  }
  return null;
}

async function searchExternalChatSessions(options = {}) {
  const query = String(options.query || '').trim();
  if (!query) return [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : DEFAULT_SEARCH_LIMIT;
  const homeDir = options.homeDir || os.homedir();
  const candidates = await listCandidateFiles(options.provider || null, homeDir);

  const matches = [];
  for (const fileInfo of candidates) {
    const match = await scanFileForMatch(fileInfo, options.repoRoot, query);
    if (!match) continue;
    matches.push(match);
    if (matches.length >= limit) break;
  }
  return matches;
}

module.exports = {
  DEFAULT_SEARCH_LIMIT,
  buildMatchPreview,
  searchExternalChatSessions,
};
