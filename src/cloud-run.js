const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { ensureDir, nowIso, pathExists, readText, writeJson, writeText } = require('./utils');
const { redactHostedWorkflowValue, sanitizeHostedWorkflowCloudRunSpec } = require('./cloud/workflow-hosted-runs');
const { extractTextFromClaudeContent, formatToolCall } = require('./events');

const CLOUD_RUN_SPEC_VERSION = 'qapanda.cloud-run/v1';

const CLOUD_RUN_ARG_SPEC = {
  'spec': { key: 'specPath', kind: 'value' },
  'repo': { key: 'repoRoot', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'agent-cli': { key: 'agentCli', kind: 'value' },
  'controller-codex-mode': { key: 'controllerCodexMode', kind: 'value' },
  'raw-events': { key: 'rawEvents', kind: 'boolean' },
  'quiet': { key: 'quiet', kind: 'boolean' },
  'no-mcp-inject': { key: 'noMcpInject', kind: 'boolean' },
};

function fail(field, message) {
  throw new Error(`Invalid cloud-run spec: ${field} ${message}`);
}

function expectRequiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(field, 'must be a non-empty string.');
  }
  return value;
}

function expectOptionalString(value, field) {
  if (value == null) return null;
  if (typeof value !== 'string') fail(field, 'must be a string or null.');
  return value;
}

function expectOptionalObject(value, field) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(field, 'must be an object or null.');
  }
  return value;
}

function expectOptionalArray(value, field) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    fail(field, 'must be an array or null.');
  }
  return value;
}

function validateAiProfile(value) {
  const aiProfile = expectOptionalObject(value, 'aiProfile');
  if (!aiProfile) return null;
  return {
    profileId: expectRequiredString(aiProfile.profileId, 'aiProfile.profileId'),
    name: expectOptionalString(aiProfile.name, 'aiProfile.name'),
    provider: expectOptionalString(aiProfile.provider, 'aiProfile.provider'),
    model: expectOptionalString(aiProfile.model, 'aiProfile.model'),
  };
}

function validateRuntimeApiConfig(value) {
  const config = expectOptionalObject(value, 'runtimeApiConfig');
  if (!config) return null;
  return {
    source: expectRequiredString(config.source, 'runtimeApiConfig.source'),
    provider: expectRequiredString(config.provider, 'runtimeApiConfig.provider'),
    model: expectRequiredString(config.model, 'runtimeApiConfig.model'),
    apiKey: expectOptionalString(config.apiKey, 'runtimeApiConfig.apiKey'),
    baseURL: expectOptionalString(config.baseURL, 'runtimeApiConfig.baseURL'),
  };
}

function validateWorkflowDefinition(value) {
  const definition = expectOptionalObject(value, 'workflowDefinition');
  if (!definition) return null;
  const inputs = expectOptionalArray(definition.inputs, 'workflowDefinition.inputs');
  return {
    id: expectOptionalString(definition.id, 'workflowDefinition.id'),
    workflowId: expectOptionalString(definition.workflowId, 'workflowDefinition.workflowId'),
    name: expectRequiredString(definition.name, 'workflowDefinition.name'),
    description: expectOptionalString(definition.description, 'workflowDefinition.description'),
    preferredMode: expectOptionalString(definition.preferredMode, 'workflowDefinition.preferredMode'),
    suggestedAgent: expectOptionalString(definition.suggestedAgent, 'workflowDefinition.suggestedAgent'),
    directoryName: expectOptionalString(definition.directoryName, 'workflowDefinition.directoryName'),
    relativePath: expectOptionalString(definition.relativePath, 'workflowDefinition.relativePath'),
    body: expectOptionalString(definition.body, 'workflowDefinition.body'),
    content: expectOptionalString(definition.content, 'workflowDefinition.content'),
    inputs: inputs ? inputs.map((input, index) => {
      const fieldPath = `workflowDefinition.inputs[${index}]`;
      const field = expectOptionalObject(input, fieldPath);
      if (!field) fail(fieldPath, 'must contain input field objects.');
      return { ...field };
    }) : [],
  };
}

function validateWorkflowProfile(value) {
  const profile = expectOptionalObject(value, 'workflowProfile');
  if (!profile) return null;
  return {
    profileId: expectOptionalString(profile.profileId, 'workflowProfile.profileId'),
    id: expectOptionalString(profile.id, 'workflowProfile.id'),
    name: expectOptionalString(profile.name, 'workflowProfile.name'),
  };
}

