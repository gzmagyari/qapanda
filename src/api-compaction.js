const { LLMClient, resolveApiKey, defaultModelForProvider } = require('./llm-client');
const { resolveRuntimeApiProvider } = require('./api-provider-registry');
const {
  appendApiResponseLog,
  compactionApiLogFiles,
  createStreamApiLogHooks,
} = require('./api-io-log');
const { buildPromptCacheContext } = require('./prompt-cache');
const { saveManifest } = require('./state');
const {
  appendTranscriptRecord,
  buildSessionReplay,
  buildSessionReplaySegments,
  createTranscriptRecord,
  entryIsCompactedAway,
  latestSessionCompaction,
  providerMessagesForToolResult,
  readTranscriptEntries,
  workerSessionKey,
} = require('./transcript');
const { applyUsageToManifest, usageActorFromBackend, usageSummaryMessage } = require('./usage-summary');

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

function currentReplayEntries(entries, sessionKey) {
  const compactionState = latestSessionCompaction(entries, sessionKey);
  return (entries || []).filter((entry) => {
    if (!entry || entry.v !== 2 || entry.sessionKey !== sessionKey) return false;
    return !entryIsCompactedAway(entry, compactionState);
  });
}

function compactableEntries(entries, sessionKey) {
  return currentReplayEntries(entries, sessionKey)
    .filter((entry) => entry.kind !== 'context_compaction')
    .sort((a, b) => (a.__lineNumber || 0) - (b.__lineNumber || 0));
}

function currentReplaySegments(entries, sessionKey) {
  return buildSessionReplaySegments(entries, sessionKey, {
    inlineImageReplayMode: 'tail-only',
  });
}

