const { appendJsonl, appendText, nowIso, readText, summarizeError, truncate } = require('./utils');
const { attachWorkerRecord, createLoopRecord, createRequest, getActiveRequest, lookupAgentConfig, saveManifest } = require('./state');
const { runControllerTurn: runCodexControllerTurn, runControllerTurnAppServer } = require('./codex');
const { runClaudeControllerTurn } = require('./claude-controller');
const { runWorkerTurn, runWorkerTurnInteractive, closeInteractiveSessions } = require('./claude');
const { runCodexWorkerTurn, runCodexWorkerTurnAppServer } = require('./codex-worker');
const { runApiControllerTurn } = require('./api-controller');
const { runApiWorkerTurn } = require('./api-worker');
const { controllerLabelFor, workerLabelFor } = require('./render');
const { formatToolCall, summarizeCodexWorkerEvent } = require('./events');
const { closeConnection } = require('./codex-app-server');
const { TurnEntityTracker } = require('./turn-entity-tracker');
const { buildFinalQaReportState, loadQaState } = require('./qa-report');
const { redactHostedWorkflowValue } = require('./cloud/workflow-hosted-runs');
const { appendManifestDebug, summarizeForDebug } = require('./debug-log');
const {
  buildDirectWorkerPrompt,
  syncDirectWorkerChatCursor,
} = require('./direct-worker-handoff');
const {
  appendTranscriptRecord,
  countTranscriptLinesSync,
  createTranscriptRecord,
  controllerSessionKey,
  transcriptBackend,
  workerSessionKey,
} = require('./transcript');
const {
  buildUserMessageContent,
  buildUserMessageDisplay,
  normalizeAttachmentList,
  persistUserMessageAttachments,
  userMessageSummaryText,
} = require('./user-message-content');

/**
 * Create an activity log accumulator that captures tool calls and text
 * from worker events — the same info the user sees in the UI.
 * Returns { log: string[], feed(parsedEvent) }.
 */
function createActivityLog() {
  const log = [];
  const pendingTools = new Map(); // index → { name, inputJson }
  let textBuffer = '';

  function flushText() {
    if (textBuffer.trim()) {
      log.push(textBuffer.trim());
      textBuffer = '';
    }
  }

  return {
    log,
    feed(parsed) {
      if (!parsed) return;

      // Claude streaming events (content_block_start/delta/stop)
      const event = (parsed.type === 'stream_event') ? (parsed.event || {}) : parsed;

      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        flushText();
        pendingTools.set(event.index, { name: event.content_block.name || 'tool', inputJson: '' });
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
        const tc = pendingTools.get(event.index);
        if (tc) tc.inputJson += (event.delta.partial_json || '');
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        textBuffer += (event.delta.text || '');
        return;
      }
      if (event.type === 'content_block_stop') {
        const tc = pendingTools.get(event.index);
        if (tc) {
          let input = {};
          try { input = JSON.parse(tc.inputJson); } catch {}
          log.push(formatToolCall(tc.name, input));
          pendingTools.delete(event.index);
        }
        return;
      }

      // Codex worker events (item.started/item.completed)
      if (parsed.type === 'item.started' || parsed.type === 'item.completed') {
        const summary = summarizeCodexWorkerEvent(parsed);
        if (summary && summary.kind === 'status') {
          log.push(summary.text);
        }
        return;
      }

      // Codex agent_message (text output)
      if (parsed.type === 'item.started' && parsed.item?.type === 'agent_message' && parsed.item?.text) {
        flushText();
        log.push(parsed.item.text);
      }
    },
    finish() {
      flushText();
    },
  };
}

function getControllerRunner(manifest) {
  if (manifest.controller.cli === 'api') return runApiControllerTurn;
  if (manifest.controller.cli === 'claude') return runClaudeControllerTurn;
  if (manifest.controller.codexMode === 'app-server') return runControllerTurnAppServer;
  return runCodexControllerTurn;
}

function getWorkerRunner(manifest, agentConfig) {
  const cli = (agentConfig && agentConfig.cli) || manifest.worker.cli || 'codex';
  if (cli === 'api') return runApiWorkerTurn;
  if (cli === 'codex' || cli === 'qa-remote-codex') {
    const codexMode = (agentConfig && agentConfig.codexMode) || manifest.controller.codexMode || 'app-server';
    if (codexMode === 'app-server') return runCodexWorkerTurnAppServer;
    return runCodexWorkerTurn;
  }
  // Interactive mode: use persistent PTY session instead of spawning per turn
  const runMode = (agentConfig && agentConfig.runMode) || manifest.worker.runMode || 'print';
  if (runMode === 'interactive' && (cli === 'claude' || !cli)) return runWorkerTurnInteractive;
  return runWorkerTurn;
}

function setControllerLabel(renderer, manifest) {
  if (renderer && manifest && manifest.controller) {
    renderer.controllerLabel = controllerLabelFor(manifest.controller.cli);
  }
}

function setWorkerLabel(renderer, manifest) {
  if (renderer && manifest && manifest.worker) {
    renderer.workerLabel = workerLabelFor(manifest.worker.cli);
  }
}

async function runWorkerWithTracking(runWorker, workerOpts) {
  const tracker = new TurnEntityTracker({
    manifest: workerOpts.manifest,
    renderer: workerOpts.renderer,
    request: workerOpts.request,
  });
  try {
    const result = await runWorker({ ...workerOpts, turnTracker: tracker });
    await tracker.finalize({ emitFinalCards: true });
    return result;
  } catch (error) {
    await tracker.finalize({ emitFinalCards: false });
    throw error;
  }
}

async function emitFinalQaReport(manifest, request, renderer) {
  if (renderer && typeof renderer._post === 'function') {
    renderer._post({ type: 'clearLiveQaReportCard' });
  }
  const finalState = buildFinalQaReportState({
    manifest,
    request,
    state: loadQaState(manifest.repoRoot),
  });
  if (!finalState) {
    return false;
  }
  manifest.qaReportSession = finalState.sessionArtifacts;
  request.qaReportArtifacts = finalState.requestArtifacts;
  request.qaReportSummary = finalState.payload;
  request.qaReportLabel = finalState.label || request.qaReportLabel || null;
  if (renderer && typeof renderer._post === 'function') {
    renderer._post({
      type: 'qaReportCard',
      label: request.qaReportLabel || workerLabelFor(manifest.worker.cli),
      data: finalState.payload,
    });
  }
  return true;
}

function progressTimestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function redactRuntimeValue(manifest, value) {
  return redactHostedWorkflowValue(manifest, value);
}

async function appendJsonlRedacted(manifest, filePath, value) {
  await appendJsonl(filePath, redactRuntimeValue(manifest, value));
}

async function appendProgress(manifest, line, renderer) {
  if (!manifest.files || !manifest.files.progress) return;
  const entry = String(redactRuntimeValue(manifest, `[${progressTimestamp()}] ${line}\n`));
  try {
    await appendText(manifest.files.progress, entry);
  } catch {
    // Non-critical — don't break the run
  }
  if (renderer && typeof renderer.progress === 'function') {
    renderer.progress(entry.trimEnd());
  }
}

async function emitEvent(manifest, event, renderer, onEvent) {
  const safeEvent = redactRuntimeValue(manifest, event);
  await appendJsonl(manifest.files.events, safeEvent);
  if (typeof onEvent === 'function') {
    await onEvent(safeEvent);
  }
  if (renderer && safeEvent.source === 'shell' && safeEvent.text) {
    renderer.shell(safeEvent.text);
  }
}

function workerTranscriptMeta(manifest, agentId) {
  const resolvedAgentId = agentId && agentId !== 'default' ? agentId : null;
  const agentConfig = resolvedAgentId ? lookupAgentConfig(manifest.agents, resolvedAgentId) : null;
  const workerCli = (agentConfig && agentConfig.cli) || manifest.worker.cli || 'codex';
  return {
    agentId: resolvedAgentId,
    agentConfig,
    sessionKey: workerSessionKey(resolvedAgentId),
    backend: transcriptBackend('worker', workerCli),
    workerCli,
    agentName: agentConfig ? agentConfig.name : null,
  };
}

function transcriptBackendEventPreview(value, maxLength = 4000) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? truncate(trimmed, maxLength) : null;
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      if (typeof item.text === 'string') return item.text;
      if (typeof item.content === 'string') return item.content;
      return '';
    }).filter(Boolean);
    const joined = parts.join('\n').trim();
    return joined ? truncate(joined, maxLength) : null;
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') {
      return transcriptBackendEventPreview(value.text, maxLength);
    }
    if (Array.isArray(value.content)) {
      return transcriptBackendEventPreview(value.content, maxLength);
    }
  }
  return null;
}

function compactBackendTranscriptPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const item = payload.item && typeof payload.item === 'object' ? payload.item : null;
  if (!item || item.type === 'mcp_tool_call') {
    return payload;
  }

  const summary = {
    type: payload.type || null,
    item: {
      type: item.type || null,
      id: item.id || null,
    },
  };

  const preview = transcriptBackendEventPreview(item.content || item.text || item.message || null);
  if (preview) {
    summary.item.textPreview = preview;
  }
  if (typeof item.role === 'string') {
    summary.item.role = item.role;
  }
  if (typeof item.status === 'string') {
    summary.item.status = item.status;
  }
  if (typeof item.tool === 'string') {
    summary.item.tool = item.tool;
  }
  if (typeof item.server === 'string') {
    summary.item.server = item.server;
  }
  if (typeof payload.turnId === 'string') {
    summary.turnId = payload.turnId;
  }
  if (typeof payload.threadId === 'string') {
    summary.threadId = payload.threadId;
  }

  return summary;
}

async function appendTranscript(manifest, data) {
  await appendTranscriptRecord(manifest, createTranscriptRecord(data));
}

async function appendBackendTranscriptEvent(manifest, event, options = {}) {
  const source = String(event && event.source || '');
  if (!source.includes('-json') && source !== 'controller-api' && source !== 'worker-api') {
    return;
  }
  const payload = event && event.parsed
    ? event.parsed
    : Object.fromEntries(
        Object.entries(event || {}).filter(([key, value]) =>
          !['ts', 'requestId', 'loopIndex', 'rawLine'].includes(key) && value !== undefined
        )
      );
  await appendTranscript(manifest, {
    kind: 'backend_event',
    sessionKey: options.sessionKey,
    backend: options.backend,
    requestId: event.requestId || options.requestId || null,
    loopIndex: event.loopIndex == null ? options.loopIndex ?? null : event.loopIndex,
    agentId: options.agentId || null,
    controllerCli: options.controllerCli || null,
    workerCli: options.workerCli || null,
    payload: compactBackendTranscriptPayload(payload),
    text: event && event.text != null ? String(event.text) : null,
    labelHint: options.labelHint || null,
  });
}

function syncControllerTranscriptCursor(manifest) {
  try {
    manifest.controller.lastSeenTranscriptLine = countTranscriptLinesSync(manifest.files && manifest.files.transcript);
  } catch {}
}

function buildLaunchText(prompt, sameSession, agentId, agentCli, agentName) {
  const backendLabel = agentCli ? workerLabelFor(agentCli, agentName) : 'Worker';
  const agentLabel = !agentName && agentId && agentId !== 'default' ? ` [${agentId}]` : '';
  const prefix = sameSession
    ? `Launching ${backendLabel}${agentLabel} (same session) with: `
    : `Launching ${backendLabel}${agentLabel} with: `;
  return `${prefix}"${prompt}"`;
}

function normalizeDecisionAgentId(agentId) {
  if (agentId == null || agentId === 'default') return null;
  return String(agentId);
}

function describeContinueLockAgentId(agentId) {
  return agentId == null ? 'default worker' : `agent "${agentId}"`;
}

function continueLockMismatch(decision, continueLock) {
  if (!continueLock || !decision || decision.action !== 'delegate') return null;
  const expectedAgentId = normalizeDecisionAgentId(continueLock.agentId);
  const actualAgentId = normalizeDecisionAgentId(decision.agent_id);
  if (actualAgentId === expectedAgentId) return null;
  return {
    expectedAgentId,
    actualAgentId,
  };
}