function validateWorkflowInputs(value) {
  const inputs = expectOptionalObject(value, 'workflowInputs');
  if (!inputs) return null;
  return { ...inputs };
}

function validateWorkflowSecretRefs(value) {
  const refs = expectOptionalObject(value, 'workflowSecretRefs');
  if (!refs) return null;
  return Object.fromEntries(
    Object.entries(refs).map(([fieldId, secretId]) => [fieldId, expectRequiredString(secretId, `workflowSecretRefs.${fieldId}`)])
  );
}

function validateCloudRunSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid cloud-run spec: root must be a JSON object.');
  }
  if (input.version !== CLOUD_RUN_SPEC_VERSION) {
    throw new Error(
      `Invalid cloud-run spec: version must be "${CLOUD_RUN_SPEC_VERSION}".`,
    );
  }
  const validated = {
    version: input.version,
    runId: expectRequiredString(input.runId, 'runId'),
    attemptId: expectRequiredString(input.attemptId, 'attemptId'),
    repositoryId: expectRequiredString(input.repositoryId, 'repositoryId'),
    outputDir: expectRequiredString(input.outputDir, 'outputDir'),
    repositoryContextId: expectOptionalString(input.repositoryContextId, 'repositoryContextId'),
    title: expectRequiredString(input.title, 'title'),
    prompt: expectRequiredString(input.prompt, 'prompt'),
    targetUrl: expectOptionalString(input.targetUrl, 'targetUrl'),
    targetType: expectOptionalString(input.targetType, 'targetType'),
    browserPreset: expectOptionalString(input.browserPreset, 'browserPreset'),
    aiProfile: validateAiProfile(input.aiProfile),
    runtimeApiConfig: validateRuntimeApiConfig(input.runtimeApiConfig),
    workflowDefinition: validateWorkflowDefinition(input.workflowDefinition),
    workflowProfile: validateWorkflowProfile(input.workflowProfile),
    workflowInputs: validateWorkflowInputs(input.workflowInputs),
    workflowSecretRefs: validateWorkflowSecretRefs(input.workflowSecretRefs),
  };
  const secretFieldIds = new Set(
    ((validated.workflowDefinition && validated.workflowDefinition.inputs) || [])
      .filter((field) => field && field.secret === true && typeof field.id === 'string' && field.id.trim())
      .map((field) => field.id.trim())
  );
  for (const fieldId of secretFieldIds) {
    if (validated.workflowInputs && Object.prototype.hasOwnProperty.call(validated.workflowInputs, fieldId)) {
      fail(`workflowInputs.${fieldId}`, 'must not include secret field values; use workflowSecretRefs instead.');
    }
  }
  return validated;
}

