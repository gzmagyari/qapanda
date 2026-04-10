const fs = require('node:fs');
const readline = require('node:readline');

const { safeJsonParse, truncate } = require('./utils');
const { discoverExternalChatSessions } = require('./external-chat-discovery');
const { normalizeExternalChatRecord } = require('./external-chat-parser');

const DEFAULT_SEARCH_LIMIT = 20;
const SEARCH_DISCOVERY_LIMIT = Number.MAX_SAFE_INTEGER;

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

async function findFirstMessageMatch(descriptor, query) {
  const context = {
    provider: descriptor.provider,
    sessionId: descriptor.sessionId || null,
    cwd: descriptor.cwd || null,
    startedAt: descriptor.startedAt || null,
  };
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return null;

  const input = fs.createReadStream(descriptor.filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line) continue;
      const parsed = safeJsonParse(line);
      if (!parsed) continue;
      const messages = [];
      normalizeExternalChatRecord(descriptor.provider, parsed, context, messages);
      for (const message of messages) {
        const text = message && message.text ? String(message.text) : '';
        if (!text) continue;
        if (text.toLowerCase().includes(needle)) {
          return {
            matchPreview: buildMatchPreview(text, needle),
          };
        }
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  return null;
}

async function searchExternalChatSessions(options = {}) {
  const query = String(options.query || '').trim();
  if (!query) return [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : DEFAULT_SEARCH_LIMIT;
  const descriptors = await discoverExternalChatSessions({
    repoRoot: options.repoRoot,
    provider: options.provider || null,
    homeDir: options.homeDir,
    limit: SEARCH_DISCOVERY_LIMIT,
  });

  const matches = [];
  for (const descriptor of descriptors) {
    const match = await findFirstMessageMatch(descriptor, query);
    if (!match) continue;
    matches.push({
      ...descriptor,
      matchPreview: match.matchPreview,
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

module.exports = {
  DEFAULT_SEARCH_LIMIT,
  buildMatchPreview,
  searchExternalChatSessions,
};
