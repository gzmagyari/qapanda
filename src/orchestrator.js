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
const {
  appendTranscriptRecord,
  countTranscriptLinesSync,
  createTranscriptRecord,
  controllerSessionKey,
  transcriptBackend,
  workerSessionKey,
} = require('./transcript');

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

async function appendProgress(manifest, line, renderer) {
  if (!manifest.files || !manifest.files.progress) return;
  const entry = `[${progressTimestamp()}] ${line}\n`;
  try {
    await appendText(manifest.files.progress, entry);
  } catch {
    // Non-critical — don't break the run
  }
  if (renderer && typeof renderer.progress === 'function') {
    renderer.progress(entry.trimEnd());
  }
}

async function emitEvent(manifest, event, renderer) {
  await appendJsonl(manifest.files.events, event);
  if (renderer && event.source === 'shell' && event.text) {
    renderer.shell(event.text);
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
    payload,
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
  const request = createRequest(manifest, userMessage);
  manifest.status = 'running';
  manifest.phase = options.phase || 'controller';
  manifest.stopReason = null;
  manifest.error = null;

  if (options.render !== false) {
    renderer.user(userMessage);
  }
  await appendTranscript(manifest, {
    kind: 'user_message',
    sessionKey: options.sessionKey || controllerSessionKey(),
    backend: options.backend || 'user',
    requestId: request.id,
    loopIndex: options.loopIndex == null ? null : options.loopIndex,
    agentId: options.agentId || null,
    workerCli: options.workerCli || null,
    text: userMessage,
    payload: { role: 'user', content: userMessage },
    display: options.display !== false,
  });
  await emitEvent(
    manifest,
    { ts: nowIso(), source: 'user-message', requestId: request.id, text: userMessage },
    renderer,
  );
  await saveManifest(manifest);
  return request;
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
  if (options.controllerLabel) {
    renderer.controllerLabel = options.controllerLabel;
  } else {
    setControllerLabel(renderer, manifest);
  }
  setWorkerLabel(renderer, manifest);
  const userMessage = options.userMessage == null ? null : String(options.userMessage).trim();
  let request = null;

  if (userMessage) {
    request = await startUserRequest(manifest, renderer, userMessage);
  } else {
    request = getRunnableRequest(manifest);
    if (!request) {
      throw new Error('There is no active interrupted request to continue. Send a new message instead.');
    }
    manifest.status = 'running';
    manifest.phase = 'controller';
    manifest.error = null;
    await saveManifest(manifest);
  }

  const signalController = new AbortController();
  const onSignal = (signal) => {
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

      const runControllerTurn = getControllerRunner(manifest);
      const controllerBackend = transcriptBackend('controller', manifest.controller.cli || 'codex');
      const controllerResult = await runControllerTurn({
        manifest,
        request,
        loop,
        renderer,
        abortSignal: signalController.signal,
        emitEvent: async (event) => {
          if (event.rawLine && loop.controller.stdoutFile) {
            await appendJsonl(loop.controller.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
          }
          if (event.source === 'controller-stderr' && loop.controller.stderrFile) {
            await appendJsonl(loop.controller.stderrFile, { text: event.text });
          }
          await emitEvent(manifest, event, renderer);
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
        );
        await saveManifest(manifest);
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
      );

      const runWorker = getWorkerRunner(manifest, delegateAgentConfig);
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
              await appendJsonl(workerRecord.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
            }
            if (event.source === 'worker-stderr' && workerRecord.stderrFile) {
              await appendJsonl(workerRecord.stderrFile, { text: event.text });
            }
            activityLog.feed(event.parsed);
            await emitEvent(manifest, event, renderer);
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
      );

      loop.finishedAt = nowIso();
      manifest.phase = 'controller';
      manifest.transcriptSummary = truncate(workerResult.resultText || request.userMessage, 120);
      await saveManifest(manifest);

      // In singlePass mode, return after one controller→worker cycle
      // Caller checks manifest.status === 'running' to know more work is pending
      if (options.singlePass) {
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
    );
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
  const userMessage = options.userMessage == null ? null : String(options.userMessage).trim();
  if (!userMessage) throw new Error('No message provided for direct worker turn.');

  const agentId = options.agentId || null;
  const agentConfig = agentId ? lookupAgentConfig(manifest.agents, agentId) : null;
  const workerMeta = workerTranscriptMeta(manifest, agentId);

  let request;
  if (options.isDelegation) {
    // Agent-to-agent delegation: create request record and show launch message with "Agent delegation" label
    request = createRequest(manifest, userMessage);
    manifest.status = 'running';
    manifest.phase = 'controller';
    manifest.stopReason = null;
    manifest.error = null;
    const agentCli = (agentConfig && agentConfig.cli) || manifest.worker.cli || 'codex';
    const agentName = agentConfig ? agentConfig.name : null;
    const sameSession = agentId && agentId !== 'default'
      ? !!((manifest.worker.agentSessions || {})[agentId] || {}).hasStarted
      : manifest.worker.hasStarted;
    renderer.launchClaude(userMessage, sameSession, agentId, agentCli, agentName, 'Agent delegation');
    await appendTranscript(manifest, {
      kind: 'delegation',
      sessionKey: controllerSessionKey(),
      backend: transcriptBackend('controller', manifest.controller.cli || 'codex'),
      requestId: request.id,
      agentId: workerMeta.agentId,
      text: buildLaunchText(userMessage, sameSession, agentId, agentCli, agentName),
      labelHint: 'Agent delegation',
      controllerCli: manifest.controller.cli || 'codex',
    });
    await appendTranscript(manifest, {
      kind: 'user_message',
      sessionKey: workerMeta.sessionKey,
      backend: 'user',
      requestId: request.id,
      agentId: workerMeta.agentId,
      workerCli: workerMeta.workerCli,
      text: userMessage,
      payload: { role: 'user', content: userMessage },
      display: false,
    });
    await emitEvent(manifest, { ts: nowIso(), source: 'delegation', requestId: request.id, text: userMessage, agentId }, renderer);
    await saveManifest(manifest);
  } else {
    request = await startUserRequest(manifest, renderer, userMessage, {
      phase: 'worker',
      sessionKey: workerMeta.sessionKey,
      agentId: workerMeta.agentId,
      workerCli: workerMeta.workerCli,
    });
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
        sameSession: manifest.worker.hasStarted,
        prompt: userMessage,
      },
      renderer,
    );

    const runWorker = getWorkerRunner(manifest, agentConfig);
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
        prompt: userMessage,
        agentId,
        renderer,
        abortSignal: signalController.signal,
        emitEvent: async (event) => {
          if (event.rawLine && workerRecord.stdoutFile) {
            await appendJsonl(workerRecord.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
          }
          if (event.source === 'worker-stderr' && workerRecord.stderrFile) {
            await appendJsonl(workerRecord.stderrFile, { text: event.text });
          }
          activityLog.feed(event.parsed);
          await emitEvent(manifest, event, renderer);
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
    );

    request.status = 'stopped';
    request.stopReason = 'Direct worker turn completed.';
    request.finishedAt = nowIso();
    loop.finishedAt = nowIso();
    manifest.status = 'idle';
    manifest.phase = 'idle';
    manifest.stopReason = request.stopReason;
    manifest.activeRequestId = null;
    manifest.transcriptSummary = truncate(workerResult.resultText || userMessage, 120);
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
      const request = manifest.requests[manifest.requests.length - 1] || await startUserRequest(manifest, renderer, '[copilot-auto]');
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
            await appendJsonl(loop.controller.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
          }
          if (event.source === 'controller-stderr' && loop.controller.stderrFile) {
            await appendJsonl(loop.controller.stderrFile, { text: event.text });
          }
          await emitEvent(manifest, event, renderer);
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
        await emitEvent(manifest, { ts: nowIso(), source: 'controller-message', requestId: request.id, loopIndex: loop.index, text: message }, renderer);
      }

      for (const line of controllerResult.decision.progress_updates || []) {
        await appendProgress(manifest, line, renderer);
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
            if (event.rawLine && workerRecord.stdoutFile) await appendJsonl(workerRecord.stdoutFile, { line: event.rawLine, parsed: event.parsed || null });
            if (event.source === 'worker-stderr' && workerRecord.stderrFile) await appendJsonl(workerRecord.stderrFile, { text: event.text });
            await emitEvent(manifest, event, renderer);
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
    await emitEvent(manifest, { ts: nowIso(), source: 'run-error', requestId: request ? request.id : null, text: message }, renderer);
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
  printEventTail,
  printRunSummary,
  runCopilotLoop,
  runDirectWorkerTurn,
  runManagerLoop,
};
