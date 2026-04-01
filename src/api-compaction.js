const { LLMClient, resolveApiKey, defaultModelForProvider } = require('./llm-client');
const {
  appendTranscriptRecord,
  buildSessionReplay,
  createTranscriptRecord,
  entryIsCompactedAway,
  latestSessionCompaction,
  providerMessagesForToolResult,
  readTranscriptEntries,
  workerSessionKey,
} = require('./transcript');

const DEFAULT_COMPACTION_TRIGGER_MESSAGES = 500;
const DEFAULT_KEEP_RECENT_MESSAGES = 100;
const DEFAULT_FORCE_KEEP_RECENT_MESSAGES = 20;

function extractMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content.map((part) => {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
    if (part.type === 'image_url') return '[Image preserved separately]';
    return '';
  }).filter(Boolean).join('\n');
}

function replayMessageCountForEntry(entry) {
  if (!entry || entry.v !== 2) return 0;
  if (entry.kind === 'user_message' || entry.kind === 'assistant_message') return 1;
  if (entry.kind === 'tool_result') return providerMessagesForToolResult(entry).length;
  if (entry.kind === 'context_compaction') return 1;
  return 0;
}

function currentReplayEntries(entries, sessionKey) {
  const compactionState = latestSessionCompaction(entries, sessionKey);
  return (entries || []).filter((entry) => {
    if (!entry || entry.v !== 2 || entry.sessionKey !== sessionKey) return false;
    return !entryIsCompactedAway(entry, compactionState);
  });
}

function buildAssistantToolCallLineMap(entries, sessionKey) {
  const lineByToolCallId = new Map();
  for (const entry of entries || []) {
    if (!entry || entry.v !== 2 || entry.sessionKey !== sessionKey) continue;
    if (entry.kind !== 'assistant_message') continue;
    const toolCalls = entry.payload && Array.isArray(entry.payload.tool_calls)
      ? entry.payload.tool_calls
      : [];
    for (const toolCall of toolCalls) {
      if (toolCall && toolCall.id) {
        lineByToolCallId.set(toolCall.id, entry.__lineNumber);
      }
    }
  }
  return lineByToolCallId;
}

function imagePreservationInfo(entries, sessionKey) {
  const allLines = new Set();
  const assistantLines = buildAssistantToolCallLineMap(entries, sessionKey);
  let latestImageEntry = null;
  for (const entry of currentReplayEntries(entries, sessionKey)) {
    if (!entry || entry.kind !== 'tool_result') continue;
    const messageParts = providerMessagesForToolResult(entry);
    const hasImage = messageParts.some((message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part && part.type === 'image_url')
    );
    if (!hasImage) continue;
    if (!latestImageEntry || (entry.__lineNumber || 0) > (latestImageEntry.__lineNumber || 0)) {
      latestImageEntry = entry;
    }
    if (entry.__lineNumber) allLines.add(entry.__lineNumber);
    if (entry.toolCallId && assistantLines.has(entry.toolCallId)) allLines.add(assistantLines.get(entry.toolCallId));
  }
  const preservedLines = new Set();
  if (latestImageEntry) {
    if (latestImageEntry.__lineNumber) preservedLines.add(latestImageEntry.__lineNumber);
    if (latestImageEntry.toolCallId && assistantLines.has(latestImageEntry.toolCallId)) {
      preservedLines.add(assistantLines.get(latestImageEntry.toolCallId));
    }
  }
  return {
    allLines,
    preservedLines,
  };
}

function compactableEntries(entries, sessionKey) {
  return currentReplayEntries(entries, sessionKey)
    .filter((entry) => entry.kind !== 'context_compaction')
    .sort((a, b) => (a.__lineNumber || 0) - (b.__lineNumber || 0));
}

function selectEntriesToKeep(entries, preserveLines, keepRecentMessages, excludedRecentLines = new Set()) {
  const keepLines = new Set(preserveLines);
  let remaining = keepRecentMessages;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const lineNumber = entry.__lineNumber || 0;
    if (keepLines.has(lineNumber)) continue;
    if (excludedRecentLines.has(lineNumber)) continue;
    if (remaining <= 0) break;
    keepLines.add(lineNumber);
    remaining -= replayMessageCountForEntry(entry);
  }
  return keepLines;
}