function selectSegmentsToKeep(segments, preserveLines, keepRecentMessages) {
  const keepLines = new Set(preserveLines);
  let remaining = keepRecentMessages;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (!segment || !Array.isArray(segment.lines) || segment.lines.length === 0) continue;
    const lineNumbers = segment.lines.filter((lineNumber) => Number.isFinite(lineNumber));
    if (lineNumbers.every((lineNumber) => keepLines.has(lineNumber))) continue;
    if (remaining <= 0) break;
    for (const lineNumber of lineNumbers) {
      keepLines.add(lineNumber);
    }
    remaining -= Number(segment.replayMessageCount || 0);
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
      replayMessages.push(...providerMessagesForToolResult(entry, { includeInlineImages: false }));
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
  manifest,
  sessionKey,
  backend,
  requestId,
  loopIndex,
  provider,
  apiKey,
  baseURL,
  model,
  thinking,
  inputText,
  signal,
  renderer = null,
}) {
  const resolvedProvider = resolveRuntimeApiProvider(provider);
  if (!resolvedProvider) {
    throw new Error(`Unknown API provider "${provider}". Configure it in Settings -> Custom Providers or select a built-in provider.`);
  }
  const resolvedApiKey = resolveApiKey(resolvedProvider.id, apiKey);
  const resolvedBaseURL = resolvedProvider.custom
    ? resolvedProvider.baseURL
    : ((resolvedProvider.legacy ? baseURL : (baseURL || resolvedProvider.baseURL)) || null);
  const client = new LLMClient({
    provider: resolvedProvider.clientProvider,
    apiKey: resolvedApiKey,
    baseURL: resolvedBaseURL,
    model,
  });
  const cacheContext = buildPromptCacheContext({
    providerId: provider,
    model,
    runId: manifest && manifest.runId,
    sessionKey,
    purpose: 'compaction',
  });
  const logFiles = manifest
    ? compactionApiLogFiles(manifest, { requestId, loopIndex, sessionKey })
    : null;
  const logHooks = createStreamApiLogHooks(manifest, logFiles, {
    requestId,
    loopIndex,
    provider,
    model,
    baseURL: resolvedBaseURL,
    thinking,
    messageCount: 2,
    toolCount: 0,
    cacheSupport: cacheContext.cacheSupport,
    cacheMode: cacheContext.cacheMode,
    promptCacheKey: cacheContext.promptCacheKey || null,
  });
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
  ], null, {
    thinking,
    signal,
    promptCache: cacheContext,
    onRequest: logHooks.onRequest,
  });
  if (logFiles && logFiles.responseFile) {
    await appendApiResponseLog(manifest, logFiles.responseFile, {
      type: 'done',
      requestId,
      loopIndex,
      cacheSupport: cacheContext.cacheSupport,
      cacheMode: cacheContext.cacheMode,
      promptCacheKey: cacheContext.promptCacheKey || null,
      finishReason: response && response.finishReason ? response.finishReason : null,
      textLength: response && response.text ? response.text.length : 0,
      usage: response && response.usage ? response.usage : null,
    });
  }
  if (response && response.usage) {
    applyUsageToManifest(manifest, {
      actor: usageActorFromBackend(backend),
      usage: response.usage,
    });
    await saveManifest(manifest);
    if (renderer && typeof renderer.usageStats === 'function') {
      renderer.usageStats(usageSummaryMessage(manifest.usageSummary));
    }
  }
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
  renderer = null,
}) {
  if (!manifest || !manifest.files || !manifest.files.transcript || !sessionKey) {
    return { performed: false, reason: 'missing-session' };
  }

  const entries = await readTranscriptEntries(manifest.files.transcript, { sessionKey });
  const replayMessages = buildSessionReplay(entries, sessionKey, { inlineImageReplayMode: 'tail-only' });
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

  const replaySegments = currentReplaySegments(entries, sessionKey);
  const preservedLines = new Set();
  if (replaySegments[0] && Array.isArray(replaySegments[0].lines)) {
    for (const lineNumber of replaySegments[0].lines) {
      if (Number.isFinite(lineNumber)) preservedLines.add(lineNumber);
    }
  }
  const keepLines = selectSegmentsToKeep(
    replaySegments,
    preservedLines,
    force ? forcedKeepRecentMessages : keepRecentMessages
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
    manifest,
    sessionKey,
    backend,
    requestId,
    loopIndex,
    provider,
    apiKey,
    baseURL,
    model,
    thinking,
    inputText: summaryInput,
    signal,
    renderer,
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

  const updatedEntries = await readTranscriptEntries(manifest.files.transcript, { sessionKey });
  return {
    performed: true,
    summary,
    replayMessageCountBefore: replayMessageCount,
    replayMessageCountAfter: buildSessionReplay(updatedEntries, sessionKey, { inlineImageReplayMode: 'tail-only' }).length,
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
    const providerId = config.provider || 'openrouter';
    const resolvedProvider = resolveRuntimeApiProvider(providerId);
    return {
      sessionKey: 'controller:main',
      backend: 'controller:api',
      provider: providerId,
      baseURL: resolvedProvider && resolvedProvider.custom
        ? resolvedProvider.baseURL
        : ((resolvedProvider && resolvedProvider.legacy ? config.baseURL : (config.baseURL || (resolvedProvider && resolvedProvider.baseURL))) || null),
      model: config.model || defaultModelForProvider(providerId),
      thinking: config.thinking || null,
    };
  }

  const agentId = target === 'worker-default' ? null : (directAgent || null);
  const agentConfig = agentId && manifest.agents ? manifest.agents[agentId] : null;
  const cli = (agentConfig && agentConfig.cli) || workerCli || (manifest.worker && manifest.worker.cli) || 'codex';
  if (cli !== 'api') return null;
  const config = (manifest.worker && manifest.worker.apiConfig) || manifest.apiConfig || {};
  const providerId = (agentConfig && agentConfig.provider) || config.provider || 'openrouter';
  const resolvedProvider = resolveRuntimeApiProvider(providerId);
  return {
    sessionKey: workerSessionKey(agentId),
    backend: 'worker:api',
    provider: providerId,
    baseURL: resolvedProvider && resolvedProvider.custom
      ? resolvedProvider.baseURL
      : ((resolvedProvider && resolvedProvider.legacy ? config.baseURL : (config.baseURL || (resolvedProvider && resolvedProvider.baseURL))) || null),
    model: (agentConfig && agentConfig.model) || config.model || defaultModelForProvider(providerId),
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
