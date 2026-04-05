const fs = require('node:fs');

const { workerLabelFor } = require('./render');
const { buildTranscriptTail } = require('./transcript');
const { readText, safeJsonParse } = require('./utils');

const DIRECT_WORKER_HANDOFF_MAX_CHARS = 50_000;
const DIRECT_WORKER_HANDOFF_NOTICE =
  `System: Earlier chat context since your last turn was omitted. Only the latest ~${DIRECT_WORKER_HANDOFF_MAX_CHARS} characters are shown.`;

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
      manifest.worker.agentSessions[agentId] = {
        lastSeenChatLine: 0,
        lastSeenTranscriptLine: 0,
      };
    } else {
      if (!Number.isFinite(manifest.worker.agentSessions[agentId].lastSeenChatLine)) {
        manifest.worker.agentSessions[agentId].lastSeenChatLine = 0;
      }
      if (!Number.isFinite(manifest.worker.agentSessions[agentId].lastSeenTranscriptLine)) {
        manifest.worker.agentSessions[agentId].lastSeenTranscriptLine = 0;
      }
    }
    return manifest.worker.agentSessions[agentId];
  }
  if (!Number.isFinite(manifest.worker.lastSeenChatLine)) {
    manifest.worker.lastSeenChatLine = 0;
  }
  if (!Number.isFinite(manifest.worker.lastSeenTranscriptLine)) {
    manifest.worker.lastSeenTranscriptLine = 0;
  }
  return manifest.worker;
}

async function buildDirectWorkerPrompt(manifest, agentId, visiblePrompt) {
  const promptText = visiblePrompt == null ? '' : String(visiblePrompt);
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

  const tail = buildTranscriptTail(handoffEntries, { maxChars: DIRECT_WORKER_HANDOFF_MAX_CHARS });
  const handoffLines = tail.truncated
    ? [DIRECT_WORKER_HANDOFF_NOTICE, ...tail.lines]
    : tail.lines;

  return {
    prompt: [
      'Context since your last turn in this run:',
      ...handoffLines,
      '',
      'Current user request:',
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
  buildDirectWorkerPrompt,
  countChatLinesSync,
  getDirectWorkerSessionState,
  readChatEntriesSync,
  syncDirectWorkerChatCursor,
};
