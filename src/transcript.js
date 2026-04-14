const fs = require('node:fs');
const fsp = require('node:fs/promises');

const { appendJsonl, nowIso, readText, safeJsonParse } = require('./utils');
const { formatToolCall, summarizeClaudeEvent } = require('./events');
const { controllerLabelFor, workerLabelFor } = require('./render');
const { CARD_MAP } = require('./mcp-cards');
const { normalizeToolResultOutput } = require('./tool-result-normalizer');
const { redactHostedWorkflowValue } = require('./cloud/workflow-hosted-runs');

const TRANSCRIPT_V2 = 2;
const CONTROLLER_SESSION_KEY = 'controller:main';
const DEFAULT_WORKER_SESSION_KEY = 'worker:default';
const DEFAULT_TRANSCRIPT_TAIL_MAX_CHARS = 50_000;
const DEFAULT_TRANSCRIPT_TAIL_INITIAL_BYTES = 256 * 1024;
const DEFAULT_TRANSCRIPT_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_TAIL_TRUNCATION_BANNER = 'Showing only the latest chat tail for this run.';
const TRANSCRIPT_SCREENSHOT_PLACEHOLDER = '[Screenshot]';
const TRANSCRIPT_CARD_PLACEHOLDER = '[Card]';

function controllerSessionKey() {
  return CONTROLLER_SESSION_KEY;
}

function workerSessionKey(agentId) {
  return agentId && agentId !== 'default'
    ? `worker:agent:${agentId}`
    : DEFAULT_WORKER_SESSION_KEY;
}

function agentIdFromSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string') return null;
  if (!sessionKey.startsWith('worker:agent:')) return null;
  return sessionKey.slice('worker:agent:'.length) || null;
}

function transcriptBackend(role, cli) {
  return `${role}:${cli || 'unknown'}`;
}

function createTranscriptRecord({
  ts,
  kind,
  sessionKey,
  backend,
  requestId,
  loopIndex,
  agentId,
  controllerCli,
  workerCli,
  labelHint,
  text,
  payload,
  result,
  compaction,
  toolCallId,
  toolName,
  input,
  display,
}) {
  return {
    v: TRANSCRIPT_V2,
    ts: ts || nowIso(),
    kind,
    sessionKey,
    backend,
    requestId: requestId || null,
    loopIndex: loopIndex == null ? null : loopIndex,
    agentId: agentId || null,
    controllerCli: controllerCli || null,
    workerCli: workerCli || null,
    labelHint: labelHint || null,
    text: text == null ? null : String(text),
    payload: payload === undefined ? null : payload,
    result: result === undefined ? null : result,
    compaction: compaction === undefined ? null : compaction,
    toolCallId: toolCallId || null,
    toolName: toolName || null,
    input: input === undefined ? null : input,
    display: display !== false,
  };
}

async function appendTranscriptRecord(manifest, record) {
  if (!manifest || !manifest.files || !manifest.files.transcript) return;
  await appendJsonl(manifest.files.transcript, redactHostedWorkflowValue(manifest, record));
}

async function readTranscriptEntries(filePath) {
  const raw = await readText(filePath, '');
  return parseTranscriptRaw(raw);
}

function readTranscriptEntriesSync(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseTranscriptRaw(raw);
  } catch {
    return [];
  }
}

function parseTranscriptRaw(raw, options = {}) {
  const baseLineNumber = Number.isFinite(options.baseLineNumber)
    ? Math.max(0, Number(options.baseLineNumber))
    : 0;
  const lines = String(raw || '').split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const parsed = safeJsonParse(lines[i]);
    if (!parsed) continue;
    parsed.__lineNumber = baseLineNumber + i + 1;
    entries.push(parsed);
  }
  return entries;
}

function countTranscriptLinesSync(filePath) {
  return countJsonlLinesSync(filePath);
}

function countJsonlLinesSync(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = Number(stat && stat.size) || 0;
    if (fileSize <= 0) return 0;

    const chunkSize = 1024 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    let lineCount = 0;
    let lastByte = null;

    while (offset < fileSize) {
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(chunkSize, fileSize - offset), offset);
      if (bytesRead <= 0) break;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] === 0x0A) {
          lineCount += 1;
        }
      }
      lastByte = buffer[bytesRead - 1];
      offset += bytesRead;
    }

    if (lastByte !== 0x0A) {
      lineCount += 1;
    }
    return lineCount;
  } catch {
    return 0;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

async function countNewlinesBeforeOffset(handle, endOffsetExclusive) {
  const fileLimit = Number.isFinite(endOffsetExclusive)
    ? Math.max(0, Number(endOffsetExclusive))
    : 0;
  if (fileLimit <= 0) return 0;

  const chunkSize = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  let offset = 0;
  let lineCount = 0;

  while (offset < fileLimit) {
    const bytesRead = Math.min(chunkSize, fileLimit - offset);
    const { bytesRead: actualBytesRead } = await handle.read(buffer, 0, bytesRead, offset);
    if (actualBytesRead <= 0) break;
    for (let index = 0; index < actualBytesRead; index += 1) {
      if (buffer[index] === 0x0A) {
        lineCount += 1;
      }
    }
    offset += actualBytesRead;
  }

  return lineCount;
}

function countNewlinesBeforeOffsetSync(fd, endOffsetExclusive) {
  const fileLimit = Number.isFinite(endOffsetExclusive)
    ? Math.max(0, Number(endOffsetExclusive))
    : 0;
  if (fileLimit <= 0) return 0;

  const chunkSize = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(chunkSize);
  let offset = 0;
  let lineCount = 0;

  while (offset < fileLimit) {
    const bytesRead = fs.readSync(fd, buffer, 0, Math.min(chunkSize, fileLimit - offset), offset);
    if (bytesRead <= 0) break;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0A) {
        lineCount += 1;
      }
    }
    offset += bytesRead;
  }

  return lineCount;
}

