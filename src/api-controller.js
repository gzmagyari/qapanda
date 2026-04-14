/**
 * API-based controller runner.
 * Uses direct LLM API calls for controller decisions instead of Codex/Claude CLI.
 * Returns structured JSON decisions (delegate/stop) like the CLI controllers.
 */
const { LLMClient, resolveApiKey, defaultModelForProvider } = require('./llm-client');
const { resolveRuntimeApiProvider } = require('./api-provider-registry');
const {
  appendApiResponseLog,
  controllerApiLogFiles,
  createStreamApiLogHooks,
} = require('./api-io-log');
const {
  buildApiControllerSystemPrompt,
  buildApiControllerUserPrompt,
  buildControllerPrompt,
} = require('./prompts');
const { buildPromptCacheContext } = require('./prompt-cache');
const { validateControllerDecision, parsePossiblyFencedJson } = require('./schema');
const { saveManifest } = require('./state');
const { applyUsageToManifest, usageActorFromBackend, usageSummaryMessage } = require('./usage-summary');
const { writeText } = require('./utils');
const { redactHostedWorkflowValue } = require('./cloud/workflow-hosted-runs');

/**
 * Run a controller turn via API.
 * Sends the controller prompt and gets back a structured decision.
 *
 * @param {object} opts
 * @param {object} opts.manifest - Run manifest
 * @param {object} opts.request - Current request
 * @param {object} opts.loop - Current loop
 * @param {object} opts.renderer - Renderer
 * @param {function} opts.emitEvent - Event logger
 * @param {AbortSignal} [opts.abortSignal] - Abort signal
 */
async function runApiControllerTurn({ manifest, request, loop, renderer, emitEvent, abortSignal }) {
  const prompt = buildControllerPrompt(manifest, request);
  await writeText(loop.controller.promptFile, `${redactHostedWorkflowValue(manifest, prompt)}\n`);

  const apiConfig = manifest.controller.apiConfig || manifest.apiConfig || {};
  const providerId = apiConfig.provider || 'openrouter';
  const resolvedProvider = resolveRuntimeApiProvider(providerId);
  if (!resolvedProvider) {
    throw new Error(`Unknown API provider "${providerId}". Configure it in Settings -> Custom Providers or select a built-in provider.`);
  }
  const provider = resolvedProvider.clientProvider;
  const apiKey = resolveApiKey(resolvedProvider.id, apiConfig.apiKey);
  const baseURL = resolvedProvider.custom
    ? resolvedProvider.baseURL
    : ((resolvedProvider.legacy ? apiConfig.baseURL : (apiConfig.baseURL || resolvedProvider.baseURL)) || null);
  const model = apiConfig.model || defaultModelForProvider(providerId);
  const thinking = apiConfig.thinking || null;

  if (!model) {
    throw new Error(`No default model configured for provider "${provider}". Specify a model explicitly.`);
  }

  const client = new LLMClient({ provider, apiKey, baseURL, model });
  if (!manifest.controller.apiSystemPromptSnapshot) {
    manifest.controller.apiSystemPromptSnapshot = buildApiControllerSystemPrompt(manifest);
  }
  const systemPrompt = manifest.controller.apiSystemPromptSnapshot;
  const userPrompt = buildApiControllerUserPrompt(manifest, request);
  const cacheContext = buildPromptCacheContext({
    providerId,
    model,
    runId: manifest.runId,
    sessionKey: 'controller:main',
    purpose: 'controller',
  });

  emitEvent({ source: 'controller-api', type: 'start', model, provider: providerId });
  renderer.controller('Thinking about the next step.');

  const textParts = [];
  let usage = null;
  const apiLogFiles = controllerApiLogFiles(loop);
  const apiLogHooks = createStreamApiLogHooks(manifest, apiLogFiles, {
    requestId: request.id,
    loopIndex: loop.index,
    provider: providerId,
    model,
    baseURL,
    thinking,
    messageCount: 2,
    toolCount: 0,
    cacheSupport: cacheContext.cacheSupport,
    cacheMode: cacheContext.cacheMode,
    promptCacheKey: cacheContext.promptCacheKey || null,
  });

  try {
    for await (const event of client.streamChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      null,
      {
        thinking,
        signal: abortSignal,
        response_format: { type: 'json_object' },
        promptCache: cacheContext,
        ...apiLogHooks,
      }
    )) {
      if (event.type === 'text') {
        textParts.push(event.content);
      } else if (event.type === 'done' && apiLogFiles && apiLogFiles.responseFile) {
        usage = event.usage || null;
        await appendApiResponseLog(manifest, apiLogFiles.responseFile, {
          type: 'done',
          requestId: request.id,
          loopIndex: loop.index,
          finishReason: event.finishReason || null,
          finishReasons: Array.isArray(event.finishReasons) ? event.finishReasons : [],
          cacheSupport: cacheContext.cacheSupport,
          cacheMode: cacheContext.cacheMode,
          promptCacheKey: cacheContext.promptCacheKey || null,
          textLength: (event.text || '').length,
          toolCallCount: Array.isArray(event.toolCalls) ? event.toolCalls.length : 0,
          usage: event.usage || null,
        });
      }
    }
  } catch (error) {
    if (apiLogFiles && apiLogFiles.responseFile) {
      await appendApiResponseLog(manifest, apiLogFiles.responseFile, {
        type: 'error',
        requestId: request.id,
        loopIndex: loop.index,
        message: error && error.message ? String(error.message) : String(error),
      });
    }
    throw error;
  }

  const responseText = textParts.join('');
  if (usage) {
    applyUsageToManifest(manifest, {
      actor: usageActorFromBackend('controller:api'),
      usage,
    });
    await saveManifest(manifest);
    if (renderer && typeof renderer.usageStats === 'function') {
      renderer.usageStats(usageSummaryMessage(manifest.usageSummary));
    }
  }

  let decision;
  try {
    const parsed = parsePossiblyFencedJson(responseText);
    decision = validateControllerDecision(parsed);
  } catch (err) {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        decision = validateControllerDecision(JSON.parse(jsonMatch[0]));
      } catch {
        throw new Error(`Controller returned invalid JSON: ${err.message}\nRaw: ${responseText.slice(0, 500)}`);
      }
    } else {
      throw new Error(`Controller returned no JSON: ${responseText.slice(0, 500)}`);
    }
  }

  emitEvent({ source: 'controller-api', type: 'decision', action: decision.action, agentId: decision.agent_id });
  return { prompt, decision, sessionId: null };
}

module.exports = { runApiControllerTurn };
