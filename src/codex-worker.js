const crypto = require('node:crypto');
const { readText, writeText, writeJson } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, summarizeCodexWorkerEvent, mapAppServerNotification } = require('./events');
const { buildAgentWorkerSystemPrompt } = require('./prompts');
const { buildPromptsDirs } = require('./prompt-tags');
const { workerLabelFor } = require('./render');
const { isRemoteCli, resolveRemoteCommand, ensureDesktop, cancelRemoteRun } = require('./remote-desktop');
const { lookupAgentConfig } = require('./state');
const { getOrCreateConnection } = require('./codex-app-server');
const { MCP_STARTUP_TIMEOUT_SEC, mcpToolTimeoutSec } = require('./mcp-timeouts');
const { redactHostedWorkflowValue } = require('./cloud/workflow-hosted-runs');
const { getImportedCodexSessionId, isCodexCliBackend } = require('./external-chat-import');
const { buildIsolatedCodexEnv } = require('./codex-home');

/**
 * Build args for Codex used as a worker backend.
 * Mirrors src/codex.js buildCodexArgs but adapted for worker role:
 * - No --output-schema (worker doesn't validate against a schema)
 * - No --profile (worker uses base Codex defaults)
 * - MCP config via -c TOML (same pattern as controller)
 * - System prompt is prepended to stdinText (Codex reads from stdin via '-')
 */
