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
const {
  SEARCH_MCP_TOOLS_NAME,
  buildMcpCapabilityIndex,
  buildSearchMcpToolDefinition,
  errorToolResult,
  executeTool,
  loadToolCatalog,
  materializeToolDefinitions,
  searchToolCatalog,
} = require('./mcp-tool-bridge');
const { renderStartCard, renderCompleteCard } = require('./mcp-cards');
const { buildAgentWorkerSystemPrompt } = require('./prompts');
const { buildPromptsDirs } = require('./prompt-tags');
const { buildPromptCacheContext } = require('./prompt-cache');
const { lookupAgentConfig, ensureWorkerSessionState, saveManifest } = require('./state');
const { workerLabelFor } = require('./render');
const { baseToolName } = require('./turn-entity-tracker');
const { applyUsageToManifest, usageActorFromBackend, usageSummaryMessage } = require('./usage-summary');
const {
  DEFAULT_COMPACTION_TRIGGER_MESSAGES,
  compactApiSessionHistory,
} = require('./api-compaction');
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

const DEFAULT_LAZY_TOOL_LIMIT = 20;

function uniqueToolNames(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    output.push(name);
  }
  return output;
}

function resolveLazyToolLimit(agentConfig) {
  const value = Number(agentConfig && agentConfig.apiLazyToolLimit);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_LAZY_TOOL_LIMIT;
}

function isLazyMcpEnabledForWorker(manifest, agentConfig) {
  return !!(
    manifest &&
    manifest.lazyMcpToolsEnabled &&
    agentConfig &&
    agentConfig.apiLazyTools
  );
}

function ensureLazyToolSessionState(agentSession, catalog, { lazyEnabled }) {
  if (!lazyEnabled) {
    agentSession.apiLazyToolsEnabled = false;
    agentSession.apiToolCatalogFingerprint = catalog.fingerprint;
    agentSession.apiVisibleToolNames = [];
    agentSession.apiActivatedToolOrder = [];
    return { initialized: false };
  }

  const sameCatalog = agentSession.apiToolCatalogFingerprint === catalog.fingerprint;
  const sameMode = agentSession.apiLazyToolsEnabled === true;
  const restoredVisible = sameCatalog && sameMode
    ? uniqueToolNames(agentSession.apiVisibleToolNames).filter((name) => name === SEARCH_MCP_TOOLS_NAME || catalog.byName[name])
    : [];
  const baseVisible = [SEARCH_MCP_TOOLS_NAME];
  const visibleNames = uniqueToolNames([...baseVisible, ...restoredVisible]);
  const activatedOrder = sameCatalog && sameMode
    ? uniqueToolNames(agentSession.apiActivatedToolOrder).filter((name) => name !== SEARCH_MCP_TOOLS_NAME && catalog.byName[name])
    : [];

  agentSession.apiLazyToolsEnabled = true;
  agentSession.apiToolCatalogFingerprint = catalog.fingerprint;
  agentSession.apiVisibleToolNames = visibleNames;
  agentSession.apiActivatedToolOrder = activatedOrder;
  return { initialized: restoredVisible.length === 0 };
}

function touchActivatedTool(agentSession, toolName) {
  const name = String(toolName || '').trim();
  if (!name || name === SEARCH_MCP_TOOLS_NAME) return;
  const next = uniqueToolNames([
    ...((agentSession && agentSession.apiActivatedToolOrder) || []).filter((entry) => entry !== name),
    name,
  ]);
  agentSession.apiActivatedToolOrder = next;
}

function pruneVisibleTools(agentSession, limit) {
  const visible = uniqueToolNames(agentSession.apiVisibleToolNames);
  const coreSet = new Set([SEARCH_MCP_TOOLS_NAME]);
  const nonCoreVisible = visible.filter((name) => !coreSet.has(name));
  if (nonCoreVisible.length <= limit) return [];

  const removableCount = nonCoreVisible.length - limit;
  const order = uniqueToolNames(agentSession.apiActivatedToolOrder);
  const evicted = [];
  for (const name of order) {
    if (evicted.length >= removableCount) break;
    if (!coreSet.has(name) && nonCoreVisible.includes(name)) {
      evicted.push(name);
    }
  }
  if (evicted.length < removableCount) {
    for (const name of nonCoreVisible) {
      if (evicted.length >= removableCount) break;
      if (!evicted.includes(name)) evicted.push(name);
    }
  }

  agentSession.apiVisibleToolNames = visible.filter((name) => !evicted.includes(name));
  agentSession.apiActivatedToolOrder = order.filter((name) => !evicted.includes(name));
  return evicted;
}

