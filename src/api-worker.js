/**
 * API-based worker runner.
 * Replaces Codex/Claude CLI with direct LLM API calls via LLMClient.
 * Uses the unified tool bridge for all tool execution (built-in + MCP).
 */
const { LLMClient, resolveApiKey, defaultModelForProvider } = require('./llm-client');
const { loadAllTools, executeTool } = require('./mcp-tool-bridge');
const { renderStartCard, renderCompleteCard } = require('./mcp-cards');
const { buildAgentWorkerSystemPrompt } = require('./prompts');
const { buildPromptsDirs } = require('./prompt-tags');
const { lookupAgentConfig } = require('./state');
const { workerLabelFor } = require('./render');
const { baseToolName } = require('./turn-entity-tracker');
const { compactApiSessionHistory } = require('./api-compaction');
const {
  appendTranscriptRecord,
  buildSessionReplay,
  createTranscriptRecord,
  hasTranscriptV2,
  providerMessagesForToolResult,
  readTranscriptEntries,
  summarizeToolResult,
  transcriptBackend,
  workerSessionKey,
} = require('./transcript');

function parseToolInput(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return {};
  }
}

/**
 * Run a single API worker turn with streaming and multi-turn tool calling.
 *
 * @param {object} opts
 * @param {object} opts.manifest - Run manifest
 * @param {object} opts.request - Current request
 * @param {object} opts.loop - Current loop
 * @param {object} opts.workerRecord - Worker record to populate
 * @param {string} opts.prompt - User/controller prompt for this turn
 * @param {object} opts.renderer - Renderer for streaming output
 * @param {function} opts.emitEvent - Event logger
 * @param {AbortSignal} [opts.abortSignal] - Abort signal
 * @param {string} [opts.agentId] - Agent ID
 */