function hasTranscriptV2(entries) {
  return Array.isArray(entries) && entries.some((entry) => entry && entry.v === TRANSCRIPT_V2 && entry.kind && entry.sessionKey);
}

function latestSessionCompaction(entries, sessionKey) {
  if (!Array.isArray(entries) || !sessionKey) return null;
  let latest = null;
  for (const entry of entries) {
    if (!entry || entry.v !== TRANSCRIPT_V2 || entry.sessionKey !== sessionKey || entry.kind !== 'context_compaction') continue;
    latest = entry;
  }
  if (!latest) return null;
  return {
    entry: latest,
    compactedThroughLine: latest.compaction && Number.isFinite(latest.compaction.compactedThroughLine)
      ? latest.compaction.compactedThroughLine
      : 0,
    preservedLines: new Set(Array.isArray(latest.compaction && latest.compaction.preservedLines)
      ? latest.compaction.preservedLines
      : []),
  };
}

function entryIsCompactedAway(entry, compactionState) {
  if (!entry || !compactionState || !compactionState.entry) return false;
  if (entry.sessionKey !== compactionState.entry.sessionKey) return false;
  if (entry.kind === 'context_compaction') {
    return entry.__lineNumber !== compactionState.entry.__lineNumber;
  }
  const lineNumber = entry.__lineNumber || 0;
  if (lineNumber <= 0) return false;
  if (lineNumber > compactionState.compactedThroughLine) return false;
  return !compactionState.preservedLines.has(lineNumber);
}

function transcriptLineSlice(entries, sinceLine) {
  if (!sinceLine || sinceLine <= 0) return entries;
  return entries.filter((entry) => (entry.__lineNumber || 0) > sinceLine);
}

function buildTranscriptTail(lines, options = {}) {
  const allLines = Array.isArray(lines) ? lines : [];
  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(0, options.maxChars)
    : DEFAULT_TRANSCRIPT_TAIL_MAX_CHARS;
  if (allLines.length === 0) {
    return { lines: [], truncated: false, totalChars: 0 };
  }

  let start = allLines.length - 1;
  let totalChars = 0;

  for (let index = allLines.length - 1; index >= 0; index -= 1) {
    const line = String(allLines[index] || '');
    totalChars += line.length;
    start = index;
    if (totalChars >= maxChars) {
      break;
    }
  }

  const tail = allLines.slice(start);
  return {
    lines: tail,
    truncated: start > 0,
    totalChars,
  };
}

