const { compactApiSessionHistory, currentApiSessionTarget, describeCompactionResult } = require('./api-compaction');
const { getOrCreateConnection } = require('./codex-app-server');
const { appendWizardDebug, summarizeForDebug } = require('./debug-log');
const { parseJsonLine, extractTextFromClaudeContent } = require('./events');
const { spawnStreamingProcess } = require('./process-utils');
const { lookupAgentConfig } = require('./state');
const { buildClaudeArgs } = require('./claude');
const { buildClaudeControllerArgs } = require('./claude-controller');
const { isClaudeCliCommand, sanitizeClaudeSessionImagesForResume } = require('./claude-session-sanitizer');

const DEFAULT_COMPACTION_STATUS_TEXT = 'Compacting chat context...';
const DEFAULT_NO_SESSION_MESSAGE = 'No current session to compact for this target.';
const DEFAULT_CODEX_EXEC_MESSAGE =
  'Manual compact is not supported by the current Codex exec backend. Use Codex app-server or wait for auto-compaction.';
const DEFAULT_UNSUPPORTED_MESSAGE = 'Manual compact is not supported for the current backend.';
const CODEX_APP_SERVER_COMPACT_TIMEOUT_MS = 180_000;

function compactDebug(repoRoot, msg, extra = null) {
  const payload = extra == null ? msg : `${msg} ${summarizeForDebug(extra)}`;
  appendWizardDebug('session-compaction', payload, { repoRoot: repoRoot || process.cwd() });
}

function currentWorkerTarget(chatTarget) {
  if (!chatTarget || chatTarget === 'controller') return null;
  if (chatTarget === 'claude') return { target: 'worker-default', agentId: null };
  if (String(chatTarget).startsWith('agent-')) {
    return { target: 'worker-agent', agentId: String(chatTarget).slice('agent-'.length) };
  }
  return { target: 'worker-default', agentId: null };
}

function labelForTarget(chatTarget) {
  return !chatTarget || chatTarget === 'controller'
    ? 'Controller session'
    : 'Current agent session';
}

function buildWorkerCodexConnManifest(manifest, agentId, agentConfig) {
  const workerBin = (agentConfig && agentConfig.bin) || manifest.worker.bin || 'codex';
  const baseMcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
  const agentMcps = (agentConfig && agentConfig.mcps) || {};
  const workerMcpServers = { ...baseMcpServers, ...agentMcps };
  return {
    runId: `${manifest.runId}-worker-${agentId || 'default'}`,
    panelId: manifest.panelId || null,
    repoRoot: manifest.repoRoot,
    chromeDebugPort: manifest.chromeDebugPort,
    extensionDir: manifest.extensionDir,
    importSource: manifest.importSource || null,
    prestartKeys: manifest.workerPrestartKey ? [manifest.workerPrestartKey] : [],
    controllerMcpServers: workerMcpServers,
    controller: {
      bin: workerBin,
      model: (agentConfig && agentConfig.model) || manifest.worker.model,
    },
  };
}

