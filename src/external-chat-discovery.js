const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { safeJsonParse, truncate } = require('./utils');

const DEFAULT_DISCOVERY_LIMIT = 50;
const DISCOVERY_PEEK_BYTES = 256 * 1024;

function normalizeFsPath(value) {
  if (!value) return null;
  const resolved = path.resolve(String(value));
  return process.platform === 'win32'
    ? resolved.replace(/\//g, '\\').toLowerCase()
    : resolved;
}

function fileSessionId(filePath) {
  const base = path.basename(String(filePath || ''), '.jsonl');
  const match = base.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  if (match) return match[1];
  return base;
}

function extractTextBlocks(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('');
}

function extractCodexTextFromRecord(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'message' && Array.isArray(record.content)) {
    return extractTextBlocks(record.content);
  }
  if (record.type === 'response_item' && record.payload && record.payload.type === 'message') {
    return extractTextBlocks(record.payload.content);
  }
  if (record.type === 'event_msg' && record.payload && typeof record.payload.message === 'string') {
    return String(record.payload.message);
  }
  return '';
}

function extractClaudePreviewText(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.type === 'user' && record.message) {
    return extractTextBlocks(record.message.content);
  }
  if (record.type === 'assistant' && record.message && Array.isArray(record.message.content)) {
    return record.message.content
      .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function isEnvironmentContextOnly(text) {
  const trimmed = String(text || '').trim();
  return !!trimmed && /^<environment_context>[\s\S]*<\/environment_context>$/i.test(trimmed);
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

function readPrefixText(filePath, bytes = DISCOVERY_PEEK_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const size = Math.min(Number(stat.size) || 0, Math.max(1, Number(bytes) || DISCOVERY_PEEK_BYTES));
    if (size <= 0) return '';
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function extractCodexSessionMeta(prefixText, filePath) {
  const lines = String(prefixText || '').split(/\r?\n/);
  let sessionId = fileSessionId(filePath);
  let cwd = null;
  let startedAt = null;
  let preview = '';

  for (const line of lines) {
    if (!line) continue;
    const parsed = safeJsonParse(line);
    if (!parsed) continue;

    if (!startedAt && typeof parsed.timestamp === 'string') {
      startedAt = parsed.timestamp;
    }

    if (parsed.type === 'session_meta' && parsed.payload && typeof parsed.payload === 'object') {
      if (parsed.payload.id) sessionId = String(parsed.payload.id);
      if (parsed.payload.cwd) cwd = String(parsed.payload.cwd);
      if (parsed.payload.timestamp && !startedAt) startedAt = String(parsed.payload.timestamp);
      continue;
    }

    if (parsed.type === 'turn_context' && parsed.payload && parsed.payload.cwd && !cwd) {
      cwd = String(parsed.payload.cwd);
      continue;
    }

    const text = extractCodexTextFromRecord(parsed);
    if (text && !preview && !isEnvironmentContextOnly(text)) {
      preview = truncate(text.replace(/\s+/g, ' ').trim(), 140);
    }
    if (!cwd && text) {
      const match = text.match(/<cwd>([^<]+)<\/cwd>/i);
      if (match) cwd = match[1].trim();
    }
  }

  return { sessionId, cwd, startedAt, preview };
}

function extractClaudeSessionMeta(prefixText, filePath) {
  const lines = String(prefixText || '').split(/\r?\n/);
  let sessionId = fileSessionId(filePath);
  let cwd = null;
  let startedAt = null;
  let preview = '';

  for (const line of lines) {
    if (!line) continue;
    const parsed = safeJsonParse(line);
    if (!parsed) continue;

    if (!startedAt && typeof parsed.timestamp === 'string') {
      startedAt = parsed.timestamp;
    }
    if (!cwd && parsed.cwd) {
      cwd = String(parsed.cwd);
    }
    if (!sessionId && parsed.sessionId) {
      sessionId = String(parsed.sessionId);
    }
    if (!preview) {
      const text = extractClaudePreviewText(parsed);
      if (text && !isEnvironmentContextOnly(text)) {
        preview = truncate(text.replace(/\s+/g, ' ').trim(), 140);
      }
    }
  }

  return { sessionId, cwd, startedAt, preview };
}

function buildDescriptor(provider, fileInfo, meta) {
  return {
    provider,
    sessionId: meta.sessionId || fileSessionId(fileInfo.filePath),
    filePath: fileInfo.filePath,
    cwd: meta.cwd || null,
    startedAt: meta.startedAt || null,
    updatedAt: new Date(fileInfo.mtimeMs || Date.now()).toISOString(),
    preview: meta.preview || '',
    title: meta.preview || `${provider === 'codex' ? 'Codex' : 'Claude'} session ${meta.sessionId || fileSessionId(fileInfo.filePath)}`,
  };
}

async function discoverProviderSessions(provider, rootDir, repoRoot, extractor, { limit = DEFAULT_DISCOVERY_LIMIT, sessionId = null } = {}) {
  const normalizedRepoRoot = normalizeFsPath(repoRoot);
  const wantedSessionId = sessionId ? String(sessionId).trim() : '';
  const files = await listJsonlFilesRecursive(rootDir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const matches = [];
  for (const fileInfo of files) {
    const prefix = readPrefixText(fileInfo.filePath);
    const meta = extractor(prefix, fileInfo.filePath);
    if (wantedSessionId && String(meta.sessionId || '') !== wantedSessionId) {
      continue;
    }
    const normalizedCwd = normalizeFsPath(meta.cwd);
    if (normalizedRepoRoot && normalizedCwd && normalizedRepoRoot !== normalizedCwd) {
      continue;
    }
    if (normalizedRepoRoot && !normalizedCwd) {
      continue;
    }
    matches.push(buildDescriptor(provider, fileInfo, meta));
    if (wantedSessionId && matches.length > 0) {
      break;
    }
    if (!wantedSessionId && matches.length >= limit) {
      break;
    }
  }
  return matches;
}

async function discoverCodexSessions(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const roots = [
    path.join(homeDir, '.codex', 'sessions'),
    path.join(homeDir, '.codex', 'archived_sessions'),
  ];
  const all = [];
  for (const rootDir of roots) {
    all.push(...await discoverProviderSessions('codex', rootDir, options.repoRoot, extractCodexSessionMeta, options));
    if (options.sessionId && all.length > 0) break;
  }
  all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return all.slice(0, options.limit || DEFAULT_DISCOVERY_LIMIT);
}

async function discoverClaudeSessions(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const rootDir = path.join(homeDir, '.claude', 'projects');
  const matches = await discoverProviderSessions('claude', rootDir, options.repoRoot, extractClaudeSessionMeta, options);
  matches.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return matches.slice(0, options.limit || DEFAULT_DISCOVERY_LIMIT);
}

async function discoverExternalChatSessions(options = {}) {
  const provider = options.provider ? String(options.provider).trim().toLowerCase() : null;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : DEFAULT_DISCOVERY_LIMIT;
  let sessions = [];
  if (!provider || provider === 'codex') {
    sessions = sessions.concat(await discoverCodexSessions({ ...options, limit }));
  }
  if (!provider || provider === 'claude') {
    sessions = sessions.concat(await discoverClaudeSessions({ ...options, limit }));
  }
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return sessions.slice(0, limit);
}

async function findExternalChatSession(options = {}) {
  const sessionId = String(options.sessionId || '').trim();
  if (!sessionId) return null;
  const matches = await discoverExternalChatSessions({
    ...options,
    sessionId,
    limit: 1,
  });
  return matches[0] || null;
}

module.exports = {
  DEFAULT_DISCOVERY_LIMIT,
  discoverClaudeSessions,
  discoverCodexSessions,
  discoverExternalChatSessions,
  findExternalChatSession,
  normalizeFsPath,
};