async function readTranscriptTailEntries(filePath, options = {}) {
  const requestedBytes = Number.isFinite(options.bytes)
    ? Math.max(1, Number(options.bytes))
    : DEFAULT_TRANSCRIPT_TAIL_INITIAL_BYTES;

  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const stat = await handle.stat();
    const fileSize = Number(stat && stat.size) || 0;
    if (fileSize <= 0) {
      return { entries: [], fileSize: 0, bytesRead: 0, startOffset: 0 };
    }

    const bytesRead = Math.min(fileSize, requestedBytes);
    const startOffset = Math.max(0, fileSize - bytesRead);
    const buffer = Buffer.alloc(bytesRead);
    await handle.read(buffer, 0, bytesRead, startOffset);

    let sliceStart = 0;
    if (startOffset > 0) {
      const newlineByteIndex = buffer.indexOf(0x0A);
      sliceStart = newlineByteIndex >= 0 ? newlineByteIndex + 1 : bytesRead;
    }
    const raw = buffer.subarray(sliceStart).toString('utf8');
    const entries = parseTranscriptRaw(raw);
    if (startOffset > 0 && entries.some((entry) => entry && entry.kind === 'context_compaction')) {
      const baseLineNumber = await countNewlinesBeforeOffset(handle, startOffset + sliceStart);
      for (const entry of entries) {
        entry.__lineNumber += baseLineNumber;
      }
    }

    return {
      entries,
      fileSize,
      bytesRead,
      startOffset,
    };
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

function readTranscriptTailEntriesSync(filePath, options = {}) {
  const requestedBytes = Number.isFinite(options.bytes)
    ? Math.max(1, Number(options.bytes))
    : DEFAULT_TRANSCRIPT_TAIL_INITIAL_BYTES;

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = Number(stat && stat.size) || 0;
    if (fileSize <= 0) {
      return { entries: [], fileSize: 0, bytesRead: 0, startOffset: 0 };
    }

    const bytesRead = Math.min(fileSize, requestedBytes);
    const startOffset = Math.max(0, fileSize - bytesRead);
    const buffer = Buffer.alloc(bytesRead);
    fs.readSync(fd, buffer, 0, bytesRead, startOffset);

    let sliceStart = 0;
    if (startOffset > 0) {
      const newlineByteIndex = buffer.indexOf(0x0A);
      sliceStart = newlineByteIndex >= 0 ? newlineByteIndex + 1 : bytesRead;
    }
    const raw = buffer.subarray(sliceStart).toString('utf8');
    const entries = parseTranscriptRaw(raw);
    if (startOffset > 0 && entries.some((entry) => entry && entry.kind === 'context_compaction')) {
      const baseLineNumber = countNewlinesBeforeOffsetSync(fd, startOffset + sliceStart);
      for (const entry of entries) {
        entry.__lineNumber += baseLineNumber;
      }
    }

    return {
      entries,
      fileSize,
      bytesRead,
      startOffset,
    };
  } catch {
    return { entries: [], fileSize: 0, bytesRead: 0, startOffset: 0 };
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function summarizeTranscriptCardMessage(message) {
  if (!message || typeof message !== 'object') return TRANSCRIPT_CARD_PLACEHOLDER;
  const parts = [];
  if (message.card) parts.push(String(message.card));
  const data = message.data && typeof message.data === 'object' ? message.data : {};
  for (const key of ['title', 'name', 'text', 'status', 'summary', 'author', 'detail']) {
    if (data[key] != null && String(data[key]).trim()) {
      parts.push(String(data[key]).trim());
    }
  }
  if (parts.length === 0 && message.text) {
    parts.push(String(message.text).trim());
  }
  return parts.length ? parts.join(' ') : TRANSCRIPT_CARD_PLACEHOLDER;
}

function visibleTextForDisplayMessage(message) {
  if (!message || typeof message !== 'object') return '';
  switch (message.type) {
    case 'user':
    case 'controller':
    case 'claude':
    case 'mdLine':
    case 'line':
    case 'shell':
    case 'error':
    case 'banner':
      return String(message.text || '');
    case 'toolCall':
      return String(message.text || '');
    case 'stop':
      return 'STOP';
    case 'chatScreenshot':
      return TRANSCRIPT_SCREENSHOT_PLACEHOLDER;
    case 'mcpCardStart':
    case 'mcpCardComplete':
      return [message.text || '', message.detail || ''].filter(Boolean).join(' ').trim() || TRANSCRIPT_CARD_PLACEHOLDER;
    case 'mcpCard':
    case 'testCard':
    case 'bugCard':
    case 'taskCard':
    case 'qaReportCard':
      return summarizeTranscriptCardMessage(message);
    default:
      return String(message.text || message.detail || '');
  }
}

function countDisplayMessageChars(messages) {
  return (Array.isArray(messages) ? messages : [])
    .reduce((total, message) => total + visibleTextForDisplayMessage(message).length, 0);
}

function buildDisplayMessageTail(messages, options = {}) {
  const allMessages = Array.isArray(messages) ? messages : [];
  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(0, Number(options.maxChars))
    : DEFAULT_TRANSCRIPT_TAIL_MAX_CHARS;
  const truncationBannerText = options.truncationBannerText || null;
  const omitBannerText = options.omitBannerText || null;

  const normalized = omitBannerText
    ? allMessages.filter((message) => !(message && message.type === 'banner' && message.text === omitBannerText))
    : allMessages.slice();

  if (normalized.length === 0) {
    return { messages: [], truncated: false, totalChars: 0 };
  }

  let start = normalized.length - 1;
  let totalChars = 0;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    totalChars += visibleTextForDisplayMessage(normalized[index]).length;
    start = index;
    if (totalChars >= maxChars) {
      break;
    }
  }

  let tail = normalized.slice(start);
  const truncated = start > 0;
  if (truncated && truncationBannerText) {
    tail = [{ type: 'banner', text: truncationBannerText }, ...tail];
  }

  return {
    messages: tail,
    truncated,
    totalChars,
  };
}

async function buildTranscriptDisplayTail(filePath, manifest, options = {}) {
  const maxChars = Number.isFinite(options.maxChars)
    ? Math.max(1, Number(options.maxChars))
    : DEFAULT_TRANSCRIPT_TAIL_MAX_CHARS;
  const initialBytes = Number.isFinite(options.initialBytes)
    ? Math.max(1, Number(options.initialBytes))
    : DEFAULT_TRANSCRIPT_TAIL_INITIAL_BYTES;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(initialBytes, Number(options.maxBytes))
    : DEFAULT_TRANSCRIPT_TAIL_MAX_BYTES;

  let bytes = initialBytes;
  let latest = { entries: [], fileSize: 0, bytesRead: 0, startOffset: 0 };
  let messages = [];

  for (;;) {
    latest = await readTranscriptTailEntries(filePath, { bytes });
    messages = buildTranscriptDisplayMessages(latest.entries, manifest, options.displayOptions || {});

    const visibleChars = countDisplayMessageChars(messages);
    const reachedFileStart = latest.startOffset === 0;
    const hitReadCap = latest.bytesRead >= maxBytes;
    if (visibleChars >= maxChars || reachedFileStart || hitReadCap) {
      break;
    }

    const nextBytes = Math.min(
      maxBytes,
      latest.fileSize || maxBytes,
      Math.max(bytes + 1, bytes * 2),
    );
    if (nextBytes <= bytes) {
      break;
    }
    bytes = nextBytes;
  }

  const tail = buildDisplayMessageTail(messages, {
    maxChars,
    truncationBannerText: TRANSCRIPT_TAIL_TRUNCATION_BANNER,
  });
  const omittedEarlierContent = latest.startOffset > 0;

  if (omittedEarlierContent && !tail.truncated) {
    tail.messages = [{ type: 'banner', text: TRANSCRIPT_TAIL_TRUNCATION_BANNER }, ...tail.messages];
  }

  return {
    messages: tail.messages,
    truncated: tail.truncated || omittedEarlierContent,
    fileSize: latest.fileSize,
    bytesRead: latest.bytesRead,
    startOffset: latest.startOffset,
  };
}

function labelForTranscriptEntry(entry, manifest, options = {}) {
  if (entry && entry.labelHint) return entry.labelHint;
  if (!entry) return 'Worker';
  if (entry.sessionKey === CONTROLLER_SESSION_KEY || String(entry.backend || '').startsWith('controller:')) {
    return controllerLabelFor(entry.controllerCli || (manifest && manifest.controller && manifest.controller.cli));
  }
  const agentId = entry.agentId || agentIdFromSessionKey(entry.sessionKey);
  const agent = agentId && manifest && manifest.agents ? manifest.agents[agentId] : null;
  const cli = entry.workerCli || (agent && agent.cli) || (manifest && manifest.worker && manifest.worker.cli);
  if (agent && agent.name) {
    return workerLabelFor(cli, agent.name);
  }
  if (options.fallbackWorkerLabel) {
    return options.fallbackWorkerLabel;
  }
  return workerLabelFor(cli, null);
}

function legacyWorkerLabel(manifest, options = {}) {
  let agentName = null;
  const sessions = manifest && manifest.worker && manifest.worker.agentSessions;
  if (sessions && manifest && manifest.agents) {
    const startedAgentId = Object.keys(sessions).find((id) => sessions[id] && sessions[id].hasStarted);
    if (startedAgentId && manifest.agents[startedAgentId]) {
      agentName = manifest.agents[startedAgentId].name || null;
    }
  }
  if (agentName) {
    return workerLabelFor(manifest && manifest.worker && manifest.worker.cli, agentName);
  }
  if (options.fallbackWorkerLabel) {
    return options.fallbackWorkerLabel;
  }
  return workerLabelFor(manifest && manifest.worker && manifest.worker.cli, null);
}

function extractTextContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'input_text' && typeof part.text === 'string') return part.text;
      if (part.text && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function summarizeToolResult(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  if (!Array.isArray(result.content)) return JSON.stringify(result);
  return result.content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'image' && block.data) return `[Screenshot captured: ${block.mimeType || 'image/png'}]`;
    return JSON.stringify(block);
  }).filter(Boolean).join('\n');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function imagePartsFromToolResult(result) {
  if (!result || !Array.isArray(result.content)) return [];
  const imageParts = [];
  for (const block of result.content) {
    if (block && block.type === 'image' && block.data) {
      imageParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.mimeType || 'image/png'};base64,${block.data}`,
          format: block.mimeType || 'image/png',
        },
      });
    }
  }
  return imageParts;
}

function toolResultAssetId(entry) {
  if (!entry) return null;
  if (entry.assetId) return String(entry.assetId);
  if (entry.toolCallId) return `asset_${entry.toolCallId}`;
  if (entry.__lineNumber) return `asset_${entry.__lineNumber}`;
  return null;
}

function toolReturnsScreenshot(entry) {
  const toolName = String(entry && entry.toolName || '').toLowerCase();
  return toolName.includes('screenshot') || toolName.includes('screen_shot');
}

function normalizedToolProvenanceText(entry, result, options = {}) {
  const rawToolText = summarizeToolResult(result)
    .replace(/\n?\[Screenshot captured:[^\]]+\]/g, '')
    .trim();
  const assetId = toolResultAssetId(entry);
  const imageCount = imagePartsFromToolResult(result).length;
  const maxToolTextLength = options.maxToolTextLength == null ? 50000 : options.maxToolTextLength;

  let toolContent = rawToolText;
  if (!toolContent && imageCount > 0) {
    toolContent = toolReturnsScreenshot(entry)
      ? 'Screenshot captured.'
      : (imageCount === 1 ? 'Image captured.' : 'Images captured.');
  }
  if (assetId) {
    toolContent = toolContent
      ? `${toolContent}\nasset_id=${assetId}`
      : `asset_id=${assetId}`;
  }
  if (!toolContent) {
    toolContent = 'Tool result captured.';
  }
  if (toolContent.length > maxToolTextLength) {
    return toolContent.slice(0, maxToolTextLength) + '\n... (truncated)';
  }
  return toolContent;
}

function promotedImageReplayText(entry, imageCount) {
  const assetId = toolResultAssetId(entry);
  const isScreenshot = toolReturnsScreenshot(entry);
  const baseText = isScreenshot
    ? (imageCount === 1
        ? 'Here is the screenshot captured earlier in this conversation.'
        : 'Here are the screenshots captured earlier in this conversation.')
    : (imageCount === 1
        ? 'Here is the image returned earlier in this conversation.'
        : 'Here are the images returned earlier in this conversation.');
  return assetId
    ? `${baseText} asset_id=${assetId}. Use this image for later reasoning.`
    : `${baseText} Use this image for later reasoning.`;
}

function providerMessagesForToolResult(entry, options = {}) {
  const result = entry && entry.result;
  const toolContent = normalizedToolProvenanceText(entry, result, options);
  const includeInlineImages = options.includeInlineImages !== false;

  const messages = [{
    role: 'tool',
    tool_call_id: entry.toolCallId,
    content: toolContent,
  }];

  const imageParts = includeInlineImages ? imagePartsFromToolResult(result) : [];
  if (imageParts.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: promotedImageReplayText(entry, imageParts.length) },
        ...imageParts,
      ],
    });
  }

  return messages;
}

function contextCompactionReplayMessage(entry) {
  if (!entry || entry.kind !== 'context_compaction') return null;
  if (entry.payload && entry.payload.role) {
    return clone(entry.payload);
  }
  const text = entry.text || '';
  if (!text) return null;
  return {
    role: 'assistant',
    content: `Conversation summary (generated by context compaction):\n${text}`,
  };
}

function tailReplayToolResults(entries, sessionKey, compactionState) {
  const tailEntries = new Set();
  if (!Array.isArray(entries) || !sessionKey) return tailEntries;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.v !== TRANSCRIPT_V2 || entry.sessionKey !== sessionKey) continue;
    if (entryIsCompactedAway(entry, compactionState)) continue;
    if (entry.kind === 'tool_result') {
      tailEntries.add(entry);
      continue;
    }
    if (entry.kind === 'tool_call' || entry.kind === 'ui_message') continue;
    break;
  }
  return tailEntries;
}

function buildSessionReplay(entries, sessionKey, options = {}) {
  if (!Array.isArray(entries) || !sessionKey) return [];
  const messages = [];
  const compactionState = latestSessionCompaction(entries, sessionKey);
  const compactionMessage = compactionState ? contextCompactionReplayMessage(compactionState.entry) : null;
  let compactionInserted = !compactionMessage;
  const inlineImageReplayMode = options.inlineImageReplayMode || 'all';
  const tailToolResults = inlineImageReplayMode === 'tail-only'
    ? tailReplayToolResults(entries, sessionKey, compactionState)
    : null;
  for (const entry of entries) {
    if (!entry || entry.v !== TRANSCRIPT_V2 || entry.sessionKey !== sessionKey) continue;
    if (entryIsCompactedAway(entry, compactionState)) continue;
    if (entry.kind === 'user_message') {
      if (entry.payload && entry.payload.role === 'user') {
        messages.push(clone(entry.payload));
      } else {
        messages.push({ role: 'user', content: entry.text || '' });
      }
      if (!compactionInserted) {
        messages.push(compactionMessage);
        compactionInserted = true;
      }
      continue;
    }
    if (entry.kind === 'assistant_message') {
      if (entry.payload && entry.payload.role === 'assistant') {
        messages.push(clone(entry.payload));
      } else if (entry.text) {
        messages.push({ role: 'assistant', content: entry.text });
      }
      if (!compactionInserted) {
        messages.push(compactionMessage);
        compactionInserted = true;
      }
      continue;
    }
    if (entry.kind === 'context_compaction') {
      continue;
    }
    if (entry.kind === 'tool_result') {
      const includeInlineImages = inlineImageReplayMode === 'all'
        ? options.includeInlineImages !== false
        : (inlineImageReplayMode === 'tail-only'
            ? !!(tailToolResults && tailToolResults.has(entry))
            : false);
      messages.push(...providerMessagesForToolResult(entry, {
        ...options,
        includeInlineImages,
      }));
      if (!compactionInserted) {
        messages.push(compactionMessage);
        compactionInserted = true;
      }
    }
  }
  if (!compactionInserted) {
    messages.push(compactionMessage);
  }
  return messages;
}

function parseToolInput(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  return safeJsonParse(argumentsValue) || {};
}

function baseToolName(fullToolName) {
  if (!fullToolName) return '';
  const parts = String(fullToolName).split('__');
  return parts.length >= 2 ? parts[parts.length - 1] : String(fullToolName);
}

function toolCallSummary(toolName, input) {
  return formatToolCall(toolName, input || {});
}

function buildCardMessages(toolName, input, output, label, cardId) {
  const cfg = CARD_MAP[toolName];
  if (!cfg) return [];
  const normalizedOutput = normalizeToolResultOutput(output);

  if (cfg.template === 'displayTestSummary') {
    return [{ type: 'testCard', label, data: input }];
  }
  if (cfg.template === 'displayBugReport') {
    return [{ type: 'bugCard', label, data: input }];
  }
  if (cfg.template === 'displayTask') {
    return [{ type: 'taskCard', label, data: input }];
  }
  if (cfg.template === 'testSuite') {
    return [{ type: 'mcpCard', label, card: 'testSuite', data: normalizedOutput || {} }];
  }
  if (cfg.template === 'comment') {
    return [{
      type: 'mcpCard',
      label,
      card: 'taskComment',
      data: { author: (normalizedOutput && normalizedOutput.author) || 'agent', text: (input && input.text) || '' },
    }];
  }
  if (cfg.template === 'statusChange') {
    return [{
      type: 'mcpCard',
      label,
      card: 'taskStatus',
      data: { title: (input && input.task_id) || '', status: (input && input.status) || '' },
    }];
  }
  if (cfg.template === 'testCard' && normalizedOutput && normalizedOutput._testCard) {
    return [{
      type: 'mcpCardComplete',
      id: cardId,
      label,
      icon: cfg.icon || '',
      text: cfg.text || toolName,
      detail: '',
    }];
  }

  const fieldValue = cfg.field && input ? input[cfg.field] : null;
  const detail = fieldValue ? String(fieldValue) : '';
  const msg = {
    type: 'mcpCardComplete',
    id: cardId,
    label,
    icon: cfg.icon || '',
    text: cfg.text || toolName,
    detail,
  };
  if (cfg.template === 'command') msg.template = 'command';
  return [msg];
}

function buildStartCardMessages(toolName, input, label, cardId) {
  const cfg = CARD_MAP[toolName];
  if (!cfg || cfg.suppress) return [];

  const fieldValue = cfg.field && input ? input[cfg.field] : null;
  const detail = fieldValue ? String(fieldValue) : '';
  const msg = {
    type: 'mcpCardStart',
    id: cardId,
    label,
    icon: cfg.icon || '',
    text: cfg.startText || cfg.text || toolName,
    detail,
  };
  if (cfg.template === 'command') msg.template = 'command';
  return [msg];
}

function screenshotMessagesFromResult(result) {
  if (!result || !Array.isArray(result.content)) return [];
  const messages = [];
  for (const block of result.content) {
    if (block && block.type === 'image' && block.data) {
      messages.push({
        type: 'chatScreenshot',
        data: `data:${block.mimeType || 'image/png'};base64,${block.data}`,
        alt: 'Tool screenshot',
      });
    }
  }
  return messages;
}

function collectDisplayReplayHints(entries) {
  const completedToolCallIds = new Set();
  const canonicalScreenshotData = new Set();
  const canonicalScreenshotSessions = new Set();

  for (const entry of entries || []) {
    if (!entry || entry.v !== TRANSCRIPT_V2) continue;

    if (entry.kind === 'tool_result') {
      if (entry.toolCallId) completedToolCallIds.add(entry.toolCallId);
      const screenshotMessages = screenshotMessagesFromResult(entry.result);
      if (screenshotMessages.length > 0 && entry.sessionKey) {
        canonicalScreenshotSessions.add(entry.sessionKey);
      }
      for (const msg of screenshotMessages) {
        if (msg && msg.data) canonicalScreenshotData.add(msg.data);
      }
      continue;
    }

    if (entry.kind === 'backend_event' && entry.payload && typeof entry.payload === 'object') {
      const raw = entry.payload;
      if (raw.item && raw.item.type === 'mcp_tool_call' && raw.type === 'item.completed') {
        let output = raw.item.output || raw.item.result || {};
        if (typeof output === 'string') output = safeJsonParse(output) || {};
        const screenshotMessages = screenshotMessagesFromResult(output);
        if (screenshotMessages.length > 0 && entry.sessionKey) {
          canonicalScreenshotSessions.add(entry.sessionKey);
        }
        for (const msg of screenshotMessages) {
          if (msg && msg.data) canonicalScreenshotData.add(msg.data);
        }
      }
    }
  }

  return { completedToolCallIds, canonicalScreenshotData, canonicalScreenshotSessions };
}

function buildTranscriptDisplayMessages(entries, manifest, options = {}) {
  const messages = [];
  const pendingClaudeTools = new Map();
  const { completedToolCallIds, canonicalScreenshotData, canonicalScreenshotSessions } = collectDisplayReplayHints(entries);
  const compactionStates = new Map();

  for (const entry of entries || []) {
    if (!entry || entry.v !== TRANSCRIPT_V2 || !entry.sessionKey) continue;
    if (entry.kind !== 'context_compaction') continue;
    compactionStates.set(entry.sessionKey, {
      entry,
      compactedThroughLine: entry.compaction && Number.isFinite(entry.compaction.compactedThroughLine)
        ? entry.compaction.compactedThroughLine
        : 0,
      preservedLines: new Set(Array.isArray(entry.compaction && entry.compaction.preservedLines)
        ? entry.compaction.preservedLines
        : []),
    });
  }

  for (const entry of entries || []) {
    if (!entry) continue;
    const compactionState = entry.v === TRANSCRIPT_V2 && entry.sessionKey
      ? compactionStates.get(entry.sessionKey) || null
      : null;
    if (entryIsCompactedAway(entry, compactionState)) continue;
    if (entry.display === false && !(entry.kind === 'context_compaction' && options.includeCompactionSummary)) continue;

    if (entry.v !== TRANSCRIPT_V2) {
      if (entry.role === 'user') {
        messages.push({ type: 'user', text: entry.text || '' });
      } else if (entry.role === 'controller') {
        const label = controllerLabelFor(entry.controllerCli || (manifest && manifest.controller && manifest.controller.cli));
        if (entry.text === '[STOP]') {
          messages.push({ type: 'stop', label });
        } else {
          messages.push({ type: 'controller', text: entry.text || '', label });
        }
      } else if (entry.role === 'claude') {
        messages.push({
          type: 'claude',
          text: (entry.text || '').trim(),
          label: legacyWorkerLabel(manifest, options),
        });
      } else if (entry.role === 'delegation') {
        messages.push({ type: 'controller', text: entry.text || '', label: 'Agent delegation' });
      }
      continue;
    }

    const label = labelForTranscriptEntry(entry, manifest, options);

    if (entry.kind === 'ui_message' && entry.payload && entry.payload.type) {
      if (
        entry.payload.type === 'chatScreenshot' &&
        (
          (entry.payload.data && canonicalScreenshotData.has(entry.payload.data)) ||
          (entry.sessionKey && canonicalScreenshotSessions.has(entry.sessionKey))
        )
      ) {
        continue;
      }
      messages.push(clone(entry.payload));
      continue;
    }

    if (entry.kind === 'user_message') {
      messages.push({ type: 'user', text: entry.text != null ? entry.text : extractTextContent(entry.payload && entry.payload.content) });
      continue;
    }
    if (entry.kind === 'controller_message') {
      if (entry.text === '[STOP]') {
        messages.push({ type: 'stop', label });
      } else {
        messages.push({ type: 'controller', text: entry.text || '', label });
      }
      continue;
    }
    if (entry.kind === 'assistant_message') {
      const text = entry.text != null ? entry.text : extractTextContent(entry.payload && entry.payload.content);
      if (text) {
        messages.push({ type: 'claude', text: String(text).trim(), label });
      }
      continue;
    }
    if (entry.kind === 'context_compaction') {
      if (options.includeCompactionSummary && entry.text) {
        messages.push({ type: 'banner', text: `Compacted earlier context for ${label}: ${entry.text}` });
      }
      continue;
    }
    if (entry.kind === 'launch' || entry.kind === 'delegation') {
      messages.push({ type: 'controller', text: entry.text || '', label });
      continue;
    }
    if (entry.kind === 'tool_call') {
      const fullToolName = entry.toolName || (entry.payload && entry.payload.function && entry.payload.function.name) || '';
      const input = entry.input || parseToolInput(entry.payload && entry.payload.function && entry.payload.function.arguments);
      const toolName = baseToolName(fullToolName);
      const cardId = entry.toolCallId ? `tx-${entry.toolCallId}` : `tx-${entry.__lineNumber || messages.length}`;
      const cardMessages = buildStartCardMessages(toolName, input, label, cardId);
      if (cardMessages.length > 0) {
        messages.push(...cardMessages);
      } else if (!entry.toolCallId || !completedToolCallIds.has(entry.toolCallId)) {
        messages.push({
          type: 'toolCall',
          label,
          text: toolCallSummary(fullToolName, input),
          isComputerUse: fullToolName.includes('computer_control') || fullToolName.includes('computer-control') || fullToolName.includes('chrome_devtools') || fullToolName.includes('chrome-devtools'),
          isChromeDevtools: fullToolName.includes('chrome_devtools') || fullToolName.includes('chrome-devtools'),
        });
      }
      continue;
    }
    if (entry.kind === 'tool_result') {
      const toolName = baseToolName(entry.toolName);
      const cardId = entry.toolCallId ? `tx-${entry.toolCallId}` : `tx-${entry.__lineNumber || messages.length}`;
      const cardMessages = buildCardMessages(toolName, entry.input || {}, entry.result || {}, label, cardId);
      if (cardMessages.length > 0) {
        messages.push(...cardMessages);
      }
      messages.push(...screenshotMessagesFromResult(entry.result));
      continue;
    }
    if (entry.kind === 'backend_event' && entry.payload && typeof entry.payload === 'object') {
      const raw = entry.payload;
      if (String(entry.backend || '').includes(':claude')) {
        const stateKey = `${entry.sessionKey}:${entry.agentId || ''}`;
        const summary = summarizeClaudeEvent(raw);
        if (!summary) continue;
        if (summary.kind === 'tool-start') {
          pendingClaudeTools.set(`${stateKey}:${summary.index}`, { name: summary.toolName, inputJson: '' });
          continue;
        }
        if (summary.kind === 'tool-input-delta') {
          const pending = pendingClaudeTools.get(`${stateKey}:${summary.index}`);
          if (pending) pending.inputJson += summary.text;
          continue;
        }
        if (summary.kind === 'block-stop') {
          const pending = pendingClaudeTools.get(`${stateKey}:${summary.index}`);
          if (!pending) continue;
          let input = {};
          try { input = JSON.parse(pending.inputJson); } catch {}
          const fullToolName = pending.name;
          const toolName = baseToolName(fullToolName);
          const cardId = `tx-claude-${stateKey}-${summary.index}`;
          const cardMessages = buildCardMessages(toolName, input, {}, label, cardId);
          if (cardMessages.length > 0) {
            messages.push(...cardMessages);
          } else {
            messages.push({
              type: 'toolCall',
              label,
              text: toolCallSummary(fullToolName, input),
              isComputerUse: fullToolName.startsWith('mcp__computer-control__') || fullToolName.startsWith('mcp__chrome-devtools__'),
              isChromeDevtools: fullToolName.startsWith('mcp__chrome-devtools__'),
            });
          }
          pendingClaudeTools.delete(`${stateKey}:${summary.index}`);
          continue;
        }
        continue;
      }

      if (raw.item && raw.item.type === 'mcp_tool_call') {
        let input = raw.item.arguments || raw.item.args || {};
        if (typeof input === 'string') input = safeJsonParse(input) || {};
        let output = raw.item.output || raw.item.result || {};
        if (typeof output === 'string') output = safeJsonParse(output) || {};
        const toolName = raw.item.tool || '';
        const cardId = raw.item.id ? `tx-mcp-${raw.item.id}` : `tx-mcp-${entry.__lineNumber || messages.length}`;
        if (raw.type === 'item.started') {
          const cfg = CARD_MAP[toolName];
          if (cfg) {
            const fieldValue = cfg.field && input ? input[cfg.field] : null;
            const detail = fieldValue ? String(fieldValue) : '';
            const msg = {
              type: 'mcpCardStart',
              id: cardId,
              label,
              icon: cfg.icon || '',
              text: cfg.startText || cfg.text || toolName,
              detail,
            };
            if (cfg.template === 'command') msg.template = 'command';
            messages.push(msg);
          } else {
            messages.push({
              type: 'toolCall',
              label,
              text: toolCallSummary(toolName, input),
              isComputerUse: String(raw.item.server || '').includes('computer-control') || String(raw.item.server || '').includes('computer_control') || String(raw.item.server || '').includes('chrome-devtools') || String(raw.item.server || '').includes('chrome_devtools'),
              isChromeDevtools: String(raw.item.server || '').includes('chrome-devtools') || String(raw.item.server || '').includes('chrome_devtools'),
            });
          }
          continue;
        }
        if (raw.type === 'item.completed') {
          const cardMessages = buildCardMessages(toolName, input, output, label, cardId);
          if (cardMessages.length > 0) {
            messages.push(...cardMessages);
          } else {
            messages.push({
              type: 'toolCall',
              label,
              text: toolCallSummary(toolName, input),
              isComputerUse: String(raw.item.server || '').includes('computer-control') || String(raw.item.server || '').includes('computer_control') || String(raw.item.server || '').includes('chrome-devtools') || String(raw.item.server || '').includes('chrome_devtools'),
              isChromeDevtools: String(raw.item.server || '').includes('chrome-devtools') || String(raw.item.server || '').includes('chrome_devtools'),
            });
          }
          if (output && output.content) {
            messages.push(...screenshotMessagesFromResult(output));
          }
          continue;
        }
      }
    }
  }

  return messages;
}

function buildMergedRunView(entries, manifest, options = {}) {
  const view = [];
  const messages = buildTranscriptDisplayMessages(entries, manifest, { ...options, includeCompactionSummary: true });
  for (const msg of messages) {
    if (msg.type === 'user') {
      if (
        typeof msg.text === 'string' &&
        (msg.text.startsWith('[AUTO-CONTINUE]') ||
         msg.text.startsWith('[CONTROLLER GUIDANCE]') ||
         msg.text.startsWith('[ORCHESTRATE]'))
      ) {
        continue;
      }
      view.push(`User: ${msg.text || ''}`);
    } else if (msg.type === 'controller') {
      view.push(`${msg.label || 'Controller'}: ${msg.text || ''}`);
    } else if (msg.type === 'claude' || msg.type === 'mdLine') {
      view.push(`${msg.label || 'Worker'}: ${msg.text || ''}`);
    } else if (msg.type === 'line') {
      view.push(`${msg.label || ''}: ${msg.text || ''}`);
    } else if (msg.type === 'toolCall') {
      view.push(`${msg.label || 'Worker'} tool: ${msg.text || ''}`);
    } else if (msg.type === 'stop') {
      view.push(`${msg.label || 'Controller'}: STOP`);
    } else if (msg.type === 'error') {
      view.push(`Error: ${msg.text || ''}`);
    } else if (msg.type === 'banner') {
      view.push(`System: ${msg.text || ''}`);
    } else if (msg.type === 'shell') {
      view.push(`Shell: ${msg.text || ''}`);
    }
  }
  return view;
}

module.exports = {
  TRANSCRIPT_V2,
  DEFAULT_TRANSCRIPT_TAIL_INITIAL_BYTES,
  DEFAULT_TRANSCRIPT_TAIL_MAX_BYTES,
  TRANSCRIPT_TAIL_TRUNCATION_BANNER,
  agentIdFromSessionKey,
  appendTranscriptRecord,
  buildDisplayMessageTail,
  buildTranscriptDisplayTail,
  buildTranscriptTail,
  buildMergedRunView,
  buildSessionReplay,
  buildStartCardMessages,
  buildTranscriptDisplayMessages,
  countDisplayMessageChars,
  countJsonlLinesSync,
  controllerSessionKey,
  countTranscriptLinesSync,
  createTranscriptRecord,
  hasTranscriptV2,
  labelForTranscriptEntry,
  providerMessagesForToolResult,
  readTranscriptEntries,
  readTranscriptTailEntries,
  readTranscriptEntriesSync,
  readTranscriptTailEntriesSync,
  summarizeToolResult,
  latestSessionCompaction,
  entryIsCompactedAway,
  transcriptBackend,
  transcriptLineSlice,
  visibleTextForDisplayMessage,
  workerSessionKey,
};
