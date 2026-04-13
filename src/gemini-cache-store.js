const path = require('node:path');

const { ensureDir, nowIso, readJson, writeJson } = require('./utils');
const { stableHash, stableStringify } = require('./prompt-cache');

const GEMINI_CACHE_TTL = '86400s';

function geminiCacheFile(manifest) {
  return path.join(manifest.runDir, 'gemini-caches.json');
}

async function loadGeminiCacheState(manifest) {
  const state = await readJson(geminiCacheFile(manifest), null);
  if (!state || typeof state !== 'object') {
    return { version: 1, entries: {} };
  }
  return {
    version: 1,
    entries: state.entries && typeof state.entries === 'object' ? { ...state.entries } : {},
  };
}

async function saveGeminiCacheState(manifest, state) {
  const next = {
    version: 1,
    entries: state && state.entries && typeof state.entries === 'object' ? state.entries : {},
  };
  await ensureDir(path.dirname(geminiCacheFile(manifest)));
  await writeJson(geminiCacheFile(manifest), next);
}

function geminiCacheSessionKey({ purpose, sessionKey, model }) {
  return `${String(purpose || 'turn')}::${String(sessionKey || 'session')}::${String(model || 'model')}`;
}

function dataUrlToInlineData(url) {
  const match = String(url || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function openAiMessageToGeminiParts(message) {
  if (!message) return [];
  if (typeof message.content === 'string') {
    return message.content ? [{ text: message.content }] : [];
  }
  if (!Array.isArray(message.content)) return [];
  const parts = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      parts.push({ text: part.text });
      continue;
    }
    if (part.type === 'image_url' && part.image_url && part.image_url.url) {
      const inlineData = dataUrlToInlineData(part.image_url.url);
      if (inlineData) parts.push({ inlineData });
    }
  }
  return parts;
}

function openAiMessagesToGeminiContents(messages) {
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    const baseParts = openAiMessageToGeminiParts(message);
    if (baseParts.length > 0) parts.push(...baseParts);
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (!toolCall || !toolCall.function || !toolCall.function.name) continue;
        let args = {};
        try {
          args = typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments || '{}')
            : (toolCall.function.arguments || {});
        } catch {
          args = {};
        }
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args,
          },
        });
      }
    }
    if (message.role === 'tool') {
      parts.length = 0;
      parts.push({
        text: String(message.content || ''),
      });
    }
    if (parts.length === 0) continue;
    contents.push({ role, parts });
  }
  return contents;
}

async function createGeminiCachedContent({
  apiKey,
  model,
  systemPrompt,
  messages,
  ttl = GEMINI_CACHE_TTL,
}) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const cache = await ai.caches.create({
    model,
    config: {
      systemInstruction: systemPrompt,
      contents: openAiMessagesToGeminiContents(messages),
      ttl,
    },
  });
  return cache;
}

function isGeminiCacheEntryUsable(entry, { systemPrompt, messages }) {
  if (!entry || !entry.cacheName) return false;
  if (entry.systemPromptHash !== stableHash(systemPrompt || '')) return false;
  if (!Number.isInteger(entry.cachedMessageCount) || entry.cachedMessageCount < 0) return false;
  if (!Array.isArray(messages) || messages.length < entry.cachedMessageCount) return false;
  const currentPrefixHash = stableHash(messages.slice(0, entry.cachedMessageCount));
  return currentPrefixHash === entry.prefixHash;
}

function buildGeminiCacheUsage(entry, messages) {
  if (!isGeminiCacheEntryUsable(entry, { systemPrompt: entry.systemPrompt || '', messages })) {
    return {
      cachedContentName: null,
      uncachedMessages: messages,
      cacheMode: 'implicit',
    };
  }
  return {
    cachedContentName: entry.cacheName,
    uncachedMessages: messages.slice(entry.cachedMessageCount),
    cacheMode: 'explicit',
  };
}

async function refreshGeminiCacheEntry({
  manifest,
  cacheKey,
  apiKey,
  model,
  systemPrompt,
  messages,
}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const cache = await createGeminiCachedContent({
    apiKey,
    model,
    systemPrompt,
    messages,
  });
  const state = await loadGeminiCacheState(manifest);
  state.entries[cacheKey] = {
    cacheName: cache && cache.name ? String(cache.name) : null,
    model: String(model || ''),
    systemPrompt,
    systemPromptHash: stableHash(systemPrompt || ''),
    cachedMessageCount: messages.length,
    prefixHash: stableHash(messages),
    updatedAt: nowIso(),
    expireTime: cache && cache.expireTime ? String(cache.expireTime) : null,
  };
  await saveGeminiCacheState(manifest, state);
  return state.entries[cacheKey];
}

async function readGeminiCacheEntry(manifest, cacheKey) {
  const state = await loadGeminiCacheState(manifest);
  return state.entries[cacheKey] || null;
}

module.exports = {
  GEMINI_CACHE_TTL,
  buildGeminiCacheUsage,
  geminiCacheFile,
  geminiCacheSessionKey,
  loadGeminiCacheState,
  openAiMessagesToGeminiContents,
  readGeminiCacheEntry,
  refreshGeminiCacheEntry,
  saveGeminiCacheState,
};