function buildContinueValidationCorrection(continueLock, mismatch) {
  const expectedAgentId = normalizeDecisionAgentId(continueLock && continueLock.agentId);
  const expectedText = expectedAgentId == null
    ? 'Set agent_id to null or "default". Do not choose any named agent.'
    : `Set agent_id to "${expectedAgentId}". Do not choose any other agent_id.`;
  const actualText = mismatch.actualAgentId == null ? 'null/"default"' : `"${mismatch.actualAgentId}"`;
  return [
    'CONTINUE VALIDATION CORRECTION — Your previous JSON selected the wrong agent for this Continue turn.',
    `The active Continue target is locked to ${describeContinueLockAgentId(expectedAgentId)}.`,
    `Your previous decision used agent_id ${actualText}.`,
    'You MUST return action: "delegate" with the locked target if you are delegating.',
    expectedText,
  ].join('\n');
}

function markInterrupted(manifest, request, reason) {
  manifest.status = 'interrupted';
  manifest.phase = 'idle';
  manifest.error = reason;
  if (request && request.status === 'running') {
    request.status = 'interrupted';
    request.stopReason = reason;
  }
}

async function startUserRequest(manifest, renderer, userMessage, options = {}) {
  const normalizedUserMessage = userMessage == null ? '' : String(userMessage);
  const userAttachments = normalizeAttachmentList(options.userAttachments);
  const requestSummary = options.requestSummary || userMessageSummaryText(normalizedUserMessage, userAttachments);
  const request = createRequest(manifest, requestSummary);
  manifest.status = 'running';
  manifest.phase = options.phase || 'controller';
  manifest.stopReason = null;
  manifest.error = null;

  let userContent = options.userContent;
  if (userContent === undefined) {
    const attachmentParts = options.userAttachmentParts || await persistUserMessageAttachments(manifest, request.id, userAttachments);
    userContent = buildUserMessageContent(normalizedUserMessage, attachmentParts);
  }
  const displayUser = buildUserMessageDisplay(userContent);

  if (options.render !== false) {
    renderer.user(displayUser.text, displayUser.attachments);
  }
  await appendTranscript(manifest, {
    kind: 'user_message',
    sessionKey: options.sessionKey || controllerSessionKey(),
    backend: options.backend || 'user',
    requestId: request.id,
    loopIndex: options.loopIndex == null ? null : options.loopIndex,
    agentId: options.agentId || null,
    workerCli: options.workerCli || null,
    text: options.displayText !== undefined ? String(options.displayText || '') : displayUser.text,
    payload: { role: 'user', content: userContent },
    display: options.display !== false,
  });
  await emitEvent(
    manifest,
    { ts: nowIso(), source: 'user-message', requestId: request.id, text: requestSummary },
    renderer,
    options.onEvent,
  );
  await saveManifest(manifest);
  return { request, userContent };
}

function getRunnableRequest(manifest) {
  const request = getActiveRequest(manifest);
  if (!request) {
    return null;
  }
  if (request.status === 'running' || request.status === 'interrupted') {
    return request;
  }
  return null;
}