function buildSearchToolResult(query, matches, { activated = [], alreadyActive = [], evicted = [] } = {}) {
  const lines = [
    `Search query: ${String(query || '').trim() || '(empty)'}`,
    matches.length > 0 ? `Matched ${matches.length} tool${matches.length === 1 ? '' : 's'}:` : 'No matching tools found.',
  ];
  for (const match of matches) {
    const status = activated.includes(match.name)
      ? 'activated'
      : (alreadyActive.includes(match.name) ? 'already active' : 'available');
    lines.push(`- ${match.name} (${match.serverName || 'unknown server'}) - ${status}`);
    if (match.description) {
      lines.push(`  ${match.description}`);
    }
  }
  if (evicted.length > 0) {
    lines.push(`Evicted oldest non-core tools: ${evicted.join(', ')}`);
  }
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
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

function resolveApiCompactionTriggerMessages(agentConfig) {
  const value = agentConfig && Number(agentConfig.apiCompactionTriggerMessages);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COMPACTION_TRIGGER_MESSAGES;
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
  const compactionTriggerMessages = resolveApiCompactionTriggerMessages(agentConfig);

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
  if (!manifest.worker.agentSessions) manifest.worker.agentSessions = {};
  const agentSession = ensureWorkerSessionState(manifest.worker.agentSessions[manifestSessionKey]);
  manifest.worker.agentSessions[manifestSessionKey] = agentSession;
  const lazyMcpToolsEnabled = isLazyMcpEnabledForWorker(manifest, agentConfig);
  const toolCatalog = await loadToolCatalog(allMcpServers, manifest.repoRoot);
  const eagerTools = lazyMcpToolsEnabled
    ? null
    : materializeToolDefinitions(toolCatalog, toolCatalog.toolNames);
  const mcpCapabilityIndex = lazyMcpToolsEnabled
    ? buildMcpCapabilityIndex(toolCatalog)
    : '';
  const lazyToolLimit = resolveLazyToolLimit(agentConfig);
  ensureLazyToolSessionState(agentSession, toolCatalog, {
    lazyEnabled: lazyMcpToolsEnabled,
  });
  const promptsDirs = buildPromptsDirs(manifest.repoRoot);
  if (!agentSession.apiSystemPromptSnapshot) {
    let built = buildAgentWorkerSystemPrompt(
      agentConfig,
      manifest.selfTesting
        ? { selfTesting: true, selfTestPrompts: manifest.selfTestPrompts, repoRoot: manifest.repoRoot }
        : { repoRoot: manifest.repoRoot },
      promptsDirs
    );
    if (!lazyMcpToolsEnabled) {
      built += '\n\n## API Mode Tools\nYou are running in API mode. Your built-in tools (prefixed with builtin_tools__) are your primary tools for file and command operations:\n- builtin_tools__read_file - Read files\n- builtin_tools__write_file - Write/create files\n- builtin_tools__edit_file - Edit files (find and replace)\n- builtin_tools__run_command - Execute shell commands\n- builtin_tools__list_directory - List directory contents\n- builtin_tools__glob_search - Find files by pattern\n- builtin_tools__grep_search - Search file contents\n\nUse these tools freely. The detached-command MCP is also available for long-running background processes that need to persist across turns.';
    } else {
      built += '\n\n## Lazy MCP Tool Loading\nYou start with only one visible tool: `search_mcp_tools`. All other MCP tools are hidden until you load them. The host still knows the full MCP capability map listed below. Use `search_mcp_tools` whenever you need any capability beyond the current visible tool set. Search by MCP name or by tool/capability name from the index instead of guessing broadly. Matching tools will be activated for later turns and stay available during this task unless the active tool budget is exceeded. Do not repeatedly search for the same capability once the tool is already visible.';
      if (mcpCapabilityIndex) {
        built += `\n\n## MCP Capability Index\nThe following MCP groups and tool names are known to the host:\n${mcpCapabilityIndex}`;
      }
    }
    agentSession.apiSystemPromptSnapshot = built.replaceAll('\u00e2\u20ac\u201d', '-');
  }
  const systemPrompt = agentSession.apiSystemPromptSnapshot;
  function currentVisibleToolNames() {
    if (!lazyMcpToolsEnabled) return toolCatalog.toolNames.slice();
    return uniqueToolNames(agentSession.apiVisibleToolNames);
  }
  function currentVisibleTools() {
    if (!lazyMcpToolsEnabled) return eagerTools || [];
    const visibleNames = currentVisibleToolNames();
    const realToolNames = visibleNames.filter((name) => name !== SEARCH_MCP_TOOLS_NAME);
    return [
      ...materializeToolDefinitions(toolCatalog, realToolNames),
      buildSearchMcpToolDefinition(),
    ];
  }
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
        triggerMessages: compactionTriggerMessages,
        emitEvent,
        renderer,
      });
    }
    const refreshedEntries = await readTranscriptEntries(manifest.files.transcript);
    const replayMessages = buildSessionReplay(refreshedEntries, localSessionKey, {
      inlineImageReplayMode: 'tail-only',
    });
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
  const usageActor = usageActorFromBackend(backend);

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

    const visibleToolNames = currentVisibleToolNames();
    const tools = currentVisibleTools();

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
      catalogToolCount: toolCatalog.toolCount,
      visibleToolCount: visibleToolNames.length,
      visibleToolNames,
      lazyMcpToolsEnabled,
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
      applyUsageToManifest(manifest, {
        actor: usageActor,
        usage,
      });
      await saveManifest(manifest);
      if (renderer && typeof renderer.usageStats === 'function') {
        renderer.usageStats(usageSummaryMessage(manifest.usageSummary));
      }
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
        const replayMessages = buildSessionReplay(refreshedEntries, localSessionKey, {
          inlineImageReplayMode: 'tail-only',
        });
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

      let result;
      if (toolName === SEARCH_MCP_TOOLS_NAME) {
        const maxResults = Math.max(1, Math.min(5, Number(parsedInput.maxResults) || 5));
        const matches = searchToolCatalog(toolCatalog, parsedInput.query, {
          maxResults,
          server: parsedInput.server || '',
        });
        const activated = [];
        const alreadyActive = [];
        for (const match of matches) {
          if (agentSession.apiVisibleToolNames.includes(match.name)) {
            alreadyActive.push(match.name);
            touchActivatedTool(agentSession, match.name);
            continue;
          }
          agentSession.apiVisibleToolNames = uniqueToolNames([...agentSession.apiVisibleToolNames, match.name]);
          activated.push(match.name);
          touchActivatedTool(agentSession, match.name);
        }
        const evicted = pruneVisibleTools(agentSession, lazyToolLimit);
        result = buildSearchToolResult(parsedInput.query, matches, {
          activated,
          alreadyActive,
          evicted,
        });
        emitEvent({
          source: 'worker-api',
          type: 'tool_activation',
          name: SEARCH_MCP_TOOLS_NAME,
          activated,
          alreadyActive,
          evicted,
        });
        await saveManifest(manifest);
      } else if (lazyMcpToolsEnabled && !visibleToolNames.includes(toolName)) {
        result = errorToolResult(`Error: tool "${toolName}" is not currently active. Use ${SEARCH_MCP_TOOLS_NAME} first.`);
      } else {
        result = await executeTool(tc, allMcpServers, manifest.repoRoot, {
          onRecoverChromeDevtools: async ({ toolName: recoverToolName, error }) => {
            await recoverChromeDevtoolsSession(manifest, agentSession, { toolName: recoverToolName, error });
          },
        });
        if (lazyMcpToolsEnabled) {
          touchActivatedTool(agentSession, toolName);
        }
      }
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
