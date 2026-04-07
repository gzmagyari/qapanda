const fs = require('node:fs');

const { workerLabelFor } = require('./render');
const { ensureWorkerSessionState } = require('./state');
const { buildTranscriptTail } = require('./transcript');
const { readText, safeJsonParse } = require('./utils');

const DIRECT_WORKER_HANDOFF_MAX_CHARS = 50_000;
function buildDirectWorkerHandoffNotice(maxChars = DIRECT_WORKER_HANDOFF_MAX_CHARS) {
  return `System: Earlier chat context since your last turn was omitted. Only the latest ~${maxChars} characters are shown.`;
}
const DIRECT_WORKER_HANDOFF_NOTICE = buildDirectWorkerHandoffNotice();

function readChatEntriesSync(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseChatRaw(raw);
  } catch {
    return [];
  }
}

async function readChatEntries(filePath) {
  const raw = await readText(filePath, '');
  return parseChatRaw(raw);
}

function parseChatRaw(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    const parsed = safeJsonParse(lines[index]);
    if (!parsed) continue;
    parsed.__lineNumber = index + 1;
    entries.push(parsed);
  }
  return entries;
}

function countChatLinesSync(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return 0;
    return raw.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

function chatLineSlice(entries, sinceLine) {
  if (!sinceLine || sinceLine <= 0) return entries;
  return entries.filter((entry) => (entry.__lineNumber || 0) > sinceLine);
}

function knownWorkerLabels(manifest) {
  const labels = new Set();
  if (manifest && manifest.worker) {
    labels.add(workerLabelFor(manifest.worker.cli, null));
  }
  for (const agent of Object.values((manifest && manifest.agents) || {})) {
    if (agent && agent.name) labels.add(String(agent.name));
  }
  return labels;
}

function targetWorkerLabel(manifest, agentId) {
  if (agentId && agentId !== 'default') {
    const agent = manifest && manifest.agents ? manifest.agents[agentId] : null;
    if (agent && agent.name) return String(agent.name);
  }
  return workerLabelFor(manifest && manifest.worker && manifest.worker.cli, null);
}

function formatChatEntryForHandoff(entry, manifest, targetLabel, workerLabels) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'user') {
    return `User: ${entry.text || ''}`;
  }
  if (!['claude', 'mdLine', 'line'].includes(entry.type)) {
    return null;
  }
  const label = entry.label ? String(entry.label) : '';
  if (!label || !workerLabels.has(label) || label === targetLabel) {
    return null;
  }
  return `${label}: ${entry.text || ''}`;
}

function getDirectWorkerSessionState(manifest, agentId, options = {}) {
  if (!manifest || !manifest.worker) return null;
  const create = options.create === true;
  if (agentId && agentId !== 'default') {
    if (!manifest.worker.agentSessions) {
      if (!create) return null;
      manifest.worker.agentSessions = {};
    }
    if (!manifest.worker.agentSessions[agentId]) {
      if (!create) return null;
      manifest.worker.agentSessions[agentId] = {};
    }
    manifest.worker.agentSessions[agentId] = ensureWorkerSessionState(manifest.worker.agentSessions[agentId]);
    return manifest.worker.agentSessions[agentId];
  }
  manifest.worker = ensureWorkerSessionState(manifest.worker);
  return manifest.worker;
}

async function buildDirectWorkerPrompt(manifest, agentId, visiblePrompt, options = {}) {
  const promptText = visiblePrompt == null ? '' : String(visiblePrompt);
  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(1, Number(options.maxChars))
    : DIRECT_WORKER_HANDOFF_MAX_CHARS;
  const contextLabel = options.contextLabel || 'Context since your last turn in this run:';
  const requestLabel = options.requestLabel || 'Current user request:';
  const sessionState = getDirectWorkerSessionState(manifest, agentId, { create: true });
  if (!manifest || !manifest.files || !manifest.files.chatLog || !sessionState) {
    return {
      prompt: promptText,
      handoffLines: [],
      truncated: false,
    };
  }

  const entries = await readChatEntries(manifest.files.chatLog);
  const unseenEntries = chatLineSlice(entries, sessionState.lastSeenChatLine || 0);
  const workerLabels = knownWorkerLabels(manifest);
  const targetLabel = targetWorkerLabel(manifest, agentId);
  const handoffEntries = unseenEntries
    .map((entry) => formatChatEntryForHandoff(entry, manifest, targetLabel, workerLabels))
    .filter(Boolean);
  if (handoffEntries.length === 0) {
    return {
      prompt: promptText,
      handoffLines: [],
      truncated: false,
    };
  }

  const tail = buildTranscriptTail(handoffEntries, { maxChars });
  const handoffLines = tail.truncated
    ? [buildDirectWorkerHandoffNotice(maxChars), ...tail.lines]
    : tail.lines;

  return {
    prompt: [
      contextLabel,
      ...handoffLines,
      '',
      requestLabel,
      promptText,
    ].join('\n'),
    handoffLines,
    truncated: tail.truncated,
  };
}

function syncDirectWorkerChatCursor(manifest, agentId) {
  const sessionState = getDirectWorkerSessionState(manifest, agentId, { create: true });
  if (!sessionState) return;
  try {
    sessionState.lastSeenChatLine = countChatLinesSync(manifest.files && manifest.files.chatLog);
  } catch {}
}

module.exports = {
  DIRECT_WORKER_HANDOFF_MAX_CHARS,
  DIRECT_WORKER_HANDOFF_NOTICE,
  buildDirectWorkerHandoffNotice,
  buildDirectWorkerPrompt,
  countChatLinesSync,
  getDirectWorkerSessionState,
  readChatEntriesSync,
  syncDirectWorkerChatCursor,
};