function resolveCurrentCompactionTarget({
  manifest,
  chatTarget = 'controller',
  controllerCli = null,
  workerCli = null,
}) {
  if (!manifest) return null;

  const label = labelForTarget(chatTarget);
  if (!chatTarget || chatTarget === 'controller') {
    const cli = controllerCli || (manifest.controller && manifest.controller.cli) || 'codex';
    if (cli === 'api') {
      const apiTarget = currentApiSessionTarget({
        manifest,
        target: 'controller',
        controllerCli,
        workerCli,
      });
      return apiTarget ? { kind: 'api', label, apiTarget } : null;
    }
    if (cli === 'claude') {
      return {
        kind: 'claude',
        scope: 'controller',
        label,
        bin: (manifest.controller && manifest.controller.bin) || 'claude',
        sessionId: manifest.controller && manifest.controller.sessionId || null,
      };
    }
    if (cli === 'codex') {
      const codexMode = (manifest.controller && manifest.controller.codexMode) || 'app-server';
      if (codexMode === 'app-server') {
        return {
          kind: 'codex-app-server',
          scope: 'controller',
          label,
          threadId: (manifest.controller && (manifest.controller.appServerThreadId || manifest.controller.sessionId)) || null,
          connManifest: manifest,
        };
      }
      return { kind: 'unsupported-codex-exec', label, message: DEFAULT_CODEX_EXEC_MESSAGE };
    }
    return { kind: 'unsupported', label, message: DEFAULT_UNSUPPORTED_MESSAGE };
  }

  const workerTarget = currentWorkerTarget(chatTarget);
  if (!workerTarget) return null;
  const agentId = workerTarget.agentId;
  const agentConfig = agentId && manifest.agents ? lookupAgentConfig(manifest.agents, agentId) : null;
  const cli = (agentConfig && agentConfig.cli) || workerCli || (manifest.worker && manifest.worker.cli) || 'codex';

  if (cli === 'api') {
    const apiTarget = currentApiSessionTarget({
      manifest,
      target: workerTarget.target,
      directAgent: agentId,
      workerCli,
    });
    return apiTarget ? { kind: 'api', label, apiTarget } : null;
  }

  if (cli === 'claude') {
    const workerSession = agentId
      ? (manifest.worker && manifest.worker.agentSessions && manifest.worker.agentSessions[agentId]) || null
      : (manifest.worker || null);
    return {
      kind: 'claude',
      scope: 'worker',
      label,
      agentId,
      agentConfig,
      agentSession: workerSession,
      bin: (agentConfig && agentConfig.bin) || (manifest.worker && manifest.worker.bin) || 'claude',
      sessionId: workerSession && workerSession.sessionId || null,
      hasStarted: !!(workerSession && workerSession.hasStarted),
    };
  }

  if (cli === 'codex') {
    const codexMode = (agentConfig && agentConfig.codexMode)
      || (manifest.worker && manifest.worker.codexMode)
      || 'app-server';
    if (codexMode === 'app-server') {
      const sessionKey = agentId || 'default';
      const workerSession = manifest.worker && manifest.worker.agentSessions
        ? (manifest.worker.agentSessions[sessionKey] || null)
        : null;
      return {
        kind: 'codex-app-server',
        scope: 'worker',
        label,
        agentId,
        threadId: workerSession && (workerSession.appServerThreadId || workerSession.sessionId) || null,
        connManifest: buildWorkerCodexConnManifest(manifest, agentId, agentConfig),
      };
    }
    return { kind: 'unsupported-codex-exec', label, message: DEFAULT_CODEX_EXEC_MESSAGE };
  }

  return { kind: 'unsupported', label, message: DEFAULT_UNSUPPORTED_MESSAGE };
}

function extractClaudeResultText(raw) {
  if (!raw || typeof raw !== 'object') return '';
  if (typeof raw.result === 'string') return raw.result;
  if (typeof raw.result?.text === 'string') return raw.result.text;
  return extractTextFromClaudeContent(raw.message?.content || raw.content);
}

async function sanitizeClaudeResumeImagesIfNeeded(manifest, bin, sessionId) {
  if (!sessionId || !isClaudeCliCommand(bin)) return;
  try {
    await sanitizeClaudeSessionImagesForResume({
      repoRoot: manifest.repoRoot,
      sessionId,
      maxDimension: 2000,
    });
  } catch (error) {
    compactDebug(manifest.repoRoot, 'claude:compact:sanitize-failed', {
      sessionId,
      message: error && error.message ? error.message : String(error),
    });
  }
}

async function compactClaudeTarget(manifest, targetInfo) {
  const label = targetInfo.label || 'Current session';
  if (targetInfo.scope === 'controller') {
    if (!targetInfo.sessionId) return { performed: false, message: DEFAULT_NO_SESSION_MESSAGE };
  } else if (!targetInfo.hasStarted || !targetInfo.sessionId) {
    return { performed: false, message: DEFAULT_NO_SESSION_MESSAGE };
  }

  const bin = targetInfo.scope === 'controller'
    ? ((manifest.controller && manifest.controller.bin) || 'claude')
    : ((targetInfo.agentConfig && targetInfo.agentConfig.bin) || (manifest.worker && manifest.worker.bin) || 'claude');
  await sanitizeClaudeResumeImagesIfNeeded(manifest, bin, targetInfo.sessionId);

  const args = targetInfo.scope === 'controller'
    ? buildClaudeControllerArgs(manifest, null, { includeJsonSchema: false })
    : buildClaudeArgs(manifest, {
        agentConfig: targetInfo.agentConfig || null,
        agentSession: targetInfo.agentSession || null,
      });

  const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;
  let discoveredSessionId = targetInfo.sessionId;
  let finalText = '';
  const result = await spawnStreamingProcess({
    command: bin,
    args,
    cwd: manifest.repoRoot,
    env: cleanEnv,
    stdinText: '/compact',
    resolveOnResult: true,
    onStdoutLine: (line) => {
      const raw = parseJsonLine(line);
      if (!raw) return;
      if (raw.session_id) discoveredSessionId = raw.session_id;
      if (raw.type === 'assistant_message' || raw.type === 'assistant' || raw.type === 'result_message' || raw.type === 'result') {
        const text = extractClaudeResultText(raw);
        if (text) finalText = text;
      }
    },
  });

  if (result.aborted) throw new Error('Claude compaction was interrupted.');
  if (result.code !== 0) throw new Error(`Claude compaction exited with code ${result.code}.`);

  if (targetInfo.scope === 'controller' && discoveredSessionId) {
    manifest.controller.sessionId = discoveredSessionId;
  } else if (targetInfo.agentSession && discoveredSessionId) {
    targetInfo.agentSession.sessionId = discoveredSessionId;
    targetInfo.agentSession.hasStarted = true;
  }

  compactDebug(manifest.repoRoot, 'claude:compact:done', {
    scope: targetInfo.scope,
    agentId: targetInfo.agentId || null,
    sessionId: discoveredSessionId || null,
    finalText: finalText || null,
  });
  return { performed: true, message: `${label} compaction completed.` };
}

