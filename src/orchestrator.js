const { appendJsonl, appendText, nowIso, readText, summarizeError, truncate } = require('./utils');
const { attachWorkerRecord, createLoopRecord, createRequest, getActiveRequest, lookupAgentConfig, saveManifest } = require('./state');
const { runControllerTurn: runCodexControllerTurn } = require('./codex');
const { runClaudeControllerTurn } = require('./claude-controller');
const { runWorkerTurn } = require('./claude');
const { runCodexWorkerTurn } = require('./codex-worker');
const { controllerLabelFor, workerLabelFor } = require('./render');

function getControllerRunner(manifest) {
  if (manifest.controller.cli === 'claude') return runClaudeControllerTurn;
  return runCodexControllerTurn;
}

function getWorkerRunner(manifest, agentConfig) {
  const cli = (agentConfig && agentConfig.cli) || manifest.worker.cli || 'claude';
  if (cli === 'codex' || cli === 'qa-remote-codex') return runCodexWorkerTurn;
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

async function appendTranscript(manifest, entry) {
  await appendJsonl(manifest.files.transcript, entry);
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

async function startUserRequest(manifest, renderer, userMessage) {
  const request = createRequest(manifest, userMessage);
  manifest.status = 'running';
  manifest.phase = 'controller';
  manifest.stopReason = null;
  manifest.error = null;

  renderer.user(userMessage);
  await appendTranscript(manifest, { ts: nowIso(), role: 'user', text: userMessage, requestId: request.id });
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
  setControllerLabel(renderer, manifest);
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
        },
      });

      loop.controller.decision = controllerResult.decision;
      request.latestControllerDecision = controllerResult.decision;

      for (const message of controllerResult.decision.controller_messages) {
        renderer.controller(message);
        await appendTranscript(manifest, {
          ts: nowIso(),
          role: 'controller',
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
        await appendProgress(manifest, truncate(line, 120), renderer);
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
        renderer.stop();
        await appendTranscript(manifest, {
          ts: nowIso(),
          role: 'controller',
          text: '[STOP]',
          controllerCli: manifest.controller.cli || 'codex',
          requestId: request.id,
          loopIndex: loop.index,
        });
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
      const delegateCli = (delegateAgentConfig && delegateAgentConfig.cli) || manifest.worker.cli || 'claude';
      const workerSameSession = delegateAgentId && delegateAgentId !== 'default'
        ? !!((manifest.worker.agentSessions || {})[delegateAgentId] || {}).hasStarted
        : manifest.worker.hasStarted;
      renderer.launchClaude(controllerResult.decision.claude_message, workerSameSession, delegateAgentId, delegateCli);
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
      const workerResult = await runWorker({
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
          await emitEvent(manifest, event, renderer);
        },
      });

      await appendTranscript(manifest, {
        ts: nowIso(),
        role: 'claude',
        text: workerResult.resultText,
        requestId: request.id,
        loopIndex: loop.index,
      });
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

  const request = await startUserRequest(manifest, renderer, userMessage);

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

    const agentId = options.agentId || null;
    const agentConfig = agentId ? lookupAgentConfig(manifest.agents, agentId) : null;
    const runWorker = getWorkerRunner(manifest, agentConfig);

    const workerResult = await runWorker({
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
        await emitEvent(manifest, event, renderer);
      },
    });

    await appendTranscript(manifest, {
      ts: nowIso(),
      role: 'claude',
      text: workerResult.resultText,
      requestId: request.id,
      loopIndex: loop.index,
    });
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

module.exports = {
  printEventTail,
  printRunSummary,
  runDirectWorkerTurn,
  runManagerLoop,
};