function buildCodexWorkerArgs(manifest, workerRecord, { agentConfig, agentSession }) {
  const args = ['exec'];
  const isResume = agentSession ? agentSession.hasStarted : manifest.worker.hasStarted;
  const sessionId = agentSession ? agentSession.sessionId : manifest.worker.sessionId;

  if (isResume) {
    args.push('resume', sessionId);
  } else {
    args.push(
      '--cd',
      manifest.repoRoot,
      '--color',
      'never',
    );
  }

  args.push(
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--output-last-message',
    workerRecord.finalFile,
  );

  const model = (agentConfig && agentConfig.model) || manifest.worker.model;
  if (model) {
    args.push('--model', model);
  }

  const thinking = agentConfig && agentConfig.thinking;
  if (thinking) {
    args.push('-c', `model_reasoning_effort="${thinking}"`);
  }

  // Pass MCP servers via -c config overrides (merge agent-specific on top of base worker MCPs)
  const tomlEsc = (s) => s.replace(/\\/g, '\\\\');
  const baseMcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
  const agentMcps = (agentConfig && agentConfig.mcps) || {};
  const mcpServers = { ...baseMcpServers, ...agentMcps };
  for (const [name, server] of Object.entries(mcpServers)) {
    if (!server) continue;
    // Codex uses underscores in MCP names (not hyphens)
    const codexName = name.replace(/-/g, '_');
    const toolTimeoutSec = mcpToolTimeoutSec(name);
    // HTTP MCP servers
    if (server.url) {
      args.push('-c', `mcp_servers.${codexName}.url="${tomlEsc(server.url)}"`);
      args.push('-c', `mcp_servers.${codexName}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
      if (toolTimeoutSec != null) {
        args.push('-c', `mcp_servers.${codexName}.tool_timeout_sec=${toolTimeoutSec}`);
      }
      continue;
    }
    // Stdio MCP servers
    if (!server.command) continue;
    args.push('-c', `mcp_servers.${codexName}.command="${tomlEsc(server.command)}"`);
    if (Array.isArray(server.args) && server.args.length > 0) {
      let resolvedArgs = server.args;
      if (manifest.chromeDebugPort) resolvedArgs = resolvedArgs.map(a => a.replace(/\{CHROME_DEBUG_PORT\}/g, String(manifest.chromeDebugPort)));
      if (manifest.extensionDir) resolvedArgs = resolvedArgs.map(a => a.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/')));
      if (manifest.repoRoot) resolvedArgs = resolvedArgs.map(a => a.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/')));
      const argsToml = `[${resolvedArgs.map((a) => `"${tomlEsc(a)}"`).join(', ')}]`;
      args.push('-c', `mcp_servers.${codexName}.args=${argsToml}`);
    }
    if (server.env && typeof server.env === 'object') {
      for (const [key, val] of Object.entries(server.env)) {
        let resolvedVal = val;
        if (manifest.extensionDir) resolvedVal = resolvedVal.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/'));
        if (manifest.repoRoot) resolvedVal = resolvedVal.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/'));
        args.push('-c', `mcp_servers.${codexName}.env.${key}="${tomlEsc(resolvedVal)}"`);
      }
    }
    args.push('-c', `mcp_servers.${codexName}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
    if (toolTimeoutSec != null) {
      args.push('-c', `mcp_servers.${codexName}.tool_timeout_sec=${toolTimeoutSec}`);
    }
  }

  // Disable built-in shell when detached-command MCP is available (prevents session hangs)
  if (mcpServers['detached-command']) {
    args.push('-c', 'features.shell_tool=false');
  }

  args.push('-');
  return args;
}

/**
 * Build stdin text for Codex worker.
 * Codex reads its full instructions from stdin (no --append-system-prompt flag).
 * For agents with a system_prompt, we prepend it before the actual user prompt.
 */
function buildCodexWorkerStdin(prompt, agentConfig, opts, repoRoot) {
  const systemPrompt = buildAgentWorkerSystemPrompt(
    agentConfig,
    { ...(opts || {}), repoRoot },
    buildPromptsDirs(repoRoot)
  );
  if (!systemPrompt) return prompt;
  return `${systemPrompt}\n\n---\n\n${prompt}`;
}

const DESIRED_APP_SERVER_APPROVAL_POLICY = 'never';
const DESIRED_APP_SERVER_SANDBOX = 'danger-full-access';

function sessionNeedsImportedCodexSeed(session) {
  return !!(
    session &&
    session.hasStarted !== true &&
    !session.appServerThreadId
  );
}

function seedImportedCodexWorkerThread(session, importedSessionId) {
  if (!importedSessionId || !sessionNeedsImportedCodexSeed(session)) {
    return false;
  }
  session.sessionId = importedSessionId;
  session.appServerThreadId = importedSessionId;
  session.approvalPolicy = null;
  session.threadSandbox = null;
  return true;
}

async function forkImportedCodexWorkerSession({
  manifest,
  agentConfig,
  sessionState,
  sessionKey,
  sessionLabel,
  renderer,
  connectionFactory = getOrCreateConnection,
  closeConnectionFn = null,
}) {
  const importedSessionId = getImportedCodexSessionId(manifest);
  if (!importedSessionId || !sessionNeedsImportedCodexSeed(sessionState)) {
    return null;
  }

  const tempConnectionKey = `${manifest.runId}-import-fork-${sessionKey || 'default'}`;
  const connManifest = {
    runId: tempConnectionKey,
    repoRoot: manifest.repoRoot,
    panelId: manifest.panelId || null,
    chromeDebugPort: manifest.chromeDebugPort,
    extensionDir: manifest.extensionDir,
    controllerMcpServers: null,
    controller: {
      bin: 'codex',
      model: (agentConfig && agentConfig.model) || (manifest.worker && manifest.worker.model) || null,
    },
  };

  const { closeConnection } = require('./codex-app-server');
  const conn = connectionFactory(connManifest);
  try {
    await conn.ensureConnected();
    const forkedThreadId = await conn.forkThread(importedSessionId, {
      approvalPolicy: DESIRED_APP_SERVER_APPROVAL_POLICY,
      sandbox: DESIRED_APP_SERVER_SANDBOX,
    });
    sessionState.sessionId = forkedThreadId;
    sessionState.appServerThreadId = forkedThreadId;
    sessionState.approvalPolicy = DESIRED_APP_SERVER_APPROVAL_POLICY;
    sessionState.threadSandbox = DESIRED_APP_SERVER_SANDBOX;
    sessionState.hasStarted = true;
    if (renderer && typeof renderer.banner === 'function') {
      renderer.banner(`Recovered ${sessionLabel || 'worker'} session into a writable Codex thread.`);
    }
    return forkedThreadId;
  } finally {
    const close = closeConnectionFn || closeConnection;
    await close(tempConnectionKey).catch(() => {});
  }
}

function _workerUsesChromeDevtools(mcpServers) {
  return Object.keys(mcpServers || {}).some((name) =>
    String(name).includes('chrome-devtools') || String(name).includes('chrome_devtools')
  );
}

function _recordWorkerBrowserBinding(manifest, agentSession, workerMcpServers) {
  if (!_workerUsesChromeDevtools(workerMcpServers)) return;
  const boundPort = manifest && manifest.chromeDebugPort != null
    ? Number(manifest.chromeDebugPort) || null
    : null;
  if (agentSession) {
    agentSession.boundBrowserPort = boundPort;
  }
  if (manifest && manifest.worker) {
    manifest.worker.boundBrowserPort = boundPort;
  }
}

function workerThreadNeedsRecovery(agentSession) {
  return !!(
    agentSession &&
    agentSession.appServerThreadId &&
    (
      agentSession.approvalPolicy !== DESIRED_APP_SERVER_APPROVAL_POLICY ||
      agentSession.threadSandbox !== DESIRED_APP_SERVER_SANDBOX
    )
  );
}

function workerThreadNeedsForkOnReconnect(conn, agentSession) {
  return !!(
    conn &&
    agentSession &&
    agentSession.appServerThreadId &&
    conn.threadId !== agentSession.appServerThreadId
  );
}

async function ensureWorkerAppServerThread({ conn, manifest, agentConfig, agentSession, renderer, sessionLabel }) {
  if (!agentSession.appServerThreadId) {
    await conn.startThread({
      cwd: manifest.repoRoot,
      model: (agentConfig && agentConfig.model) || manifest.worker.model,
      approvalPolicy: DESIRED_APP_SERVER_APPROVAL_POLICY,
      sandbox: DESIRED_APP_SERVER_SANDBOX,
    });
    agentSession.appServerThreadId = conn.threadId;
    agentSession.threadSandbox = DESIRED_APP_SERVER_SANDBOX;
    agentSession.approvalPolicy = DESIRED_APP_SERVER_APPROVAL_POLICY;
    return 'started';
  }

  if (workerThreadNeedsRecovery(agentSession) || workerThreadNeedsForkOnReconnect(conn, agentSession)) {
    const recoveredThreadId = await conn.forkThread(agentSession.appServerThreadId, {
      approvalPolicy: DESIRED_APP_SERVER_APPROVAL_POLICY,
      sandbox: DESIRED_APP_SERVER_SANDBOX,
    });
    agentSession.appServerThreadId = recoveredThreadId;
    agentSession.threadSandbox = DESIRED_APP_SERVER_SANDBOX;
    agentSession.approvalPolicy = DESIRED_APP_SERVER_APPROVAL_POLICY;
    if (renderer && typeof renderer.banner === 'function') {
      const label = sessionLabel || 'worker';
      renderer.banner(`Recovered ${label} session into a writable Codex thread.`);
    }
    return 'forked';
  }

  await conn.resumeThread(agentSession.appServerThreadId);
  return 'resumed';
}

async function runCodexWorkerTurn({ manifest, request, loop, workerRecord, prompt, visiblePrompt = null, renderer, emitEvent, abortSignal, agentId, turnTracker = null }) {
  // Resolve agent config and session
  const isCustomAgent = agentId && agentId !== 'default';
  let agentConfig = null;
  let agentSession = null;

  if (isCustomAgent) {
    agentConfig = lookupAgentConfig(manifest.agents, agentId);
    if (!manifest.worker.agentSessions) manifest.worker.agentSessions = {};
    if (!manifest.worker.agentSessions[agentId]) {
      manifest.worker.agentSessions[agentId] = {
        sessionId: crypto.randomUUID(),
        hasStarted: false,
        boundBrowserPort: null,
        lastSeenChatLine: 0,
        lastSeenTranscriptLine: 0,
      };
    }
    agentSession = manifest.worker.agentSessions[agentId];
  }

  const sessionState = agentSession || manifest.worker;

  // Determine binary and display label
  const workerBin = (agentConfig && agentConfig.cli) || manifest.worker.bin || 'codex';
  const agentName = agentConfig && agentConfig.name;
  const workerLabel = workerLabelFor(workerBin, agentName);
  // Temporarily override renderer workerLabel for this agent turn
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = workerLabel;

  // Ensure remote desktop is running and inject --remote-port for qa-remote-* backends
  let desktop = null;
  if (isRemoteCli(workerBin)) {
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Codex worker process was interrupted.');
    }
    desktop = await ensureDesktop(manifest.repoRoot, manifest.panelId, manifest.useSnapshot !== false);
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Codex worker process was interrupted.');
    }
    if (desktop) {
      if (desktop.isNew) {
        renderer.banner(`Desktop container started (API port ${desktop.apiPort}, noVNC port ${desktop.novncPort})`);
        // New container = old sessions are gone. Reset so we don't resume a dead session.
        if (agentSession && agentSession.hasStarted) {
          agentSession.sessionId = crypto.randomUUID();
          agentSession.hasStarted = false;
        }
      }
      renderer.desktopReady(desktop.novncPort);
      // On abort, also send HTTP cancel directly to the container for immediate stop
      if (abortSignal) {
        const onRemoteAbort = () => cancelRemoteRun(desktop.apiPort).catch(() => {});
        abortSignal.addEventListener('abort', onRemoteAbort, { once: true });
      }
    } else {
      renderer.banner('Warning: Failed to start desktop container — is Docker running?');
    }
  }

  if (isCodexCliBackend(workerBin)) {
    await forkImportedCodexWorkerSession({
      manifest,
      agentConfig,
      sessionState,
      sessionKey: agentId || 'default',
      sessionLabel: agentName || (agentId || 'worker'),
      renderer,
    });
  }

  let spawnCommand = workerBin;
  let args = buildCodexWorkerArgs(manifest, workerRecord, { agentConfig, agentSession });
  if (isRemoteCli(workerBin) && desktop) {
    const resolved = resolveRemoteCommand(workerBin, args, desktop);
    spawnCommand = resolved.command;
    args = resolved.args;
  }
  const stdinText = buildCodexWorkerStdin(prompt, agentConfig, manifest.selfTesting ? { selfTesting: true } : undefined, manifest.repoRoot);

  await writeText(workerRecord.promptFile, `${redactHostedWorkflowValue(manifest, stdinText)}\n`);

  let discoveredSessionId = agentSession ? agentSession.sessionId : manifest.worker.sessionId;
  let finalResultText = '';

  // Use a clean CODEX_HOME so only explicitly passed MCP servers are loaded,
  // but keep imported session state available for external Codex chat recovery.
  const cleanEnv = buildIsolatedCodexEnv(manifest, 'cc-codex-home');
  // Codex doesn't exit after turn.completed — use a local abort controller to force-kill
  // Codex doesn't exit after turn.completed — use local abort to force-kill
  const localAbort = new AbortController();
  let turnDone = false;
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => { if (!localAbort.signal.aborted) localAbort.abort(); }, { once: true });
  }
  const result = await spawnStreamingProcess({
    command: spawnCommand,
    args,
    cwd: manifest.repoRoot,
    stdinText,
    env: cleanEnv,
    abortSignal: localAbort.signal,
    onStdoutLine: async (line) => {
      const raw = parseJsonLine(line);
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'worker-json',
        requestId: request.id,
        loopIndex: loop.index,
        rawLine: line,
        parsed: raw,
      })).catch(() => {});

      if (!raw) {
        renderer.claude(`(unparsed codex line) ${line}`);
        return;
      }

      // Capture session ID from thread.started
      if (raw.type === 'thread.started' && raw.thread_id) {
        discoveredSessionId = raw.thread_id;
      }

      // Codex doesn't exit after completing — force-kill when turn is done
      if (raw.type === 'turn.completed') {
        turnDone = true;
        setTimeout(() => { if (!localAbort.signal.aborted) localAbort.abort(); }, 500);
      }

      // MCP tool calls — render animated cards (pending → completed)
      if (raw.item && raw.item.type === 'mcp_tool_call' && renderer._post) {
        const server = raw.item.server || '';
        const tool = raw.item.tool || '';
        // Use item.id for matching started↔completed; track pending IDs for fallback
        const itemId = raw.item.id || '';
        const cardId = itemId ? ('mcp-' + itemId) : ('mcp-' + tool + '-' + Date.now());

        // Detect computer-use/chrome-devtools for inline widgets (keep this)
        if (raw.type === 'item.started') {
          if (server.includes('computer-control') || server.includes('computer_control')) renderer.computerUseDetected();
          if (server.includes('chrome-devtools') || server.includes('chrome_devtools')) renderer.chromeDevtoolsDetected();
        }

        // item.started → show pending card
        if (raw.type === 'item.started') {
          let inp = raw.item.arguments || raw.item.args || {};
          if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { inp = {}; } }
          const { renderStartCard } = require('./mcp-cards');
          const suppress = renderStartCard(tool, inp, renderer, workerLabel, cardId);
          if (suppress) return;
        }

        // item.completed → update to completed card
        if (raw.type === 'item.completed') {
          let inp = raw.item.arguments || raw.item.args || {};
          if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { inp = {}; } }
          let out = raw.item.output || raw.item.result || '';
          if (typeof out === 'string') { try { out = JSON.parse(out); } catch { out = {}; } }
          const { renderCompleteCard } = require('./mcp-cards');
          const suppress = renderCompleteCard(tool, inp, out, renderer, workerLabel, cardId);
          if (turnTracker) {
            turnTracker.noteRenderedToolCard(tool, inp, workerLabel);
            await turnTracker.noteToolCompletion(tool, inp, out, workerLabel);
          }
          if (suppress) return;
        }
      }

      // Render using worker-specific summarizer (omits controller lifecycle noise)
      const summary = summarizeCodexWorkerEvent(raw);
      if (summary && !manifest.settings.quiet) {
        if (summary.kind === 'reasoning') {
          renderer.streamMarkdown(workerLabel, summary.text);
          renderer.flushStream();
        } else {
          renderer.claude(summary.text);
        }
      }
    },
    onStderrLine: (line) => {
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'worker-stderr',
        requestId: request.id,
        loopIndex: loop.index,
        text: line,
      })).catch(() => {});
      if (!manifest.settings.quiet) {
        renderer.claude(line);
      }
    },
  });

  renderer.workerLabel = prevWorkerLabel;

  if (result.aborted && !turnDone) {
    // User-initiated abort, not turn-completed cleanup
    if (agentSession) {
      agentSession.sessionId = discoveredSessionId;
      agentSession.hasStarted = true;
    } else {
      manifest.worker.sessionId = discoveredSessionId;
      manifest.worker.hasStarted = true;
    }
    throw new Error('Codex worker process was interrupted.');
  }

  // Read final result from --output-last-message file
  try {
    const finalText = await readText(workerRecord.finalFile, '');
    if (finalText && finalText.trim()) {
      // Codex writes the agent_message text directly
      finalResultText = finalText.trim();
    }
  } catch {
    // File may not exist if process failed early
  }

  // Update session
  if (agentSession) {
    agentSession.sessionId = discoveredSessionId;
    agentSession.hasStarted = true;
    _recordWorkerBrowserBinding(manifest, agentSession, { ...(manifest.workerMcpServers || manifest.mcpServers || {}), ...((agentConfig && agentConfig.mcps) || {}) });
  } else {
    manifest.worker.sessionId = discoveredSessionId;
    manifest.worker.hasStarted = true;
    _recordWorkerBrowserBinding(manifest, manifest.worker, { ...(manifest.workerMcpServers || manifest.mcpServers || {}), ...((agentConfig && agentConfig.mcps) || {}) });
  }

  workerRecord.exitCode = result.code;
  workerRecord.resultText = finalResultText;
  workerRecord.sessionId = discoveredSessionId;

  const workerResult = {
    prompt: visiblePrompt == null ? prompt : visiblePrompt,
    exitCode: result.code,
    signal: result.signal,
    sessionId: discoveredSessionId,
    hadTextDelta: false,
    resultText: finalResultText,
    finalEvent: null,
  };

  request.latestWorkerResult = workerResult;
  await writeJson(workerRecord.finalFile, redactHostedWorkflowValue(manifest, workerResult));
  return workerResult;
}