function compactionInputText(entries, sessionKey) {
  const lines = [];
  const latestCompaction = latestSessionCompaction(entries, sessionKey);
  if (latestCompaction && latestCompaction.entry && latestCompaction.entry.text) {
    lines.push('Previous compacted summary:');
    lines.push(latestCompaction.entry.text);
    lines.push('');
  }
  const replayMessages = [];
  for (const entry of entries) {
    if (entry.kind === 'user_message' && entry.payload && entry.payload.role === 'user') {
      replayMessages.push(cloneMessage(entry.payload));
      continue;
    }
    if (entry.kind === 'assistant_message' && entry.payload && entry.payload.role === 'assistant') {
      replayMessages.push(cloneMessage(entry.payload));
      continue;
    }
    if (entry.kind === 'tool_result') {
      replayMessages.push(...providerMessagesForToolResult(entry));
    }
  }
  for (const message of replayMessages) {
    if (!message) continue;
    if (message.role === 'user') {
      const text = extractMessageText(message);
      if (text) lines.push(`User: ${text}`);
      continue;
    }
    if (message.role === 'assistant') {
      const text = extractMessageText(message);
      if (text) lines.push(`Assistant: ${text}`);
      continue;
    }
    if (message.role === 'tool') {
      const text = extractMessageText(message) || String(message.content || '');
      if (text) lines.push(`Tool result: ${text}`);
    }
  }
  return lines.join('\n').trim();
}

function cloneMessage(message) {
  return message == null ? message : JSON.parse(JSON.stringify(message));
}

async function generateCompactionSummary({
  provider,
  apiKey,
  baseURL,
  model,
  thinking,
  inputText,
  signal,
}) {
  const resolvedApiKey = resolveApiKey(provider, apiKey);
  const client = new LLMClient({ provider, apiKey: resolvedApiKey, baseURL, model });
  const response = await client.chat([
    {
      role: 'system',
      content:
        'Summarize earlier conversation context for future continuation in the same agent/controller session. ' +
        'Preserve goals, important findings, files or areas worked on, test/task/bug state, tool outcomes, visual conclusions, and the most useful next steps. ' +
        'Be concise but decision-complete. Do not include markdown headings.',
    },
    {
      role: 'user',
      content: inputText,
    },
  ], null, { thinking, signal });
  return String((response && response.text) || '').trim();
}

async function compactApiSessionHistory({
  manifest,
  sessionKey,
  backend,
  requestId = null,
  loopIndex = null,
  provider,
  apiKey,
  baseURL,
  model,
  thinking = null,
  force = false,
  signal,
  triggerMessages = DEFAULT_COMPACTION_TRIGGER_MESSAGES,
  keepRecentMessages = DEFAULT_KEEP_RECENT_MESSAGES,
  forcedKeepRecentMessages = DEFAULT_FORCE_KEEP_RECENT_MESSAGES,
  emitEvent = null,
}) {
  if (!manifest || !manifest.files || !manifest.files.transcript || !sessionKey) {
    return { performed: false, reason: 'missing-session' };
  }

  const entries = await readTranscriptEntries(manifest.files.transcript);
  const replayMessages = buildSessionReplay(entries, sessionKey);
  const replayMessageCount = replayMessages.length;
  if (!model) {
    return { performed: false, reason: 'missing-model', replayMessageCount };
  }
  if (!force && replayMessageCount <= triggerMessages) {
    return { performed: false, reason: 'below-threshold', replayMessageCount };
  }

  const candidates = compactableEntries(entries, sessionKey);
  if (candidates.length === 0) {
    return { performed: false, reason: 'nothing-to-compact', replayMessageCount };
  }

  const imageLines = imagePreservationInfo(entries, sessionKey);
  const preservedLines = imageLines.preservedLines;
  const excludedRecentLines = new Set(
    Array.from(imageLines.allLines).filter((lineNumber) => !preservedLines.has(lineNumber))
  );
  const keepLines = selectEntriesToKeep(
    candidates,
    preservedLines,
    force ? forcedKeepRecentMessages : keepRecentMessages,
    excludedRecentLines
  );
  let compactAway = candidates.filter((entry) => !keepLines.has(entry.__lineNumber || 0));
  if (force && compactAway.length === 0) {
    compactAway = candidates.filter((entry) => !preservedLines.has(entry.__lineNumber || 0));
  }
  if (compactAway.length === 0) {
    return { performed: false, reason: 'nothing-eligible', replayMessageCount };
  }

  const summaryInput = compactionInputText(compactAway, sessionKey);
  if (!summaryInput) {
    return { performed: false, reason: 'empty-summary-input', replayMessageCount };
  }

  const summary = await generateCompactionSummary({
    provider,
    apiKey,
    baseURL,
    model,
    thinking,
    inputText: summaryInput,
    signal,
  });
  if (!summary) {
    return { performed: false, reason: 'empty-summary', replayMessageCount };
  }

  const compactedThroughLine = Math.max(...compactAway.map((entry) => entry.__lineNumber || 0));
  const preservedLineNumbers = Array.from(preservedLines)
    .filter((lineNumber) => lineNumber <= compactedThroughLine)
    .sort((a, b) => a - b);
  const compactionRecord = createTranscriptRecord({
    kind: 'context_compaction',
    sessionKey,
    backend,
    requestId,
    loopIndex,
    text: summary,
    payload: {
      role: 'assistant',
      content: `Conversation summary (generated by context compaction):\n${summary}`,
    },
    compaction: {
      compactedThroughLine,
      preservedLines: preservedLineNumbers,
      replayMessageCountBefore: replayMessageCount,
      force: !!force,
    },
    display: false,
  });
  await appendTranscriptRecord(manifest, compactionRecord);

  if (typeof emitEvent === 'function') {
    await emitEvent({
      source: 'context-compaction',
      type: 'context_compaction',
      sessionKey,
      replayMessageCountBefore: replayMessageCount,
      compactedThroughLine,
      forced: !!force,
    });
  }

  const updatedEntries = await readTranscriptEntries(manifest.files.transcript);
  return {
    performed: true,
    summary,
    replayMessageCountBefore: replayMessageCount,
    replayMessageCountAfter: buildSessionReplay(updatedEntries, sessionKey).length,
    compactedThroughLine,
  };
}

