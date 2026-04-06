/**
 * API-based controller runner.
 * Uses direct LLM API calls for controller decisions instead of Codex/Claude CLI.
 * Returns structured JSON decisions (delegate/stop) like the CLI controllers.
 */
const { LLMClient, resolveApiKey, defaultModelForProvider } = require('./llm-client');
const { buildControllerPrompt } = require('./prompts');
const { controllerDecisionSchema, validateControllerDecision, parsePossiblyFencedJson } = require('./schema');
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

  // Resolve API config: controller manifest config → global config
  const apiConfig = manifest.controller.apiConfig || manifest.apiConfig || {};
  const provider = apiConfig.provider || 'openrouter';
  const apiKey = resolveApiKey(provider, apiConfig.apiKey);
  const baseURL = apiConfig.baseURL || null;
  const model = apiConfig.model || defaultModelForProvider(provider);
  const thinking = apiConfig.thinking || null;
  // Note: controller doesn't have per-agent overrides — it's always manifest-level

  if (!model) {
    throw new Error(`No default model configured for provider "${provider}". Specify a model explicitly.`);
  }

  const client = new LLMClient({ provider, apiKey, baseURL, model });

  emitEvent({ source: 'controller-api', type: 'start', model, provider });
  renderer.controller('Thinking about the next step.');

  // Stream the response — collect text
  const textParts = [];
  for await (const event of client.streamChat(
    [{ role: 'user', content: prompt }],
    null,
    {
      thinking,
      signal: abortSignal,
      response_format: { type: 'json_object' },
    }
  )) {
    if (event.type === 'text') {
      textParts.push(event.content);
    } else if (event.type === 'done') {
      // done
    }
  }

  const responseText = textParts.join('');

  // Parse and validate the decision
  let decision;
  try {
    const parsed = parsePossiblyFencedJson(responseText);
    decision = validateControllerDecision(parsed);
  } catch (err) {
    // If parsing fails, try to extract JSON from the response
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