/**
 * Run a Codex worker turn using the app-server protocol.
 * Uses a persistent connection instead of spawning a new CLI process per turn.
 */
async function runCodexWorkerTurnAppServer({ manifest, request, loop, workerRecord, prompt, visiblePrompt = null, renderer, emitEvent, abortSignal, agentId, turnTracker = null }) {
  // Resolve agent config
  const isCustomAgent = agentId && agentId !== 'default';
  let agentConfig = null;
  if (isCustomAgent) {
    agentConfig = lookupAgentConfig(manifest.agents, agentId);
  }

  // Display label
  const workerBin = (agentConfig && agentConfig.cli) || manifest.worker.bin || 'codex';
  const agentName = agentConfig && agentConfig.name;
  const workerLabel = workerLabelFor(workerBin, agentName);
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = workerLabel;

  // Build stdin text with system prompt prepended
  const stdinText = buildCodexWorkerStdin(prompt, agentConfig, manifest.selfTesting ? { selfTesting: true } : undefined, manifest.repoRoot);
  await writeText(workerRecord.promptFile, `${redactHostedWorkflowValue(manifest, stdinText)}\n`);

  // Get or create a connection keyed by a worker-specific key
  // Use a separate manifest-like object so worker connections don't collide with controller
  const workerConnKey = `${manifest.runId}-worker-${agentId || 'default'}`;
  // Merge agent-specific MCPs on top of base worker MCPs (same as CLI worker)
  const baseMcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
  const agentMcps = (agentConfig && agentConfig.mcps) || {};
  const workerMcpServers = { ...baseMcpServers, ...agentMcps };
  const connManifest = {
    runId: workerConnKey,
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
  const conn = getOrCreateConnection(connManifest);
  if (!conn.isConnected) {
    renderer.claude('Waiting for Codex app-server to initialize\u2026');
  }
  await conn.ensureConnected();

  // Track thread ID per agent session
  if (!manifest.worker.agentSessions) manifest.worker.agentSessions = {};
  const sessionKey = agentId || 'default';
  if (!manifest.worker.agentSessions[sessionKey]) {
    manifest.worker.agentSessions[sessionKey] = {
      sessionId: null,
      appServerThreadId: null,
      hasStarted: false,
      approvalPolicy: null,
      threadSandbox: null,
      boundBrowserPort: null,
      lastSeenChatLine: 0,
      lastSeenTranscriptLine: 0,
    };
  }
  const agentSession = manifest.worker.agentSessions[sessionKey];
  seedImportedCodexWorkerThread(agentSession, getImportedCodexSessionId(manifest));
  const _dbgFile = require('path').join(require('os').tmpdir(), 'cc-appserver-debug.log');
  try { require('fs').appendFileSync(_dbgFile, `[${new Date().toISOString()}] codex-worker: workerConnKey=${workerConnKey} baseMcpKeys=${JSON.stringify(Object.keys(baseMcpServers))} agentMcpKeys=${JSON.stringify(Object.keys(agentMcps))} mergedKeys=${JSON.stringify(Object.keys(workerMcpServers))} panelId=${manifest.panelId || null} chromeDebugPort=${manifest.chromeDebugPort} boundBrowserPort=${agentSession && agentSession.boundBrowserPort != null ? agentSession.boundBrowserPort : null} agentId=${agentId} agentCli=${agentConfig && agentConfig.cli}\n`); } catch {}

  // Turn completion tracking
  let turnResolve;
  let turnReject;
  const turnCompletePromise = new Promise((res, rej) => { turnResolve = res; turnReject = rej; });
  let agentMessageText = '';
  let turnCompleted = false;

  conn.onNotification(async (notification) => {
    const mapped = mapAppServerNotification(notification);
    if (!mapped) return;

    Promise.resolve(emitEvent({
      ts: new Date().toISOString(),
      source: 'worker-json',
      requestId: request.id,
      loopIndex: loop.index,
      rawLine: JSON.stringify(notification),
      parsed: mapped,
    })).catch(() => {});

    // Accumulate agent message text
    if (mapped.type === 'item.agentMessage.delta') {
      agentMessageText += mapped.text || '';
    }
    if (mapped.type === 'item.completed' && mapped.item && mapped.item.type === 'agent_message') {
      if (mapped.item.text) agentMessageText = mapped.item.text;
    }

    // Capture thread ID
    if (mapped.type === 'thread.started' && mapped.thread_id) {
      agentSession.appServerThreadId = mapped.thread_id;
    }

    // Turn completed
    if (mapped.type === 'turn.completed') {
      turnCompleted = true;
      turnResolve(mapped);
      return;
    }

    // MCP tool calls — render animated cards (same as CLI worker)
    if (mapped.item && mapped.item.type === 'mcp_tool_call' && renderer._post) {
      const server = mapped.item.server || '';
      const tool = mapped.item.tool || '';
      const itemId = mapped.item.id || '';
      const cardId = itemId ? ('mcp-' + itemId) : ('mcp-' + tool + '-' + Date.now());

      if (mapped.type === 'item.started') {
        if (server.includes('computer-control') || server.includes('computer_control')) renderer.computerUseDetected();
        if (server.includes('chrome-devtools') || server.includes('chrome_devtools')) renderer.chromeDevtoolsDetected();
      }

      if (mapped.type === 'item.started') {
        let inp = mapped.item.arguments || mapped.item.args || {};
        if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { inp = {}; } }
        const { renderStartCard } = require('./mcp-cards');
        const suppress = renderStartCard(tool, inp, renderer, workerLabel, cardId);
        if (suppress) return;
      }

      if (mapped.type === 'item.completed') {
        let inp = mapped.item.arguments || mapped.item.args || {};
        if (typeof inp === 'string') { try { inp = JSON.parse(inp); } catch { inp = {}; } }
        let out = mapped.item.output || mapped.item.result || '';
        if (typeof out === 'string') { try { out = JSON.parse(out); } catch { out = {}; } }
        const { renderCompleteCard } = require('./mcp-cards');
        const suppress = renderCompleteCard(tool, inp, out, renderer, workerLabel, cardId);
        if (turnTracker) {
          turnTracker.noteRenderedToolCard(tool, inp, workerLabel);
          await turnTracker.noteToolCompletion(tool, inp, out, workerLabel);
        }
        if (suppress) return;
      }
    }

    // Render using worker-specific summarizer
    const summary = summarizeCodexWorkerEvent(mapped);
    if (summary && !manifest.settings.quiet) {
      if (summary.kind === 'reasoning') {
        renderer.streamMarkdown(workerLabel, summary.text);
        renderer.flushStream();
      } else {
        renderer.claude(summary.text);
      }
    }
  });

  // Handle abort
  let abortHandler;
  if (abortSignal) {
    abortHandler = () => {
      conn.interruptTurn().catch(() => {});
      if (!turnCompleted) {
        turnReject(new Error('Codex worker process was interrupted.'));
      }
    };
    if (abortSignal.aborted) {
      renderer.workerLabel = prevWorkerLabel;
      throw new Error('Codex worker process was interrupted.');
    }
    abortSignal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    await ensureWorkerAppServerThread({
      conn,
      manifest,
      agentConfig,
      agentSession,
      renderer,
      sessionLabel: agentName || sessionKey,
    });

    await conn.startTurn(stdinText, undefined, {
      approvalPolicy: DESIRED_APP_SERVER_APPROVAL_POLICY,
      sandbox: DESIRED_APP_SERVER_SANDBOX,
    });
    await turnCompletePromise;
  } finally {
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
    conn.onNotification(null);
    renderer.workerLabel = prevWorkerLabel;
  }

  // Update session
  agentSession.sessionId = agentSession.appServerThreadId;
  agentSession.hasStarted = true;
  _recordWorkerBrowserBinding(manifest, agentSession, workerMcpServers);

  const finalResultText = agentMessageText.trim();
  workerRecord.exitCode = 0;
  workerRecord.resultText = finalResultText;
  workerRecord.sessionId = agentSession.appServerThreadId;

  const workerResult = {
    prompt: visiblePrompt == null ? prompt : visiblePrompt,
    exitCode: 0,
    signal: null,
    sessionId: agentSession.appServerThreadId,
    hadTextDelta: false,
    resultText: finalResultText,
    finalEvent: null,
  };

  request.latestWorkerResult = workerResult;
  await writeJson(workerRecord.finalFile, redactHostedWorkflowValue(manifest, workerResult));
  return workerResult;
}

module.exports = {
  buildCodexWorkerArgs,
  ensureWorkerAppServerThread,
  forkImportedCodexWorkerSession,
  seedImportedCodexWorkerThread,
  workerThreadNeedsForkOnReconnect,
  workerThreadNeedsRecovery,
  runCodexWorkerTurn,
  runCodexWorkerTurnAppServer,
};