async function runApiWorkerTurn({
  manifest,
  request,
  loop,
  workerRecord,
  prompt,
  visiblePrompt = null,
  renderer,
  emitEvent,
  abortSignal,
  agentId,
  turnTracker = null,
  compactSessionHistory = compactApiSessionHistory,
}) {
  const isCustomAgent = agentId && agentId !== 'default';
  const agentConfig = isCustomAgent ? lookupAgentConfig(manifest.agents, agentId) : null;
  const agentName = agentConfig ? agentConfig.name : null;
  const label = workerLabelFor('api', agentName);
  // Temporarily override renderer workerLabel for this agent turn (same as codex-worker)
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = label;
  const manifestSessionKey = agentId || 'default';
  const localSessionKey = workerSessionKey(agentId);
  const backend = transcriptBackend('worker', 'api');

  // Resolve API config: agent-level overrides → manifest worker config → manifest global
  const apiConfig = manifest.worker.apiConfig || manifest.apiConfig || {};
  const provider = (agentConfig && agentConfig.provider) || apiConfig.provider || 'openrouter';
  const apiKey = resolveApiKey(provider, apiConfig.apiKey);
  const baseURL = apiConfig.baseURL || null;
  const model = (agentConfig && agentConfig.model) || apiConfig.model || defaultModelForProvider(provider);
  const thinking = (agentConfig && agentConfig.thinking) || apiConfig.thinking || null;

  if (!model) {
    throw new Error(`No default model configured for provider "${provider}". Specify a model explicitly.`);
  }

  const client = new LLMClient({ provider, apiKey, baseURL, model });

  // Build system prompt
  const promptsDirs = buildPromptsDirs(manifest.repoRoot);
  let systemPrompt = buildAgentWorkerSystemPrompt(
    agentConfig,
    manifest.selfTesting
      ? { selfTesting: true, selfTestPrompts: manifest.selfTestPrompts, repoRoot: manifest.repoRoot }
      : { repoRoot: manifest.repoRoot },
    promptsDirs
  );

  systemPrompt += '\n\n## API Mode Tools\nYou are running in API mode. Your built-in tools (prefixed with builtin_tools__) are your primary tools for file and command operations:\n- builtin_tools__read_file — Read files\n- builtin_tools__write_file — Write/create files\n- builtin_tools__edit_file — Edit files (find and replace)\n- builtin_tools__run_command — Execute shell commands\n- builtin_tools__list_directory — List directory contents\n- builtin_tools__glob_search — Find files by pattern\n- builtin_tools__grep_search — Search file contents\n\nUse these tools freely. The detached-command MCP is also available for long-running background processes that need to persist across turns.';

  // Load ALL tools through unified bridge (cached — won't reconnect if config unchanged)
  const allMcpServers = { ...(manifest.workerMcpServers || {}), ...((agentConfig && agentConfig.mcps) || {}) };
  if (manifest.chromeDebugPort) {
    for (const [, server] of Object.entries(allMcpServers)) {
      if (server && server.args) {
        server.args = server.args.map((arg) => typeof arg === 'string'
          ? arg.replace('{CHROME_DEBUG_PORT}', manifest.chromeDebugPort)
          : arg);
      }
    }
  }
  const tools = await loadAllTools(allMcpServers, manifest.repoRoot);

  if (!manifest.worker.agentSessions) manifest.worker.agentSessions = {};
  if (!manifest.worker.agentSessions[manifestSessionKey]) {
    manifest.worker.agentSessions[manifestSessionKey] = { lastSeenChatLine: 0, lastSeenTranscriptLine: 0 };
  }
  const agentSession = manifest.worker.agentSessions[manifestSessionKey];
  if (!Number.isFinite(agentSession.lastSeenChatLine)) {
    agentSession.lastSeenChatLine = 0;
  }
  if (!Number.isFinite(agentSession.lastSeenTranscriptLine)) {
    agentSession.lastSeenTranscriptLine = 0;
  }
  const recordedPrompt = visiblePrompt == null ? prompt : visiblePrompt;

  const transcriptEntries = manifest.files && manifest.files.transcript
    ? await readTranscriptEntries(manifest.files.transcript)
    : [];
  const sessionEntries = transcriptEntries.filter((entry) => entry && entry.v === 2 && entry.sessionKey === localSessionKey);
  const lastSessionEntry = sessionEntries[sessionEntries.length - 1] || null;
  const promptAlreadyRecorded = !!lastSessionEntry &&
    lastSessionEntry.kind === 'user_message' &&
    lastSessionEntry.requestId === request.id &&
    lastSessionEntry.text === recordedPrompt &&
    (lastSessionEntry.loopIndex == null || lastSessionEntry.loopIndex === loop.index);
  const shouldAppendPromptRecord = !promptAlreadyRecorded;

  let replayEntries = transcriptEntries;
  if (shouldAppendPromptRecord) {
    const userEntry = createTranscriptRecord({
      kind: 'user_message',
      sessionKey: localSessionKey,
      backend: 'user',
      requestId: request.id,
      loopIndex: loop.index,
      agentId: isCustomAgent ? agentId : null,
      workerCli: 'api',
      text: recordedPrompt,
      payload: { role: 'user', content: recordedPrompt },
    });
    await appendTranscriptRecord(manifest, userEntry);
    replayEntries = [...transcriptEntries, userEntry];
  }
  const canonicalHistoryAvailable = hasTranscriptV2(replayEntries);

  let messages;
  if (canonicalHistoryAvailable) {
    messages = null;
  } else if (Array.isArray(agentSession.apiMessages) && agentSession.apiMessages.length > 0) {
    const legacyHistory = agentSession.apiMessages[0] && agentSession.apiMessages[0].role === 'system'
      ? agentSession.apiMessages.slice(1)
      : agentSession.apiMessages;
    messages = [{ role: 'system', content: systemPrompt }, ...legacyHistory, { role: 'user', content: prompt }];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];
  }

  async function buildCanonicalMessages({ forceCompact = false } = {}) {
    if (!manifest.files || !manifest.files.transcript) {
      return [{ role: 'system', content: systemPrompt }];
    }
    if (typeof compactSessionHistory === 'function') {
      await compactSessionHistory({
        manifest,
        sessionKey: localSessionKey,
        backend,
        requestId: request.id,
        loopIndex: loop.index,
        provider,
        apiKey,
        baseURL,
        model,
        thinking,
        force: forceCompact,
        signal: abortSignal,
        emitEvent,
      });
    }
    const refreshedEntries = await readTranscriptEntries(manifest.files.transcript);
    return [
      { role: 'system', content: systemPrompt },
      ...buildSessionReplay(refreshedEntries, localSessionKey),
    ];
  }

  emitEvent({ source: 'worker-api', type: 'start', agentId, model, provider });
  renderer.claude(`Using ${provider}/${model}`);

  let iterations = 0;
  let finalText = '';
  let totalUsage = { promptTokens: 0, completionTokens: 0 };

  while (true) {
    iterations++;

    if (abortSignal && abortSignal.aborted) {
      renderer.claude('(aborted)');
      break;
    }

    if (canonicalHistoryAvailable) {
      messages = await buildCanonicalMessages();
    }

    const textParts = [];
    let toolCalls = null;
    let usage = null;

    for await (const event of client.streamChat(messages, tools, { thinking, signal: abortSignal })) {
      if (event.type === 'text') {
        textParts.push(event.content);
        renderer.streamMarkdown(label, event.content);
      } else if (event.type === 'done') {
        toolCalls = event.toolCalls;
        usage = event.usage;
        if (event.text) renderer.flushStream();
      }
    }

    const responseText = textParts.join('');
    if (usage) {
      totalUsage.promptTokens += usage.promptTokens || 0;
      totalUsage.completionTokens += usage.completionTokens || 0;
    }

    if (!toolCalls || toolCalls.length === 0) {
      finalText = responseText;
      if (finalText || responseText === '') {
        const assistantEntry = createTranscriptRecord({
          kind: 'assistant_message',
          sessionKey: localSessionKey,
          backend,
          requestId: request.id,
          loopIndex: loop.index,
          agentId: isCustomAgent ? agentId : null,
          workerCli: 'api',
          text: finalText,
          payload: { role: 'assistant', content: finalText },
        });
        await appendTranscriptRecord(manifest, assistantEntry);
      }
      break;
    }

    const assistantMessage = {
      role: 'assistant',
      content: responseText || '',
      tool_calls: toolCalls,
    };
    if (!canonicalHistoryAvailable) {
      messages.push(assistantMessage);
    }
    await appendTranscriptRecord(manifest, createTranscriptRecord({
      kind: 'assistant_message',
      sessionKey: localSessionKey,
      backend,
      requestId: request.id,
      loopIndex: loop.index,
      agentId: isCustomAgent ? agentId : null,
      workerCli: 'api',
      text: responseText || '',
      payload: assistantMessage,
    }));

    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      const baseName = baseToolName(toolName);
      const toolArgs = tc.function.arguments;
      const parsedInput = parseToolInput(toolArgs);
      const argsPreview = parsedInput.path || parsedInput.command || parsedInput.pattern || '';
      const cardId = tc.id ? `api-${tc.id}` : `api-${request.id}-${iterations}-${messages.length}`;

      const isChromeDevtools = toolName.includes('chrome_devtools') || toolName.includes('chrome-devtools');
      const isComputerUse = isChromeDevtools || toolName.includes('computer_control') || toolName.includes('computer-control');
      const cardMeta = { isComputerUse, isChromeDevtools };
      const renderedStartCard = renderStartCard(baseName, parsedInput, renderer, label, cardId, cardMeta);
      if (!renderedStartCard) {
        renderer.claude(`Calling ${toolName}${argsPreview ? ': ' + argsPreview : ''}`);
      }

      emitEvent({ source: 'worker-api', type: 'tool_call', name: toolName, args: toolArgs });
      await appendTranscriptRecord(manifest, createTranscriptRecord({
        kind: 'tool_call',
        sessionKey: localSessionKey,
        backend,
        requestId: request.id,
        loopIndex: loop.index,
        agentId: isCustomAgent ? agentId : null,
        workerCli: 'api',
        toolCallId: tc.id,
        toolName,
        input: parsedInput,
        payload: tc,
      }));

      const result = await executeTool(tc, allMcpServers, manifest.repoRoot);
      const toolResultEntry = createTranscriptRecord({
        kind: 'tool_result',
        sessionKey: localSessionKey,
        backend,
        requestId: request.id,
        loopIndex: loop.index,
        agentId: isCustomAgent ? agentId : null,
        workerCli: 'api',
        toolCallId: tc.id,
        toolName,
        input: parsedInput,
        text: summarizeToolResult(result),
        result,
      });
      await appendTranscriptRecord(manifest, toolResultEntry);
      if (!canonicalHistoryAvailable) {
        messages.push(...providerMessagesForToolResult(toolResultEntry));
      }

      const renderedCompleteCard = renderCompleteCard(baseName, parsedInput, result, renderer, label, cardId, cardMeta);
      if (!renderedCompleteCard) {
        renderer.claude(`Finished ${toolName}`);
      }
      if (turnTracker) {
        turnTracker.noteRenderedToolCard(baseName, parsedInput, label);
        await turnTracker.noteToolCompletion(baseName, parsedInput, result, label);
      }
      emitEvent({
        source: 'worker-api',
        type: 'tool_result',
        name: toolName,
        resultLength: JSON.stringify(result).length,
      });
    }
  }

  agentSession.sessionId = localSessionKey;
  agentSession.hasStarted = true;
  if (!canonicalHistoryAvailable) {
    agentSession.apiMessages = messages.concat(finalText ? [{ role: 'assistant', content: finalText }] : []);
  } else {
    delete agentSession.apiMessages;
  }

  workerRecord.resultText = finalText;
  workerRecord.exitCode = 0;
  workerRecord.sessionId = localSessionKey;

  emitEvent({
    source: 'worker-api',
    type: 'complete',
    iterations,
    totalUsage,
    resultLength: finalText.length,
  });

  renderer.workerLabel = prevWorkerLabel;
  return {
    prompt: recordedPrompt,
    exitCode: 0,
    signal: null,
    sessionId: localSessionKey,
    hadTextDelta: finalText.length > 0,
    resultText: finalText,
    finalEvent: null,
  };
}

module.exports = { runApiWorkerTurn };