async function runManagerLoop(manifest, renderer, options = {}) {
  appendManifestDebug('orchestrator', manifest, 'runManagerLoop:start', {
    userMessage: options.userMessage || null,
    singlePass: !!options.singlePass,
    hasAbortSignal: !!options.abortSignal,
    status: manifest && manifest.status || null,
    controllerCli: manifest && manifest.controller && manifest.controller.cli || null,
    codexMode: manifest && manifest.controller && manifest.controller.codexMode || null,
  });
  if (options.controllerLabel) {
    renderer.controllerLabel = options.controllerLabel;
  } else {
    setControllerLabel(renderer, manifest);
  }
  setWorkerLabel(renderer, manifest);
  const userMessage = options.userMessage == null ? null : String(options.userMessage).trim();
  let request = null;

  if (userMessage) {
    request = (await startUserRequest(manifest, renderer, userMessage)).request;
    appendManifestDebug('orchestrator', manifest, 'runManagerLoop:request-started', {
      requestId: request && request.id || null,
      userMessage,
    });
  } else {
    request = getRunnableRequest(manifest);
    if (!request) {
      throw new Error('There is no active interrupted request to continue. Send a new message instead.');
    }
    manifest.status = 'running';
    manifest.phase = 'controller';
    manifest.error = null;
    await saveManifest(manifest);
    appendManifestDebug('orchestrator', manifest, 'runManagerLoop:resuming-existing-request', {
      requestId: request && request.id || null,
      status: request && request.status || null,
    });
  }

  const signalController = new AbortController();
  const onSignal = (signal) => {
    appendManifestDebug('orchestrator', manifest, 'runManagerLoop:abort-signal', {
      requestId: request && request.id || null,
      signal,
      status: manifest && manifest.status || null,
      phase: manifest && manifest.phase || null,
    });
    markInterrupted(manifest, request, `Received ${signal}.`);
    signalController.abort();
  };
  const onSigInt = () => onSignal('SIGINT');
  const onSigTerm = () => onSignal('SIGTERM');

  // Allow external abort (e.g. from VSCode extension stop button)
  if (options.abortSignal) {
    const onExternalAbort = () => onSignal('external-abort');
    if (options.abortSignal.aborted) {
      onExternalAbort();
    } else {
      options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    while (true) {
      const loop = await createLoopRecord(manifest, request);
      await saveManifest(manifest);
      appendManifestDebug('orchestrator', manifest, 'runManagerLoop:loop-created', {
        requestId: request && request.id || null,
        loopIndex: loop && loop.index != null ? loop.index : null,
      });

      const runControllerTurn = getControllerRunner(manifest);
      const controllerBackend = transcriptBackend('controller', manifest.controller.cli || 'codex');
      const continueLock = options.continueLock || null;
      const baseControllerPromptOverride = options.controllerPromptOverride || null;
      let controllerPromptOverride = baseControllerPromptOverride;
      let controllerResult = null;
      let controllerValidationRetryCount = 0;
      loop.controller.continueLockedAgentId = continueLock
        ? normalizeDecisionAgentId(continueLock.agentId)
        : undefined;

      while (true) {
        appendManifestDebug('orchestrator', manifest, 'runManagerLoop:controller-turn:start', {
          requestId: request && request.id || null,
          loopIndex: loop && loop.index != null ? loop.index : null,
          controllerCli: manifest.controller.cli || 'codex',
          codexMode: manifest.controller.codexMode || null,
          controllerSessionId: manifest.controller.sessionId || null,
          controllerAppServerThreadId: manifest.controller.appServerThreadId || null,
          continueLockedAgentId: continueLock ? normalizeDecisionAgentId(continueLock.agentId) : undefined,
          controllerValidationRetryCount,
        });
        controllerResult = await runControllerTurn({
          manifest,
          request,
          loop,
          renderer,
          abortSignal: signalController.signal,
          controllerPromptOverride,
          emitEvent: async (event) => {
            if (event.rawLine && loop.controller.stdoutFile) {
              await appendJsonlRedacted(manifest, loop.controller.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
            }
            if (event.source === 'controller-stderr' && loop.controller.stderrFile) {
              await appendJsonlRedacted(manifest, loop.controller.stderrFile, { text: event.text });
            }
            await emitEvent(manifest, event, renderer, options.onEvent);
            await appendBackendTranscriptEvent(manifest, event, {
              sessionKey: controllerSessionKey(),
              backend: controllerBackend,
              requestId: request.id,
              loopIndex: loop.index,
              controllerCli: manifest.controller.cli || 'codex',
            });
          },
        });

        const mismatch = continueLock ? continueLockMismatch(controllerResult.decision, continueLock) : null;
        if (!mismatch) break;

        appendManifestDebug('orchestrator', manifest, 'runManagerLoop:continue-lock-mismatch', {
          requestId: request && request.id || null,
          loopIndex: loop && loop.index != null ? loop.index : null,
          expectedAgentId: mismatch.expectedAgentId,
          actualAgentId: mismatch.actualAgentId,
          controllerValidationRetryCount,
        });
        await emitEvent(
          manifest,
          {
            ts: nowIso(),
            source: 'controller-continue-lock-mismatch',
            requestId: request.id,
            loopIndex: loop.index,
            expectedAgentId: mismatch.expectedAgentId,
            actualAgentId: mismatch.actualAgentId,
            retrying: controllerValidationRetryCount === 0,
          },
          renderer,
          options.onEvent,
        );

        if (controllerValidationRetryCount >= 1) {
          throw new Error(
            `Continue controller selected ${describeContinueLockAgentId(mismatch.actualAgentId)} but the active Continue target is locked to ${describeContinueLockAgentId(mismatch.expectedAgentId)}.`
          );
        }

        controllerValidationRetryCount += 1;
        loop.controller.validationRetryCount = controllerValidationRetryCount;
        controllerPromptOverride = [
          baseControllerPromptOverride || '',
          buildContinueValidationCorrection(continueLock, mismatch),
        ].filter(Boolean).join('\n\n');
      }

      loop.controller.decision = controllerResult.decision;
      request.latestControllerDecision = controllerResult.decision;
      appendManifestDebug('orchestrator', manifest, 'runManagerLoop:controller-turn:done', {
        requestId: request && request.id || null,
        loopIndex: loop && loop.index != null ? loop.index : null,
        action: controllerResult && controllerResult.decision && controllerResult.decision.action || null,
        agentId: controllerResult && controllerResult.decision && controllerResult.decision.agent_id || null,
        stopReason: controllerResult && controllerResult.decision && controllerResult.decision.stop_reason || null,
        controllerSessionId: controllerResult && controllerResult.sessionId || manifest.controller.sessionId || null,
        continueLockedAgentId: continueLock ? normalizeDecisionAgentId(continueLock.agentId) : undefined,
        controllerValidationRetryCount,
      });

      for (const message of controllerResult.decision.controller_messages) {
        renderer.controller(message);
        await appendTranscript(manifest, {
          kind: 'controller_message',
          sessionKey: controllerSessionKey(),
          backend: controllerBackend,
          text: message,
          controllerCli: manifest.controller.cli || 'codex',
          requestId: request.id,
          loopIndex: loop.index,
        });
        await emitEvent(
          manifest,
          {
            ts: nowIso(),
            source: 'controller-message',
            requestId: request.id,
            loopIndex: loop.index,
            text: message,
          },
          renderer,
        );
      }

      for (const line of controllerResult.decision.progress_updates || []) {
        await appendProgress(manifest, line, renderer);
        await emitEvent(
          manifest,
          { ts: nowIso(), source: 'progress-update', requestId: request.id, loopIndex: loop.index, text: line },
          renderer,
          options.onEvent,
        );
      }

      if (controllerResult.decision.action === 'stop') {
        request.status = 'stopped';
        request.stopReason = controllerResult.decision.stop_reason || 'Controller emitted stop.';
        request.finishedAt = nowIso();
        loop.finishedAt = nowIso();
        manifest.status = 'idle';
        manifest.phase = 'idle';
        manifest.stopReason = request.stopReason;
        manifest.activeRequestId = null;
        manifest.transcriptSummary = truncate(request.userMessage, 120);
        await emitFinalQaReport(manifest, request, renderer);
        renderer.stop();
        await appendTranscript(manifest, {
          kind: 'controller_message',
          sessionKey: controllerSessionKey(),
          backend: controllerBackend,
          text: '[STOP]',
          controllerCli: manifest.controller.cli || 'codex',
          requestId: request.id,
          loopIndex: loop.index,
        });
        syncControllerTranscriptCursor(manifest);
        await emitEvent(
          manifest,
          {
            ts: nowIso(),
            source: 'controller-stop',
            requestId: request.id,
            loopIndex: loop.index,
            stopReason: request.stopReason,
          },
          renderer,
          options.onEvent,
        );
        await saveManifest(manifest);
        appendManifestDebug('orchestrator', manifest, 'runManagerLoop:stop', {
          requestId: request && request.id || null,
          loopIndex: loop && loop.index != null ? loop.index : null,
          stopReason: request.stopReason || null,
        });
        return manifest;
      }

      const workerRecord = attachWorkerRecord(manifest, loop);
      manifest.phase = 'worker';
      await saveManifest(manifest);

      const delegateAgentId = controllerResult.decision.agent_id || null;
      const delegateAgentConfig = delegateAgentId && delegateAgentId !== 'default'
        ? lookupAgentConfig(manifest.agents, delegateAgentId)
        : null;
      const delegateCli = (delegateAgentConfig && delegateAgentConfig.cli) || manifest.worker.cli || 'codex';
      const workerMeta = workerTranscriptMeta(manifest, delegateAgentId);
      const workerSameSession = delegateAgentId && delegateAgentId !== 'default'
        ? !!((manifest.worker.agentSessions || {})[delegateAgentId] || {}).hasStarted
        : manifest.worker.hasStarted;
      const delegateAgentName = delegateAgentConfig ? delegateAgentConfig.name : null;
      renderer.launchClaude(controllerResult.decision.claude_message, workerSameSession, delegateAgentId, delegateCli, delegateAgentName);
      await appendTranscript(manifest, {
        kind: 'launch',
        sessionKey: controllerSessionKey(),
        backend: controllerBackend,
        requestId: request.id,
        loopIndex: loop.index,
        controllerCli: manifest.controller.cli || 'codex',
        agentId: workerMeta.agentId,
        text: buildLaunchText(controllerResult.decision.claude_message, workerSameSession, delegateAgentId, delegateCli, delegateAgentName),
      });
      await appendTranscript(manifest, {
        kind: 'user_message',
        sessionKey: workerMeta.sessionKey,
        backend: 'user',
        requestId: request.id,
        loopIndex: loop.index,
        agentId: workerMeta.agentId,
        workerCli: workerMeta.workerCli,
        text: controllerResult.decision.claude_message,
        payload: { role: 'user', content: controllerResult.decision.claude_message },
        display: false,
      });
      syncControllerTranscriptCursor(manifest);
      await emitEvent(
        manifest,
        {
          ts: nowIso(),
          source: 'launch-claude',
          requestId: request.id,
          loopIndex: loop.index,
          sameSession: workerSameSession,
          prompt: controllerResult.decision.claude_message,
        },
        renderer,
        options.onEvent,
      );

      const runWorker = getWorkerRunner(manifest, delegateAgentConfig);
      appendManifestDebug('orchestrator', manifest, 'runManagerLoop:worker-turn:start', {
        requestId: request && request.id || null,
        loopIndex: loop && loop.index != null ? loop.index : null,
        agentId: delegateAgentId,
        workerCli: delegateCli,
      });
      const activityLog = createActivityLog();
      workerRecord.activityLog = activityLog.log; // Store reference before execution so interrupts don't lose data
      let workerResult;
      if (typeof options.onWorkerStart === 'function') {
        await options.onWorkerStart(controllerResult.decision.agent_id || null);
      }
      try {
        workerResult = await runWorkerWithTracking(runWorker, {
          manifest,
          request,
          loop,
          workerRecord,
          prompt: controllerResult.decision.claude_message,
          agentId: controllerResult.decision.agent_id || null,
          renderer,
          abortSignal: signalController.signal,
          emitEvent: async (event) => {
            if (event.rawLine && workerRecord.stdoutFile) {
              await appendJsonlRedacted(manifest, workerRecord.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
            }
            if (event.source === 'worker-stderr' && workerRecord.stderrFile) {
              await appendJsonlRedacted(manifest, workerRecord.stderrFile, { text: event.text });
            }
            activityLog.feed(event.parsed);
            await emitEvent(manifest, event, renderer, options.onEvent);
            await appendBackendTranscriptEvent(manifest, event, {
              sessionKey: workerMeta.sessionKey,
              backend: workerMeta.backend,
              requestId: request.id,
              loopIndex: loop.index,
              agentId: workerMeta.agentId,
              workerCli: workerMeta.workerCli,
            });
          },
        });
        activityLog.finish();
      } finally {
        if (typeof options.onWorkerEnd === 'function') {
          await options.onWorkerEnd(controllerResult.decision.agent_id || null);
        }
      }

      if (delegateCli !== 'api') {
        await appendTranscript(manifest, {
          kind: 'assistant_message',
          sessionKey: workerMeta.sessionKey,
          backend: workerMeta.backend,
          requestId: request.id,
          loopIndex: loop.index,
          agentId: workerMeta.agentId,
          workerCli: workerMeta.workerCli,
          text: workerResult.resultText,
          payload: { role: 'assistant', content: workerResult.resultText },
        });
      }
      await emitEvent(
        manifest,
        {
          ts: nowIso(),
          source: 'worker-result',
          requestId: request.id,
          loopIndex: loop.index,
          exitCode: workerResult.exitCode,
          text: workerResult.resultText,
        },
        renderer,
        options.onEvent,
      );

      loop.finishedAt = nowIso();
      manifest.phase = 'controller';
      manifest.transcriptSummary = truncate(workerResult.resultText || request.userMessage, 120);
      await saveManifest(manifest);
      appendManifestDebug('orchestrator', manifest, 'runManagerLoop:worker-turn:done', {
        requestId: request && request.id || null,
        loopIndex: loop && loop.index != null ? loop.index : null,
        exitCode: workerResult && workerResult.exitCode,
        resultPreview: summarizeForDebug(workerResult && workerResult.resultText || '', 300),
      });

      // In singlePass mode, return after one controller→worker cycle
      // Caller checks manifest.status === 'running' to know more work is pending
      if (options.singlePass) {
        appendManifestDebug('orchestrator', manifest, 'runManagerLoop:return-single-pass', {
          requestId: request && request.id || null,
          loopIndex: loop && loop.index != null ? loop.index : null,
          status: manifest.status,
          phase: manifest.phase,
        });
        return manifest;
      }
    }
  } catch (error) {
    const message = summarizeError(error);
    markInterrupted(manifest, request, message);
    await emitEvent(
      manifest,
      { ts: nowIso(), source: 'run-error', requestId: request ? request.id : null, text: message },
      renderer,
      options.onEvent,
    );
    await saveManifest(manifest);
    appendManifestDebug('orchestrator', manifest, 'runManagerLoop:error', {
      requestId: request && request.id || null,
      error: error && error.stack ? error.stack : message,
    });
    throw error;
  } finally {
    appendManifestDebug('orchestrator', manifest, 'runManagerLoop:finally', {
      requestId: request && request.id || null,
      status: manifest && manifest.status || null,
      phase: manifest && manifest.phase || null,
      controllerCli: manifest && manifest.controller && manifest.controller.cli || null,
      codexMode: manifest && manifest.controller && manifest.controller.codexMode || null,
    });
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    // Clean up app-server connections when the run ends
    if (manifest.controller.codexMode === 'app-server') {
      closeConnection(manifest.runId).catch(() => {});
    }
  }
}

async function printRunSummary(manifest, out = process.stdout) {
  const request = manifest.requests[manifest.requests.length - 1] || null;
  out.write(`Run: ${manifest.runId}\n`);
  out.write(`Repo: ${manifest.repoRoot}\n`);
  out.write(`Status: ${manifest.status}\n`);
  out.write(`Controller CLI: ${manifest.controller.cli || 'codex'}\n`);
  out.write(`Controller session: ${manifest.controller.sessionId || '(not started)'}\n`);
  out.write(`Claude session: ${manifest.worker.sessionId || '(not started)'}\n`);
  if (request) {
    out.write(`Last request: ${request.userMessage}\n`);
    out.write(`Last request status: ${request.status}\n`);
    if (request.stopReason) {
      out.write(`Stop reason: ${request.stopReason}\n`);
    }
  }
}

async function printEventTail(manifest, tail = 40, out = process.stdout) {
  const text = await readText(manifest.files.events, '');
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-tail);
  if (lines.length === 0) {
    out.write('(no events yet)\n');
    return;
  }
  out.write(`${lines.join('\n')}\n`);
}

async function runDirectWorkerTurn(manifest, renderer, options = {}) {
  const userMessage = options.userMessage == null ? '' : String(options.userMessage).trim();
  const userAttachments = normalizeAttachmentList(options.userAttachments);
  if (!userMessage && userAttachments.length === 0) {
    throw new Error('No message provided for direct worker turn.');
  }

  const agentId = options.agentId || null;
  const agentConfig = agentId ? lookupAgentConfig(manifest.agents, agentId) : null;
  const workerMeta = workerTranscriptMeta(manifest, agentId);
  const visibleUserMessage = options.visibleUserMessage == null
    ? userMessage
    : String(options.visibleUserMessage).trim();
  const workerPromptBase = options.workerPromptBase == null
    ? userMessage
    : String(options.workerPromptBase);
  const shouldInjectChatTail = Boolean(options.enableWorkerHandoff || options.includeChatTail);
  const actualWorkerPrompt = options.actualWorkerPrompt != null
    ? String(options.actualWorkerPrompt)
    : (
        shouldInjectChatTail
          ? (await buildDirectWorkerPrompt(manifest, agentId, workerPromptBase, {
              maxChars: options.chatTailMaxChars,
            })).prompt
      : workerPromptBase
      );
  const sameSession = agentId && agentId !== 'default'
    ? !!((manifest.worker.agentSessions || {})[agentId] || {}).hasStarted
    : !!(manifest.worker && manifest.worker.hasStarted);
  const runWorker = getWorkerRunner(manifest, agentConfig);

  if (userAttachments.length > 0 && runWorker === runWorkerTurnInteractive) {
    throw new Error('Image attachments are not supported in Claude interactive mode. Switch the agent run mode to Default (stream-json).');
  }

  let request;
  let directUserContent = buildUserMessageContent(visibleUserMessage, []);
  if (options.isDelegation) {
    // Agent-to-agent delegation: create request record and show launch message with "Agent delegation" label
    request = createRequest(manifest, visibleUserMessage);
    manifest.status = 'running';
    manifest.phase = 'controller';
    manifest.stopReason = null;
    manifest.error = null;
    const agentCli = (agentConfig && agentConfig.cli) || manifest.worker.cli || 'codex';
    const agentName = agentConfig ? agentConfig.name : null;
    const launchLabelHint = options.launchLabelHint || 'Agent delegation';
    renderer.launchClaude(visibleUserMessage, sameSession, agentId, agentCli, agentName, launchLabelHint);
    await appendTranscript(manifest, {
      kind: 'delegation',
      sessionKey: controllerSessionKey(),
      backend: transcriptBackend('controller', manifest.controller.cli || 'codex'),
      requestId: request.id,
      agentId: workerMeta.agentId,
      text: buildLaunchText(visibleUserMessage, sameSession, agentId, agentCli, agentName),
      labelHint: launchLabelHint,
      controllerCli: manifest.controller.cli || 'codex',
    });
    await appendTranscript(manifest, {
      kind: 'user_message',
      sessionKey: workerMeta.sessionKey,
      backend: 'user',
      requestId: request.id,
      agentId: workerMeta.agentId,
      workerCli: workerMeta.workerCli,
      text: visibleUserMessage,
      payload: { role: 'user', content: visibleUserMessage },
      display: false,
    });
    await emitEvent(
      manifest,
      {
        ts: nowIso(),
        source: options.launchSource || 'delegation',
        requestId: request.id,
        text: visibleUserMessage,
        agentId,
      },
      renderer,
      options.onEvent,
    );
    await saveManifest(manifest);
  } else {
    const started = await startUserRequest(manifest, renderer, visibleUserMessage, {
      phase: 'worker',
      sessionKey: workerMeta.sessionKey,
      agentId: workerMeta.agentId,
      workerCli: workerMeta.workerCli,
      userAttachments,
    });
    request = started.request;
    directUserContent = started.userContent;
  }

  const signalController = new AbortController();
  const onSignal = (signal) => {
    markInterrupted(manifest, request, `Received ${signal}.`);
    signalController.abort();
  };
  const onSigInt = () => onSignal('SIGINT');
  const onSigTerm = () => onSignal('SIGTERM');

  if (options.abortSignal) {
    const onExternalAbort = () => onSignal('external-abort');
    if (options.abortSignal.aborted) {
      onExternalAbort();
    } else {
      options.abortSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);

  try {
    const loop = await createLoopRecord(manifest, request);
    const workerRecord = attachWorkerRecord(manifest, loop);
    manifest.phase = 'worker';
    await saveManifest(manifest);

    await emitEvent(
      manifest,
      {
        ts: nowIso(),
        source: 'launch-claude-direct',
        requestId: request.id,
        loopIndex: loop.index,
        sameSession,
        prompt: visibleUserMessage,
      },
      renderer,
      options.onEvent,
    );

    const activityLog = createActivityLog();
    workerRecord.activityLog = activityLog.log; // Store reference before execution so interrupts don't lose data

    let workerResult;
    if (typeof options.onWorkerStart === 'function') {
      await options.onWorkerStart(agentId);
    }
    try {
      workerResult = await runWorkerWithTracking(runWorker, {
        manifest,
        request,
        loop,
        workerRecord,
        prompt: actualWorkerPrompt,
        visiblePrompt: visibleUserMessage,
        userContent: directUserContent,
        agentId,
        renderer,
        abortSignal: signalController.signal,
        emitEvent: async (event) => {
          if (event.rawLine && workerRecord.stdoutFile) {
            await appendJsonlRedacted(manifest, workerRecord.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
          }
          if (event.source === 'worker-stderr' && workerRecord.stderrFile) {
            await appendJsonlRedacted(manifest, workerRecord.stderrFile, { text: event.text });
          }
          activityLog.feed(event.parsed);
          await emitEvent(manifest, event, renderer, options.onEvent);
          await appendBackendTranscriptEvent(manifest, event, {
            sessionKey: workerMeta.sessionKey,
            backend: workerMeta.backend,
            requestId: request.id,
            loopIndex: loop.index,
            agentId: workerMeta.agentId,
            workerCli: workerMeta.workerCli,
          });
        },
      });
      activityLog.finish();
    } finally {
      if (typeof options.onWorkerEnd === 'function') {
        await options.onWorkerEnd(agentId);
      }
    }

    if (workerMeta.workerCli !== 'api') {
      await appendTranscript(manifest, {
        kind: 'assistant_message',
        sessionKey: workerMeta.sessionKey,
        backend: workerMeta.backend,
        requestId: request.id,
        loopIndex: loop.index,
        agentId: workerMeta.agentId,
        workerCli: workerMeta.workerCli,
        text: workerResult.resultText,
        payload: { role: 'assistant', content: workerResult.resultText },
      });
    }
    syncDirectWorkerChatCursor(manifest, agentId);
    await emitEvent(
      manifest,
      {
        ts: nowIso(),
        source: 'worker-result',
        requestId: request.id,
        loopIndex: loop.index,
        exitCode: workerResult.exitCode,
        text: workerResult.resultText,
      },
      renderer,
      options.onEvent,
    );

    request.status = 'stopped';
    request.stopReason = 'Direct worker turn completed.';
    request.finishedAt = nowIso();
    loop.finishedAt = nowIso();
    manifest.status = 'idle';
    manifest.phase = 'idle';
    manifest.stopReason = request.stopReason;
    manifest.activeRequestId = null;
    manifest.transcriptSummary = truncate(workerResult.resultText || request.userMessage || visibleUserMessage, 120);
    await emitFinalQaReport(manifest, request, renderer);
    await saveManifest(manifest);
    return manifest;
  } catch (error) {
    const message = summarizeError(error);
    markInterrupted(manifest, request, message);
    await emitEvent(
      manifest,
      { ts: nowIso(), source: 'run-error', requestId: request ? request.id : null, text: message },
      renderer,
      options.onEvent,
    );
    await saveManifest(manifest);
    throw error;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
  }
}

/**
 * Copilot mode: User talks directly to agent, controller watches transcript and
 * sends follow-up instructions automatically.
 *
 * Flow:
 * 1. User message → agent directly (first turn)
 * 2. Controller reads transcript → decides: send more instructions or stop
 * 3. If delegate → controller's message sent to agent (prefixed "Controller: ")
 * 4. Loop steps 2-3 until controller stops or user interrupts
 *
 * @param {object} manifest
 * @param {object} renderer
 * @param {object} options — { userMessage, agentId, abortSignal, singlePass }
 */
async function runCopilotLoop(manifest, renderer, options = {}) {
  const { userMessage, agentId, singlePass } = options;

  // Set up signal handling
  const signalController = new AbortController();
  const onSigInt = () => signalController.abort();
  const onSigTerm = () => signalController.abort();
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  if (options.abortSignal) {
    options.abortSignal.addEventListener('abort', () => signalController.abort(), { once: true });
  }

  try {
    // Step 1: Run user's message as direct agent turn
    if (userMessage) {
      const prefixedMessage = 'User: ' + userMessage;
      manifest = await runDirectWorkerTurn(manifest, renderer, {
        userMessage: prefixedMessage,
        agentId,
        abortSignal: signalController.signal,
      });
      // runDirectWorkerTurn sets status to 'idle' — set back to 'running' for copilot loop
      manifest.status = 'running';
      manifest.phase = 'idle';
      await saveManifest(manifest);
    }

    if (signalController.signal.aborted) return manifest;

    // Step 2-4: Controller watches and sends follow-ups
    while (!signalController.signal.aborted) {
      // Create a new request for the controller turn
      const started = manifest.requests[manifest.requests.length - 1]
        ? null
        : await startUserRequest(manifest, renderer, '[copilot-auto]');
      const request = manifest.requests[manifest.requests.length - 1] || (started && started.request);
      const loop = await createLoopRecord(manifest, request);
      await saveManifest(manifest);

      // Run controller turn — controller reads transcript and decides
      const runControllerTurn = getControllerRunner(manifest);
      const controllerBackend = transcriptBackend('controller', manifest.controller.cli || 'codex');
      const controllerResult = await runControllerTurn({
        manifest, request, loop, renderer,
        abortSignal: signalController.signal,
        emitEvent: async (event) => {
          if (event.rawLine && loop.controller.stdoutFile) {
            await appendJsonlRedacted(manifest, loop.controller.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
          }
          if (event.source === 'controller-stderr' && loop.controller.stderrFile) {
            await appendJsonlRedacted(manifest, loop.controller.stderrFile, { text: event.text });
          }
          await emitEvent(manifest, event, renderer, options.onEvent);
          await appendBackendTranscriptEvent(manifest, event, {
            sessionKey: controllerSessionKey(),
            backend: controllerBackend,
            requestId: request.id,
            loopIndex: loop.index,
            controllerCli: manifest.controller.cli || 'codex',
          });
        },
      });

      loop.controller.decision = controllerResult.decision;
      request.latestControllerDecision = controllerResult.decision;

      // Show controller messages
      for (const message of controllerResult.decision.controller_messages) {
        renderer.controller(message);
        await appendTranscript(manifest, {
          kind: 'controller_message',
          sessionKey: controllerSessionKey(),
          backend: controllerBackend,
          text: message,
          controllerCli: manifest.controller.cli || 'codex',
          requestId: request.id, loopIndex: loop.index,
        });
        await emitEvent(manifest, { ts: nowIso(), source: 'controller-message', requestId: request.id, loopIndex: loop.index, text: message }, renderer, options.onEvent);
      }

      for (const line of controllerResult.decision.progress_updates || []) {
        await appendProgress(manifest, line, renderer);
        await emitEvent(
          manifest,
          { ts: nowIso(), source: 'progress-update', requestId: request.id, loopIndex: loop.index, text: line },
          renderer,
          options.onEvent,
        );
      }

      // Decision: stop or delegate
      if (controllerResult.decision.action === 'stop') {
        request.status = 'stopped';
        request.stopReason = controllerResult.decision.stop_reason || 'Copilot auto-pass stopped.';
        request.finishedAt = nowIso();
        loop.finishedAt = nowIso();
        manifest.status = 'idle';
        manifest.phase = 'idle';
        manifest.stopReason = request.stopReason;
        manifest.activeRequestId = null;
        await appendTranscript(manifest, {
          kind: 'controller_message',
          sessionKey: controllerSessionKey(),
          backend: controllerBackend,
          text: '[STOP]',
          controllerCli: manifest.controller.cli || 'codex',
          requestId: request.id,
          loopIndex: loop.index,
        });
        syncControllerTranscriptCursor(manifest);
        await emitFinalQaReport(manifest, request, renderer);
        await saveManifest(manifest);
        renderer.stop(controllerResult.decision.stop_reason || 'Copilot stopped.');
        return manifest;
      }

      // Delegate: send controller's message to the agent
      const delegateAgentId = controllerResult.decision.agent_id || agentId || null;
      const delegateMessage = 'Controller: ' + (controllerResult.decision.claude_message || '');
      const workerRecord = attachWorkerRecord(manifest, loop);
      manifest.phase = 'worker';
      await saveManifest(manifest);

      const delegateAgentConfig = delegateAgentId && delegateAgentId !== 'default'
        ? lookupAgentConfig(manifest.agents, delegateAgentId) : null;
      const workerMeta = workerTranscriptMeta(manifest, delegateAgentId);
      const runWorker = getWorkerRunner(manifest, delegateAgentConfig);

      renderer.launchClaude(delegateMessage, true, delegateAgentId, (delegateAgentConfig && delegateAgentConfig.cli) || manifest.worker.cli, delegateAgentConfig ? delegateAgentConfig.name : null);
      await appendTranscript(manifest, {
        kind: 'launch',
        sessionKey: controllerSessionKey(),
        backend: controllerBackend,
        requestId: request.id,
        loopIndex: loop.index,
        controllerCli: manifest.controller.cli || 'codex',
        agentId: workerMeta.agentId,
        text: buildLaunchText(delegateMessage, true, delegateAgentId, workerMeta.workerCli, workerMeta.agentName),
      });
      await appendTranscript(manifest, {
        kind: 'user_message',
        sessionKey: workerMeta.sessionKey,
        backend: 'user',
        requestId: request.id,
        loopIndex: loop.index,
        agentId: workerMeta.agentId,
        workerCli: workerMeta.workerCli,
        text: delegateMessage,
        payload: { role: 'user', content: delegateMessage },
        display: false,
      });
      syncControllerTranscriptCursor(manifest);

      let workerResult;
      if (typeof options.onWorkerStart === 'function') {
        await options.onWorkerStart(delegateAgentId);
      }
      try {
        workerResult = await runWorkerWithTracking(runWorker, {
          manifest, request, loop, workerRecord,
          prompt: delegateMessage,
          agentId: delegateAgentId,
          renderer,
          abortSignal: signalController.signal,
          emitEvent: async (event) => {
            if (event.rawLine && workerRecord.stdoutFile) await appendJsonlRedacted(manifest, workerRecord.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
            if (event.source === 'worker-stderr' && workerRecord.stderrFile) await appendJsonlRedacted(manifest, workerRecord.stderrFile, { text: event.text });
            await emitEvent(manifest, event, renderer, options.onEvent);
            await appendBackendTranscriptEvent(manifest, event, {
              sessionKey: workerMeta.sessionKey,
              backend: workerMeta.backend,
              requestId: request.id,
              loopIndex: loop.index,
              agentId: workerMeta.agentId,
              workerCli: workerMeta.workerCli,
            });
          },
        });
      } finally {
        if (typeof options.onWorkerEnd === 'function') {
          await options.onWorkerEnd(delegateAgentId);
        }
      }

      if (workerMeta.workerCli !== 'api') {
        await appendTranscript(manifest, {
          kind: 'assistant_message',
          sessionKey: workerMeta.sessionKey,
          backend: workerMeta.backend,
          requestId: request.id,
          loopIndex: loop.index,
          agentId: workerMeta.agentId,
          workerCli: workerMeta.workerCli,
          text: workerResult.resultText,
          payload: { role: 'assistant', content: workerResult.resultText },
        });
      }

      request.latestWorkerResult = workerResult;
      loop.finishedAt = nowIso();
      manifest.transcriptSummary = truncate(workerResult.resultText || delegateMessage, 120);
      manifest.updatedAt = nowIso();
      await saveManifest(manifest);

      // singlePass: return after one controller→agent cycle (for wait delay scheduling)
      if (singlePass) return manifest;
    }

    return manifest;
  } catch (error) {
    const message = summarizeError(error);
    const request = manifest.requests && manifest.requests[manifest.requests.length - 1];
    if (request) markInterrupted(manifest, request, message);
    await emitEvent(manifest, { ts: nowIso(), source: 'run-error', requestId: request ? request.id : null, text: message }, renderer, options.onEvent);
    await saveManifest(manifest);
    throw error;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    // Clean up app-server connections when the run ends
    if (manifest.controller.codexMode === 'app-server') {
      closeConnection(manifest.runId).catch(() => {});
    }
  }
}

module.exports = {
  compactBackendTranscriptPayload,
  printEventTail,
  printRunSummary,
  runCopilotLoop,
  runDirectWorkerTurn,
  runManagerLoop,
};