function loadCloudRunSpec(specPath) {
  const resolvedPath = path.resolve(expectRequiredString(specPath, 'specPath'));
  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read cloud-run spec file: ${resolvedPath} (${message})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid cloud-run spec JSON in ${resolvedPath}: ${message}`);
  }

  return { specPath: resolvedPath, spec: validateCloudRunSpec(parsed) };
}

function buildCloudRunOptions(spec, cliOptions = {}) {
  const useDirectBrowserAgent = !(spec && spec.workflowDefinition);
  const runtimeApiConfig = spec.runtimeApiConfig
    ? {
        provider: spec.runtimeApiConfig.provider,
        model: spec.runtimeApiConfig.model,
        apiKey: spec.runtimeApiConfig.apiKey || undefined,
        baseURL: spec.runtimeApiConfig.baseURL || undefined,
      }
    : null;
  return {
    repoRoot: cliOptions.repoRoot ? path.resolve(cliOptions.repoRoot) : process.cwd(),
    stateRoot: cliOptions.stateRoot ? path.resolve(cliOptions.stateRoot) : undefined,
    runId: spec.runId,
    agentCli: cliOptions.agentCli || undefined,
    controllerCodexMode: cliOptions.controllerCodexMode || undefined,
    controllerCli: runtimeApiConfig ? 'api' : undefined,
    workerCli: runtimeApiConfig ? 'api' : undefined,
    apiConfig: runtimeApiConfig,
    controllerApiConfig: runtimeApiConfig,
    workerApiConfig: runtimeApiConfig,
    agent: useDirectBrowserAgent ? 'QA-Browser' : undefined,
    print: false,
    rawEvents: Boolean(cliOptions.rawEvents),
    quiet: Boolean(cliOptions.quiet),
    noMcpInject: Boolean(cliOptions.noMcpInject),
    cloudRunSpec: {
      version: spec.version,
      runId: spec.runId,
      attemptId: spec.attemptId,
      repositoryId: spec.repositoryId,
      repositoryContextId: spec.repositoryContextId,
      title: spec.title,
      outputDir: path.resolve(spec.outputDir),
      targetUrl: spec.targetUrl,
      targetType: spec.targetType,
      browserPreset: spec.browserPreset,
      aiProfile: spec.aiProfile,
      runtimeApiConfig: spec.runtimeApiConfig,
      workflowDefinition: spec.workflowDefinition,
      workflowProfile: spec.workflowProfile,
      workflowInputs: spec.workflowInputs,
      workflowSecretRefs: spec.workflowSecretRefs,
    },
  };
}

function buildDirectCloudRunPrompt(spec) {
  const prompt = String(spec && spec.prompt ? spec.prompt : '').trim();
  const instructionLines = [];
  if (spec && spec.targetUrl) {
    instructionLines.push(`Use this exact target URL for the test: ${spec.targetUrl}`);
    instructionLines.push('Do not try to discover the app URL from the repository or environment unless the page fails to load.');
    instructionLines.push('Start by opening that URL in the browser and testing there.');
  }
  if (spec && spec.targetType) {
    instructionLines.push(`Target type: ${spec.targetType}`);
  }
  if (spec && spec.browserPreset) {
    instructionLines.push(`Browser preset: ${spec.browserPreset}`);
  }
  if (instructionLines.length === 0) {
    return prompt;
  }
  return [
    'Hosted run execution requirements:',
    ...instructionLines.map((line) => `- ${line}`),
    '',
    prompt,
  ].join('\n');
}

function emitCloudRunRawEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function buildLiveAssistantMessage(actor, label, text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  return {
    kind: 'assistant_message',
    actor,
    label,
    text: trimmed,
  };
}

function buildLiveToolCall(actor, label, toolName, input, options = {}) {
  const normalizedInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const summary = formatToolCall(toolName, normalizedInput);
  const server = typeof options.server === 'string' && options.server ? options.server : null;
  const serverText = server || '';
  const isChromeDevtools = serverText.includes('chrome-devtools') || serverText.includes('chrome_devtools') || String(toolName || '').includes('chrome-devtools') || String(toolName || '').includes('chrome_devtools');
  const isComputerUse = isChromeDevtools || serverText.includes('computer-control') || serverText.includes('computer_control') || String(toolName || '').includes('computer-control') || String(toolName || '').includes('computer_control');
  return {
    kind: 'tool_call',
    actor,
    label,
    toolName,
    summary,
    state: options.state || 'started',
    server,
    input: normalizedInput,
    isComputerUse,
    isChromeDevtools,
  };
}

function buildLiveToolResult(actor, label, toolName, summary) {
  const trimmed = typeof summary === 'string' ? summary.trim() : '';
  return {
    kind: 'tool_result',
    actor,
    label,
    toolName,
    summary: trimmed || `Finished ${toolName}`,
    state: 'completed',
  };
}

function buildLiveSystemNote(actor, label, text, source = null) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  return {
    kind: 'system_note',
    actor,
    label,
    text: trimmed,
    source,
  };
}

function emitCloudRunDetailEvent({ phase, message, liveItem, source, rawLine, parsed }) {
  if (!liveItem) return;
  emitCloudRunRawEvent({
    type: 'session.note',
    phase,
    message,
    _streamDetail: true,
    liveItem,
    source: source || undefined,
    rawLine: rawLine || undefined,
    parsed: parsed || undefined,
  });
}

function normalizeToolInput(input) {
  if (!input) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return {};
}

function summarizeToolResultPayload(output) {
  if (output == null) return 'Tool completed.';
  if (typeof output === 'string') {
    const trimmed = output.trim();
    return trimmed || 'Tool completed.';
  }
  if (typeof output === 'object') {
    if (typeof output.summary === 'string' && output.summary.trim()) return output.summary.trim();
    if (typeof output.text === 'string' && output.text.trim()) return output.text.trim();
    if (Array.isArray(output.content) && output.content.length > 0) {
      const textBlock = output.content.find((block) => block && typeof block.text === 'string' && block.text.trim());
      if (textBlock && typeof textBlock.text === 'string') return textBlock.text.trim();
      const imageBlock = output.content.find((block) => block && block.type === 'image');
      if (imageBlock) return 'Tool returned an image.';
    }
  }
  return 'Tool completed.';
}

function detailFromApiEvent(event, spec) {
  const actor = String(event.source || '').startsWith('controller') ? 'controller' : 'worker';
  const label = actor === 'controller' ? 'Orchestrator' : spec.title;
  if (event.type === 'assistant_message') {
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: typeof event.text === 'string' && event.text.trim() ? event.text.trim() : `${label} replied.`,
      liveItem: buildLiveAssistantMessage(actor, label, event.text),
    };
  }
  if (event.type === 'tool_call') {
    const toolName = typeof event.name === 'string' ? event.name : 'tool';
    const input = normalizeToolInput(event.args || event.input);
    const liveItem = buildLiveToolCall(actor, label, toolName, input, { state: 'started' });
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: liveItem.summary,
      liveItem,
    };
  }
  if (event.type === 'tool_result') {
    const toolName = typeof event.name === 'string' ? event.name : 'tool';
    const summary = summarizeToolResultPayload(event.summary || event.resultSummary || event.result);
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: summary,
      liveItem: buildLiveToolResult(actor, label, toolName, summary),
    };
  }
  if (event.type === 'start') {
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: actor === 'worker' && event.provider && event.model
        ? `Using ${event.provider}/${event.model}`
        : `${label} started.`,
      liveItem: buildLiveSystemNote(actor, label, actor === 'worker' && event.provider && event.model ? `Using ${event.provider}/${event.model}` : `${label} started.`, event.source),
    };
  }
  if (event.type === 'complete') {
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: `${label} completed the current turn.`,
      liveItem: buildLiveSystemNote(actor, label, `${label} completed the current turn.`, event.source),
    };
  }
  return null;
}

function detailFromStructuredJsonEvent(event, spec, pendingClaudeTools) {
  const actor = event.source === 'controller-json' ? 'controller' : 'worker';
  const label = actor === 'controller' ? 'Orchestrator' : spec.title;
  const parsed = event.parsed && typeof event.parsed === 'object' ? event.parsed : null;
  if (!parsed || typeof parsed.type !== 'string') return null;

  if (parsed.type === 'assistant_message' || parsed.type === 'assistant') {
    const text = extractTextFromClaudeContent(parsed.message && parsed.message.content ? parsed.message.content : parsed.content);
    if (text && text.trim()) {
      return {
        phase: actor === 'controller' ? 'planning' : 'execution',
        message: text.trim(),
        liveItem: buildLiveAssistantMessage(actor, label, text),
      };
    }
  }

  if (parsed.type === 'item.agentMessage.delta' && typeof parsed.text === 'string' && parsed.text.trim()) {
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: parsed.text.trim(),
      liveItem: buildLiveAssistantMessage(actor, label, parsed.text),
    };
  }

  if (parsed.type === 'result_message' || parsed.type === 'result') {
    const text = typeof parsed.result === 'string'
      ? parsed.result
      : typeof parsed.result?.text === 'string'
        ? parsed.result.text
        : extractTextFromClaudeContent(parsed.message && parsed.message.content ? parsed.message.content : parsed.content);
    if (text && text.trim()) {
      return {
        phase: actor === 'controller' ? 'planning' : 'execution',
        message: text.trim(),
        liveItem: buildLiveAssistantMessage(actor, label, text),
      };
    }
  }

  if ((parsed.type === 'item.started' || parsed.type === 'item.completed') && parsed.item && typeof parsed.item === 'object') {
    const input = normalizeToolInput(parsed.item.arguments || parsed.item.args || { path: parsed.item.path, command: parsed.item.command, query: parsed.item.query });
    const toolName = parsed.item.type === 'mcp_tool_call'
      ? (parsed.item.tool || 'MCP tool')
      : parsed.item.type === 'command_execution'
        ? 'command_execution'
        : parsed.item.type === 'web_search'
          ? 'web_search'
          : parsed.item.type === 'file_change'
            ? 'file_change'
            : null;
    if (!toolName) {
      return null;
    }
    if (parsed.type === 'item.started') {
      const liveItem = buildLiveToolCall(actor, label, toolName, input, {
        state: 'started',
        server: parsed.item.server || null,
      });
      return {
        phase: actor === 'controller' ? 'planning' : 'execution',
        message: liveItem.summary,
        liveItem,
      };
    }
    const output = typeof parsed.item.output === 'string'
      ? normalizeToolInput(parsed.item.output)
      : (parsed.item.output || parsed.item.result || {});
    const summary = summarizeToolResultPayload(output);
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: summary,
      liveItem: buildLiveToolResult(actor, label, toolName, summary),
    };
  }

  if (parsed.type === 'stream_event' && parsed.event && typeof parsed.event === 'object') {
    const streamEvent = parsed.event;
    const stateKey = `${event.source}:${String(streamEvent.index ?? 'default')}`;
    if (streamEvent.type === 'content_block_start' && streamEvent.content_block && streamEvent.content_block.type === 'tool_use') {
      pendingClaudeTools.set(stateKey, {
        name: streamEvent.content_block.name || 'tool',
        inputJson: '',
      });
      return null;
    }
    if (streamEvent.type === 'content_block_delta' && streamEvent.delta && streamEvent.delta.type === 'input_json_delta') {
      const pending = pendingClaudeTools.get(stateKey);
      if (pending) {
        pending.inputJson += streamEvent.delta.partial_json || '';
      }
      return null;
    }
    if (streamEvent.type === 'content_block_stop') {
      const pending = pendingClaudeTools.get(stateKey);
      if (!pending) return null;
      pendingClaudeTools.delete(stateKey);
      const input = normalizeToolInput(pending.inputJson);
      const liveItem = buildLiveToolCall(actor, label, pending.name, input, { state: 'started' });
      return {
        phase: actor === 'controller' ? 'planning' : 'execution',
        message: liveItem.summary,
        liveItem,
      };
    }
  }

  if (parsed.type === 'error') {
    return {
      phase: actor === 'controller' ? 'planning' : 'execution',
      message: parsed.message || parsed.error || `${label} reported an error.`,
      liveItem: buildLiveSystemNote(actor, label, parsed.message || parsed.error || `${label} reported an error.`, event.source),
    };
  }

  return null;
}

function createCloudRunEventBridge(spec, options = {}) {
  const redactValue = typeof options.redactValue === 'function' ? options.redactValue : (value) => value;
  const pendingClaudeTools = new Map();
  return async (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.source === 'launch-claude' || event.source === 'launch-claude-direct') {
      emitCloudRunRawEvent({
        type: 'session.progress',
        phase: 'execution',
        progressPercent: 15,
        message: `Delegated worker execution for ${spec.title}.`,
      });
      return;
    }
    if (event.source === 'controller-message') {
      const redactedText = redactValue(event.text);
      const noteText = typeof redactedText === 'string' && redactedText.trim()
        ? redactedText.trim()
        : 'QA Panda updated the run plan.';
      emitCloudRunDetailEvent({
        phase: 'planning',
        message: noteText,
        liveItem: buildLiveSystemNote('controller', 'Orchestrator', noteText, event.source),
        source: event.source,
      });
      return;
    }
    if (event.source === 'progress-update') {
      const redactedText = redactValue(event.text);
      emitCloudRunRawEvent({
        type: 'session.progress',
        phase: 'execution',
        message: typeof redactedText === 'string' && redactedText.trim()
          ? redactedText.trim()
          : 'QA Panda reported progress.',
      });
      return;
    }
    if (event.source === 'worker-api' || event.source === 'controller-api') {
      const redactedEvent = redactValue(event);
      const detail = detailFromApiEvent(redactedEvent, spec);
      if (!detail) return;
      emitCloudRunDetailEvent({
        phase: detail.phase,
        message: detail.message,
        liveItem: detail.liveItem,
        source: event.source,
        parsed: redactedEvent,
      });
      return;
    }
    if (event.source === 'worker-json' || event.source === 'controller-json') {
      const redactedEvent = redactValue({
        ...event,
        rawLine: typeof event.rawLine === 'string' ? event.rawLine : null,
        parsed: event.parsed ? event.parsed : null,
      });
      const detail = detailFromStructuredJsonEvent(redactedEvent, spec, pendingClaudeTools);
      if (detail) {
        emitCloudRunDetailEvent({
          phase: detail.phase,
          message: detail.message,
          liveItem: detail.liveItem,
          source: event.source,
          rawLine: redactedEvent.rawLine,
          parsed: redactedEvent.parsed,
        });
        return;
      }
      const payload = {
        source: event.source,
        rawLine: typeof redactedEvent.rawLine === 'string' ? redactedEvent.rawLine : null,
        parsed: redactedEvent.parsed || null,
      };
      const parsedType = payload.parsed && typeof payload.parsed.type === 'string'
        ? payload.parsed.type
        : null;
      emitCloudRunRawEvent({
        type: 'session.note',
        phase: event.source === 'controller-json' ? 'planning' : 'execution',
        message: parsedType
          ? `${event.source}: ${parsedType}`
          : `${event.source}: ${payload.rawLine || 'raw event'}`,
        source: event.source,
        rawLine: payload.rawLine,
        parsed: payload.parsed,
      });
      return;
    }
    if (event.source === 'worker-stderr' || event.source === 'controller-stderr') {
      const redactedText = redactValue(event.text);
      emitCloudRunRawEvent({
        type: 'session.note',
        phase: 'execution',
        message: typeof redactedText === 'string' && redactedText.trim()
          ? `${event.source}: ${redactedText.trim()}`
          : `${event.source}: stderr output`,
        source: event.source,
      });
      return;
    }
    if (event.source === 'worker-result') {
      const redactedText = redactValue(event.text);
      emitCloudRunRawEvent({
        type: 'session.note',
        phase: 'results',
        message: typeof redactedText === 'string' && redactedText.trim()
          ? redactedText.trim()
          : 'Worker turn completed.',
      });
      return;
    }
    if (event.source === 'run-error') {
      const redactedText = redactValue(event.text);
      emitCloudRunRawEvent({
        type: 'session.failed',
        message: typeof redactedText === 'string' && redactedText.trim()
          ? redactedText.trim()
          : 'QA Panda cloud-run failed.',
      });
    }
  };
}

async function detectCloudRunExecutionIssue(manifest) {
  const eventLogPath = manifest && manifest.files ? manifest.files.events : null;
  if (!eventLogPath) return null;
  const eventLog = await readText(eventLogPath, '');
  if (!eventLog) return null;
  if (/fake-codex-session-\d+/i.test(eventLog) || /fake-codex 0\.0\.1/i.test(eventLog)) {
    return 'Hosted cloud-run used the local fake codex shim instead of a real Codex session.';
  }
  return null;
}

function screenshotArtifactsFromEntry(entry, fallbackIndex) {
  const artifacts = [];
  if (!entry || typeof entry !== 'object') return artifacts;
  const addImage = (mimeType, data, index) => {
    if (typeof data !== 'string' || !data.trim()) return;
    const normalizedMime = typeof mimeType === 'string' && mimeType ? mimeType : 'image/png';
    const extension = normalizedMime.includes('jpeg') || normalizedMime.includes('jpg') ? 'jpg' : 'png';
    artifacts.push({
      filename: `screenshot-${String(index).padStart(3, '0')}.${extension}`,
      mimeType: normalizedMime,
      data,
    });
  };

  if (entry.result && Array.isArray(entry.result.content)) {
    for (const block of entry.result.content) {
      if (block && block.type === 'image' && block.data) {
        addImage(block.mimeType, block.data, fallbackIndex + artifacts.length);
      }
    }
  }
  if (entry.payload && entry.payload.type === 'chatScreenshot' && typeof entry.payload.data === 'string') {
    const match = entry.payload.data.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      addImage(match[1], match[2], fallbackIndex + artifacts.length);
    }
  }
  return artifacts;
}

function normalizeTokenCount(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.trunc(parsed);
    }
  }
  return 0;
}

function extractMeasuredUsageFromTranscriptEntries(entries) {
  const sessions = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.kind !== 'backend_event') continue;
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    const source = typeof payload.source === 'string' ? payload.source : null;
    if (!source || !source.endsWith('-api')) continue;
    const sessionKey = typeof entry.sessionKey === 'string' && entry.sessionKey.trim()
      ? entry.sessionKey.trim()
      : source;
    const existing = sessions.get(sessionKey) || {
      sessionKey,
      source,
      provider: null,
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    if (typeof payload.provider === 'string' && payload.provider.trim()) {
      existing.provider = payload.provider.trim();
    }
    if (typeof payload.model === 'string' && payload.model.trim()) {
      existing.model = payload.model.trim();
    }
    if (payload.totalUsage && typeof payload.totalUsage === 'object') {
      const promptTokens = normalizeTokenCount(payload.totalUsage.promptTokens);
      const completionTokens = normalizeTokenCount(payload.totalUsage.completionTokens);
      existing.promptTokens = Math.max(existing.promptTokens, promptTokens);
      existing.completionTokens = Math.max(existing.completionTokens, completionTokens);
      existing.totalTokens = existing.promptTokens + existing.completionTokens;
    }
    sessions.set(sessionKey, existing);
  }

  const normalizedSessions = Array.from(sessions.values())
    .filter((entry) => entry.totalTokens > 0)
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey));
  if (normalizedSessions.length === 0) {
    return null;
  }
  const totals = normalizedSessions.reduce((acc, entry) => ({
    promptTokens: acc.promptTokens + entry.promptTokens,
    completionTokens: acc.completionTokens + entry.completionTokens,
    totalTokens: acc.totalTokens + entry.totalTokens,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  return {
    source: 'transcript_backend_events_v1',
    totals,
    sessions: normalizedSessions,
  };
}

function normalizeCloudRunArtifactStatus(status) {
  return status === 'idle' ? 'succeeded' : status;
}

function publicRuntimeSummary(runtimeApiConfig) {
  if (!runtimeApiConfig || typeof runtimeApiConfig !== 'object' || Array.isArray(runtimeApiConfig)) {
    return null;
  }
  return {
    source: runtimeApiConfig.source || null,
    provider: runtimeApiConfig.provider || null,
    model: runtimeApiConfig.model || null,
  };
}

function publicRunFilesIndex(manifest) {
  return {
    events: manifest.files && manifest.files.events ? 'run-files/events.jsonl' : null,
    transcript: manifest.files && manifest.files.transcript ? 'run-files/transcript.jsonl' : null,
    chatLog: manifest.files && manifest.files.chatLog ? 'run-files/chat.jsonl' : null,
    progress: manifest.files && manifest.files.progress ? 'run-files/progress.md' : null,
  };
}

function buildPublicArtifactManifest(manifest, spec) {
  const sanitizedSpec = sanitizeHostedWorkflowCloudRunSpec(spec);
  return {
    version: 1,
    runId: manifest.runId,
    attemptId: spec.attemptId || null,
    repositoryId: spec.repositoryId || null,
    repositoryContextId: spec.repositoryContextId || null,
    title: spec.title || null,
    targetUrl: spec.targetUrl || null,
    targetType: spec.targetType || null,
    browserPreset: spec.browserPreset || null,
    aiProfile: spec.aiProfile || null,
    runtime: publicRuntimeSummary(sanitizedSpec.runtimeApiConfig),
    workflowDefinition: sanitizedSpec.workflowDefinition || null,
    workflowProfile: sanitizedSpec.workflowProfile || null,
    workflowInputs: sanitizedSpec.workflowInputs || null,
    createdAt: manifest.createdAt || null,
    updatedAt: manifest.updatedAt || null,
    status: normalizeCloudRunArtifactStatus(manifest.status),
    stopReason: manifest.stopReason || null,
    summary: manifest.transcriptSummary || null,
    files: publicRunFilesIndex(manifest),
  };
}

async function writeCloudRunArtifacts(manifest, spec) {
  const outputDir = path.resolve(spec.outputDir);
  const runFilesDir = path.join(outputDir, 'run-files');
  const screenshotsDir = path.join(outputDir, 'screenshots');
  await ensureDir(runFilesDir);
  await ensureDir(screenshotsDir);

  const copiedArtifacts = [];
  const copyTargets = [
    ['manifest.json', manifest.files && manifest.files.manifest],
    ['events.jsonl', manifest.files && manifest.files.events],
    ['transcript.jsonl', manifest.files && manifest.files.transcript],
    ['chat.jsonl', manifest.files && manifest.files.chatLog],
    ['progress.md', manifest.files && manifest.files.progress],
  ];

  for (const [filename, sourcePath] of copyTargets) {
    if (!sourcePath || !(await pathExists(sourcePath))) continue;
    const destinationPath = path.join(runFilesDir, filename);
    if (filename === 'manifest.json') {
      await writeJson(destinationPath, redactHostedWorkflowValue(manifest, buildPublicArtifactManifest(manifest, spec)));
    } else {
      const sourceText = await readText(sourcePath, null);
      if (sourceText == null) {
        await fsp.copyFile(sourcePath, destinationPath);
      } else {
        await writeText(destinationPath, redactHostedWorkflowValue(manifest, sourceText));
      }
    }
    copiedArtifacts.push({ artifactType: filename.endsWith('.md') || filename.endsWith('.jsonl') ? 'log' : 'evidence_bundle', filename: `run-files/${filename}` });
  }

  const transcriptRaw = manifest.files && manifest.files.transcript
    ? await readText(manifest.files.transcript, '')
    : '';
  const transcriptEntries = transcriptRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const measuredUsage = extractMeasuredUsageFromTranscriptEntries(transcriptEntries);

  const screenshotArtifacts = [];
  let screenshotIndex = 1;
  for (const entry of transcriptEntries) {
    const entryArtifacts = screenshotArtifactsFromEntry(entry, screenshotIndex);
    screenshotIndex += entryArtifacts.length;
    screenshotArtifacts.push(...entryArtifacts);
  }
  for (const screenshot of screenshotArtifacts) {
    await fsp.writeFile(path.join(screenshotsDir, screenshot.filename), Buffer.from(screenshot.data, 'base64'));
    copiedArtifacts.push({ artifactType: 'screenshot', filename: `screenshots/${screenshot.filename}` });
  }

  const sanitizedSpec = sanitizeHostedWorkflowCloudRunSpec(spec);
  const summary = {
    runId: manifest.runId,
    attemptId: spec.attemptId,
    repositoryId: spec.repositoryId,
    repositoryContextId: spec.repositoryContextId,
    title: spec.title,
    targetUrl: spec.targetUrl,
    targetType: spec.targetType,
    browserPreset: spec.browserPreset,
    aiProfile: spec.aiProfile,
    runtime: publicRuntimeSummary(sanitizedSpec.runtimeApiConfig),
    workflowDefinition: sanitizedSpec.workflowDefinition,
    workflowProfile: sanitizedSpec.workflowProfile,
    workflowInputs: sanitizedSpec.workflowInputs,
    status: normalizeCloudRunArtifactStatus(manifest.status),
    stopReason: manifest.stopReason || null,
    summary: manifest.transcriptSummary || null,
    measuredUsage,
    generatedAt: nowIso(),
  };
  await writeJson(path.join(outputDir, 'run-report.json'), redactHostedWorkflowValue(manifest, summary));
  copiedArtifacts.push({ artifactType: 'report_json', filename: 'run-report.json' });

  const eventLog = manifest.files && manifest.files.events ? await readText(manifest.files.events, '') : '';
  await writeText(path.join(outputDir, 'session.log'), redactHostedWorkflowValue(manifest, eventLog));
  copiedArtifacts.push({ artifactType: 'log', filename: 'session.log' });

  await writeJson(path.join(outputDir, 'evidence-bundle.json'), redactHostedWorkflowValue(manifest, {
    generatedAt: nowIso(),
    runId: manifest.runId,
    artifacts: copiedArtifacts,
  }));
  copiedArtifacts.push({ artifactType: 'evidence_bundle', filename: 'evidence-bundle.json' });

  return copiedArtifacts;
}

module.exports = {
  CLOUD_RUN_ARG_SPEC,
  CLOUD_RUN_SPEC_VERSION,
  buildDirectCloudRunPrompt,
  buildCloudRunOptions,
  createCloudRunEventBridge,
  detectCloudRunExecutionIssue,
  extractMeasuredUsageFromTranscriptEntries,
  emitCloudRunRawEvent,
  loadCloudRunSpec,
  validateCloudRunSpec,
  writeCloudRunArtifacts,
};
