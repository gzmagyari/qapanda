/**
 * API-based worker runner.
 * Replaces Codex/Claude CLI with direct LLM API calls via LLMClient.
 * Uses the unified tool bridge for all tool execution (built-in + MCP).
 */
const { LLMClient, resolveApiKey, defaultModelForProvider } = require('./llm-client');
const { resolveRuntimeApiProvider } = require('./api-provider-registry');
const {
  appendApiResponseLog,
  createStreamApiLogHooks,
  workerApiLogFiles,
} = require('./api-io-log');
const { loadAllTools, executeTool } = require('./mcp-tool-bridge');
const { renderStartCard, renderCompleteCard } = require('./mcp-cards');
const { buildAgentWorkerSystemPrompt } = require('./prompts');
const { buildPromptsDirs } = require('./prompt-tags');
const { buildPromptCacheContext } = require('./prompt-cache');
const { lookupAgentConfig, ensureWorkerSessionState } = require('./state');
const { workerLabelFor } = require('./render');
const { baseToolName } = require('./turn-entity-tracker');
const { compactApiSessionHistory } = require('./api-compaction');
const {
  buildGeminiCacheUsage,
  geminiCacheSessionKey,
  readGeminiCacheEntry,
  refreshGeminiCacheEntry,
} = require('./gemini-cache-store');
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
const http = require('node:http');