function currentApiSessionTarget({
  manifest,
  target = 'controller',
  directAgent = null,
  workerCli = null,
  controllerCli = null,
}) {
  if (!manifest) return null;

  if (target === 'controller') {
    const cli = controllerCli || (manifest.controller && manifest.controller.cli) || 'codex';
    if (cli !== 'api') return null;
    const config = (manifest.controller && manifest.controller.apiConfig) || manifest.apiConfig || {};
    return {
      sessionKey: 'controller:main',
      backend: 'controller:api',
      provider: config.provider || 'openrouter',
      baseURL: config.baseURL || null,
      model: config.model || defaultModelForProvider(config.provider || 'openrouter'),
      thinking: config.thinking || null,
    };
  }

  const agentId = target === 'worker-default' ? null : (directAgent || null);
  const agentConfig = agentId && manifest.agents ? manifest.agents[agentId] : null;
  const cli = (agentConfig && agentConfig.cli) || workerCli || (manifest.worker && manifest.worker.cli) || 'codex';
  if (cli !== 'api') return null;
  const config = (manifest.worker && manifest.worker.apiConfig) || manifest.apiConfig || {};
  return {
    sessionKey: workerSessionKey(agentId),
    backend: 'worker:api',
    provider: (agentConfig && agentConfig.provider) || config.provider || 'openrouter',
    baseURL: config.baseURL || null,
    model: (agentConfig && agentConfig.model) || config.model || defaultModelForProvider((agentConfig && agentConfig.provider) || config.provider || 'openrouter'),
    thinking: (agentConfig && agentConfig.thinking) || config.thinking || null,
    agentId,
  };
}

function describeCompactionResult(result, label = 'Current session') {
  if (!result || !result.performed) {
    const reason = result && result.reason;
    if (reason === 'below-threshold') {
      return `${label} is below the auto-compaction threshold (${result.replayMessageCount || 0} messages).`;
    }
    if (reason === 'nothing-to-compact' || reason === 'nothing-eligible') {
      return `${label} has nothing compactable right now.`;
    }
    if (reason === 'empty-summary-input' || reason === 'empty-summary') {
      return `${label} could not be compacted because there was nothing summarizable.`;
    }
    if (reason === 'missing-model') {
      return `${label} cannot be compacted because no API model is configured.`;
    }
    return `${label} could not be compacted right now.`;
  }
  return `${label} compacted successfully (${result.replayMessageCountBefore} -> ${result.replayMessageCountAfter} replay messages).`;
}

module.exports = {
  DEFAULT_COMPACTION_TRIGGER_MESSAGES,
  compactApiSessionHistory,
  currentApiSessionTarget,
  describeCompactionResult,
};