async function compactCodexAppServerTarget(manifest, targetInfo) {
  if (!targetInfo.threadId) {
    return { performed: false, message: DEFAULT_NO_SESSION_MESSAGE };
  }

  const conn = getOrCreateConnection(targetInfo.connManifest);
  await conn.ensureConnected();
  await conn.resumeThread(targetInfo.threadId);
  compactDebug(manifest.repoRoot, 'codex-appserver:compact:start', {
    scope: targetInfo.scope,
    agentId: targetInfo.agentId || null,
    threadId: targetInfo.threadId,
  });

  return await new Promise(async (resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Codex compaction timed out after ${CODEX_APP_SERVER_COMPACT_TIMEOUT_MS}ms.`));
    }, CODEX_APP_SERVER_COMPACT_TIMEOUT_MS);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      conn.onNotification(null);
    };

    conn.onNotification((notification) => {
      const params = (notification && notification.params) || {};
      const threadId = params.threadId || null;
      if (threadId && threadId !== targetInfo.threadId) return;
      if (notification && (notification.method === 'thread/compacted' || notification.method === 'codex/event/context_compacted')) {
        cleanup();
        compactDebug(manifest.repoRoot, 'codex-appserver:compact:done', {
          scope: targetInfo.scope,
          agentId: targetInfo.agentId || null,
          threadId: targetInfo.threadId,
        });
        resolve({
          performed: true,
          message: `${targetInfo.label || 'Current session'} compaction completed.`,
        });
        return;
      }
      if (notification && notification.method === 'error') {
        cleanup();
        reject(new Error((params && params.message) || 'Codex app-server compaction failed.'));
      }
    });

    try {
      await conn.compactThread(targetInfo.threadId);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function compactCurrentSession({
  manifest,
  chatTarget = 'controller',
  controllerCli = null,
  workerCli = null,
  requestId = null,
  loopIndex = null,
  renderer = null,
}) {
  const targetInfo = resolveCurrentCompactionTarget({
    manifest,
    chatTarget,
    controllerCli,
    workerCli,
  });
  if (!targetInfo) {
    return { performed: false, message: DEFAULT_NO_SESSION_MESSAGE };
  }

  compactDebug(manifest && manifest.repoRoot, 'compact:dispatch', {
    chatTarget,
    requestId,
    loopIndex,
    kind: targetInfo.kind,
    scope: targetInfo.scope || null,
    agentId: targetInfo.agentId || null,
    threadId: targetInfo.threadId || null,
    sessionId: targetInfo.sessionId || null,
  });

  if (targetInfo.kind === 'api') {
    const result = await compactApiSessionHistory({
      manifest,
      sessionKey: targetInfo.apiTarget.sessionKey,
      backend: targetInfo.apiTarget.backend,
      requestId,
      loopIndex,
      provider: targetInfo.apiTarget.provider,
      baseURL: targetInfo.apiTarget.baseURL,
      model: targetInfo.apiTarget.model,
      thinking: targetInfo.apiTarget.thinking,
      force: true,
      renderer,
    });
    return {
      performed: !!result && !!result.performed,
      message: describeCompactionResult(result, targetInfo.label),
      result,
    };
  }
  if (targetInfo.kind === 'claude') {
    return compactClaudeTarget(manifest, targetInfo);
  }
  if (targetInfo.kind === 'codex-app-server') {
    return compactCodexAppServerTarget(manifest, targetInfo);
  }
  if (targetInfo.kind === 'unsupported-codex-exec' || targetInfo.kind === 'unsupported') {
    return { performed: false, message: targetInfo.message || DEFAULT_UNSUPPORTED_MESSAGE };
  }
  return { performed: false, message: DEFAULT_UNSUPPORTED_MESSAGE };
}

module.exports = {
  DEFAULT_COMPACTION_STATUS_TEXT,
  compactCurrentSession,
  resolveCurrentCompactionTarget,
};