const _apiBrowserDebugLog = require('node:path').join(require('node:os').tmpdir(), 'cc-appserver-debug.log');
function _apiBrowserDbg(msg) {
  try { require('node:fs').appendFileSync(_apiBrowserDebugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

function parseToolInput(argumentsValue) {
  if (!argumentsValue) return {};
  if (typeof argumentsValue === 'object') return argumentsValue;
  try {
    return JSON.parse(argumentsValue);
  } catch {
    return {};
  }
}

function _httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function probeChromeDebugPort(port, { httpGet = _httpGetJson } = {}) {
  const normalizedPort = Number(port);
  if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
    return { alive: false, port: null, version: null };
  }
  try {
    const version = await httpGet(`http://127.0.0.1:${normalizedPort}/json/version`);
    return { alive: true, port: normalizedPort, version: version || null };
  } catch {
    return { alive: false, port: normalizedPort, version: null };
  }
}

async function recoverChromeDevtoolsSession(
  manifest,
  agentSession,
  { toolName = null, error = null, httpGet = _httpGetJson, chromeManager = null } = {},
) {
  const boundPort = Number(
    manifest && manifest.chromeDebugPort != null
      ? manifest.chromeDebugPort
      : (agentSession && agentSession.boundBrowserPort != null ? agentSession.boundBrowserPort : null)
  );
  if (!Number.isFinite(boundPort) || boundPort <= 0) {
    _apiBrowserDbg(`chrome recovery skipped: missing bound port tool=${toolName || 'unknown'} error=${error && error.message ? error.message : error || ''}`);
    return { recovered: false, action: 'missing-port', port: null };
  }

  const probe = await probeChromeDebugPort(boundPort, { httpGet });
  if (probe.alive) {
    _apiBrowserDbg(`chrome recovery reconnect-only: tool=${toolName || 'unknown'} port=${boundPort}`);
    return { recovered: true, action: 'reconnect-client', port: boundPort };
  }

  const ownerPanelId = manifest && manifest.chromeOwnerPanelId ? String(manifest.chromeOwnerPanelId) : '';
  if (!ownerPanelId) {
    _apiBrowserDbg(`chrome recovery skipped: dead port without owner panel tool=${toolName || 'unknown'} port=${boundPort}`);
    return { recovered: false, action: 'missing-owner-panel', port: boundPort };
  }

  const manager = chromeManager || require('../extension/chrome-manager');
  try {
    try {
      manager.killChrome(ownerPanelId);
    } catch {}
    const restarted = await manager.ensureChrome(ownerPanelId, { port: boundPort });
    if (!restarted || Number(restarted.port) !== boundPort) {
      _apiBrowserDbg(`chrome recovery failed restart: tool=${toolName || 'unknown'} port=${boundPort} restartedPort=${restarted && restarted.port != null ? restarted.port : 'null'}`);
      return { recovered: false, action: 'restart-failed', port: boundPort };
    }
    manifest.chromeDebugPort = boundPort;
    manifest.worker.boundBrowserPort = boundPort;
    if (agentSession && typeof agentSession === 'object') {
      agentSession.boundBrowserPort = boundPort;
    }
    _apiBrowserDbg(`chrome recovery restarted same port: tool=${toolName || 'unknown'} panelId=${ownerPanelId} port=${boundPort}`);
    return { recovered: true, action: 'restart-browser', port: boundPort, panelId: ownerPanelId };
  } catch (recoveryError) {
    _apiBrowserDbg(`chrome recovery exception: tool=${toolName || 'unknown'} panelId=${ownerPanelId} port=${boundPort} error=${recoveryError && recoveryError.message ? recoveryError.message : recoveryError}`);
    return { recovered: false, action: 'restart-exception', port: boundPort, panelId: ownerPanelId };
  }
}

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
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = label;
  const manifestSessionKey = agentId || 'default';
  const localSessionKey = workerSessionKey(agentId);
  const backend = transcriptBackend('worker', 'api');

  const apiConfig = manifest.worker.apiConfig || manifest.apiConfig || {};
  const providerId = (agentConfig && agentConfig.provider) || apiConfig.provider || 'openrouter';
  const resolvedProvider = resolveRuntimeApiProvider(providerId);
  if (!resolvedProvider) {
    throw new Error(`Unknown API provider "${providerId}". Configure it in Settings -> Custom Providers or select a built-in provider.`);
  }
  const provider = resolvedProvider.clientProvider;
  const apiKey = resolveApiKey(resolvedProvider.id, apiConfig.apiKey);
  const baseURL = resolvedProvider.custom
    ? resolvedProvider.baseURL
    : ((resolvedProvider.legacy ? apiConfig.baseURL : (apiConfig.baseURL || resolvedProvider.baseURL)) || null);
  const model = (agentConfig && agentConfig.model) || apiConfig.model || defaultModelForProvider(providerId);
  const thinking = (agentConfig && agentConfig.thinking) || apiConfig.thinking || null;

  if (!model) {
    throw new Error(`No default model configured for provider "${provider}". Specify a model explicitly.`);
  }

  const client = new LLMClient({ provider, apiKey, baseURL, model });
  const allMcpServers = { ...(manifest.workerMcpServers || {}), ...((agentConfig && agentConfig.mcps) || {}) };
  _apiBrowserDbg(`api-worker tools panelId=${manifest.panelId || null} chromeDebugPort=${manifest.chromeDebugPort || null} agentId=${agentId || 'default'} mcpKeys=${JSON.stringify(Object.keys(allMcpServers || {}))}`);
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
  const agentSession = ensureWorkerSessionState(manifest.worker.agentSessions[manifestSessionKey]);
  manifest.worker.agentSessions[manifestSessionKey] = agentSession;
  const promptsDirs = buildPromptsDirs(manifest.repoRoot);
  if (!agentSession.apiSystemPromptSnapshot) {
    let built = buildAgentWorkerSystemPrompt(
      agentConfig,
      manifest.selfTesting
        ? { selfTesting: true, selfTestPrompts: manifest.selfTestPrompts, repoRoot: manifest.repoRoot }
        : { repoRoot: manifest.repoRoot },
      promptsDirs
    );
    built += '\n\n## API Mode Tools\nYou are running in API mode. Your built-in tools (prefixed with builtin_tools__) are your primary tools for file and command operations:\n- builtin_tools__read_file â€” Read files\n- builtin_tools__write_file â€” Write/create files\n- builtin_tools__edit_file â€” Edit files (find and replace)\n- builtin_tools__run_command â€” Execute shell commands\n- builtin_tools__list_directory â€” List directory contents\n- builtin_tools__glob_search â€” Find files by pattern\n- builtin_tools__grep_search â€” Search file contents\n\nUse these tools freely. The detached-command MCP is also available for long-running background processes that need to persist across turns.';
    agentSession.apiSystemPromptSnapshot = built.replaceAll('\u00e2\u20ac\u201d', '-');
  }
  const systemPrompt = agentSession.apiSystemPromptSnapshot;
  if (manifest.chromeDebugPort != null) {
    agentSession.boundBrowserPort = Number(manifest.chromeDebugPort) || null;
    manifest.worker.boundBrowserPort = Number(manifest.chromeDebugPort) || null;
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
  let fullMessages = null;
  let cacheContext = buildPromptCacheContext({
    providerId,
    model,
    runId: manifest.runId,
    sessionKey: localSessionKey,
    purpose: 'worker',
  });
  if (canonicalHistoryAvailable) {
    messages = null;
  } else if (Array.isArray(agentSession.apiMessages) && agentSession.apiMessages.length > 0) {
    const legacyHistory = agentSession.apiMessages[0] && agentSession.apiMessages[0].role === 'system'
      ? agentSession.apiMessages.slice(1)
      : agentSession.apiMessages;
    messages = [{ role: 'system', content: systemPrompt }, ...legacyHistory, { role: 'user', content: prompt }];
    fullMessages = messages;
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];
    fullMessages = messages;
  }

  async function buildCanonicalMessages({ forceCompact = false } = {}) {
    if (!manifest.files || !manifest.files.transcript) {
      return {
        messages: [{ role: 'system', content: systemPrompt }],
        fullMessages: [{ role: 'system', content: systemPrompt }],
        cacheContext: buildPromptCacheContext({
          providerId,
          model,
          runId: manifest.runId,
          sessionKey: localSessionKey,
          purpose: 'worker',
        }),
      };
    }
    if (typeof compactSessionHistory === 'function') {
      await compactSessionHistory({
        manifest,
        sessionKey: localSessionKey,
        backend,
        requestId: request.id,
        loopIndex: loop.index,
        provider: providerId,
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
    const replayMessages = buildSessionReplay(refreshedEntries, localSessionKey);
    const completeMessages = [
      { role: 'system', content: systemPrompt },
      ...replayMessages,
    ];
    let nextMessages = completeMessages;
    let nextCacheContext = buildPromptCacheContext({
      providerId,
      model,
      runId: manifest.runId,
      sessionKey: localSessionKey,
      purpose: 'worker',
    });
    if (providerId === 'gemini') {
      const cacheEntry = await readGeminiCacheEntry(
        manifest,
        geminiCacheSessionKey({
          purpose: 'worker',
          sessionKey: localSessionKey,
          model,
        })
      );
      const cacheUsage = buildGeminiCacheUsage(cacheEntry, completeMessages.slice(1));
      nextMessages = [
        { role: 'system', content: systemPrompt },
        ...cacheUsage.uncachedMessages,
      ];
      nextCacheContext = buildPromptCacheContext({
        providerId,
        model,
        runId: manifest.runId,
        sessionKey: localSessionKey,
        purpose: 'worker',
        geminiCachedContentName: cacheUsage.cachedContentName,
      });
    }
    return {
      messages: nextMessages,
      fullMessages: completeMessages,
      cacheContext: nextCacheContext,
    };
  }

  emitEvent({ source: 'worker-api', type: 'start', agentId, model, provider: providerId });
  renderer.claude(`Using ${providerId}/${model}`);

  let iterations = 0;
  let finalText = '';
  const totalUsage = { promptTokens: 0, completionTokens: 0 };

  while (true) {
    iterations++;

    if (abortSignal && abortSignal.aborted) {
      renderer.claude('(aborted)');
      break;
    }

    if (canonicalHistoryAvailable) {
      const canonical = await buildCanonicalMessages();
      messages = canonical.messages;
      fullMessages = canonical.fullMessages;
      cacheContext = canonical.cacheContext;
    }

    const textParts = [];
    let toolCalls = null;
    let usage = null;
    let finishReason = null;
    let finishReasons = [];
    const apiLogFiles = workerApiLogFiles(workerRecord, loop, iterations);
    const apiLogHooks = createStreamApiLogHooks(manifest, apiLogFiles, {
      requestId: request.id,
      loopIndex: loop.index,
      iteration: iterations,
      agentId: isCustomAgent ? agentId : null,
      provider: providerId,
      model,
      baseURL,
      thinking,
      messageCount: Array.isArray(messages) ? messages.length : 0,
      toolCount: Array.isArray(tools) ? tools.length : 0,
      cacheSupport: cacheContext.cacheSupport,
      cacheMode: cacheContext.cacheMode,
      promptCacheKey: cacheContext.promptCacheKey || null,
      cachedContentName: cacheContext.geminiCachedContentName || null,
    });

    try {
      for await (const event of client.streamChat(messages, tools, {
        thinking,
        signal: abortSignal,
        promptCache: cacheContext,
        ...apiLogHooks,
      })) {
        if (event.type === 'text') {
          textParts.push(event.content);
          renderer.streamMarkdown(label, event.content);
        } else if (event.type === 'done') {
          toolCalls = event.toolCalls;
          usage = event.usage;
          finishReason = event.finishReason || null;
          finishReasons = Array.isArray(event.finishReasons) ? event.finishReasons : [];
          if (apiLogFiles && apiLogFiles.responseFile) {
            await appendApiResponseLog(manifest, apiLogFiles.responseFile, {
              type: 'done',
              requestId: request.id,
              loopIndex: loop.index,
              iteration: iterations,
              finishReason,
              finishReasons,
              cacheSupport: cacheContext.cacheSupport,
              cacheMode: cacheContext.cacheMode,
              promptCacheKey: cacheContext.promptCacheKey || null,
              cachedContentName: cacheContext.geminiCachedContentName || null,
              textLength: (event.text || '').length,
              toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
              toolCalls,
              usage,
            });
          }
          if (event.text) renderer.flushStream();
        }
      }
    } catch (error) {
      if (apiLogFiles && apiLogFiles.responseFile) {
        await appendApiResponseLog(manifest, apiLogFiles.responseFile, {
          type: 'error',
          requestId: request.id,
          loopIndex: loop.index,
          iteration: iterations,
          cacheSupport: cacheContext.cacheSupport,
          cacheMode: cacheContext.cacheMode,
          promptCacheKey: cacheContext.promptCacheKey || null,
          cachedContentName: cacheContext.geminiCachedContentName || null,
          message: error && error.message ? String(error.message) : String(error),
        });
      }
      throw error;
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
        emitEvent({ source: 'worker-api', type: 'assistant_message', text: finalText });
      }
      if (providerId === 'gemini' && canonicalHistoryAvailable) {
        const refreshedEntries = await readTranscriptEntries(manifest.files.transcript);
        const replayMessages = buildSessionReplay(refreshedEntries, localSessionKey);
        await refreshGeminiCacheEntry({
          manifest,
          cacheKey: geminiCacheSessionKey({
            purpose: 'worker',
            sessionKey: localSessionKey,
            model,
          }),
          apiKey,
          model,
          systemPrompt,
          messages: replayMessages,
        });
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
    if (responseText) {
      emitEvent({ source: 'worker-api', type: 'assistant_message', text: responseText });
    }

    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      const baseName = baseToolName(toolName);
      const toolArgs = tc.function.arguments;
      const parsedInput = parseToolInput(toolArgs);
      const argsPreview = parsedInput.path || parsedInput.command || parsedInput.pattern || '';
      const cardId = tc.id ? `api-${tc.id}` : `api-${request.id}-${iterations}-${(fullMessages && fullMessages.length) || 0}`;

      const isChromeDevtools = toolName.includes('chrome_devtools') || toolName.includes('chrome-devtools');
      const isComputerUse = isChromeDevtools || toolName.includes('computer_control') || toolName.includes('computer-control');
      const cardMeta = { isComputerUse, isChromeDevtools };
      const renderedStartCard = renderStartCard(baseName, parsedInput, renderer, label, cardId, cardMeta);
      if (!renderedStartCard) {
        renderer.claude(`Calling ${toolName}${argsPreview ? ': ' + argsPreview : ''}`);
      }

      emitEvent({ source: 'worker-api', type: 'tool_call', name: toolName, args: toolArgs, input: parsedInput });
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

      const result = await executeTool(tc, allMcpServers, manifest.repoRoot, {
        onRecoverChromeDevtools: async ({ toolName: recoverToolName, error }) => {
          await recoverChromeDevtoolsSession(manifest, agentSession, { toolName: recoverToolName, error });
        },
      });
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
        summary: summarizeToolResult(result),
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

module.exports = {
  runApiWorkerTurn,
  probeChromeDebugPort,
  recoverChromeDevtoolsSession,
};
