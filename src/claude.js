const crypto = require('node:crypto');
const { writeJson, writeText } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, extractTextFromClaudeContent, summarizeClaudeEvent } = require('./events');
const { buildDefaultWorkerAppendSystemPrompt, buildAgentWorkerSystemPrompt } = require('./prompts');
const { buildPromptsDirs } = require('./prompt-tags');
const { workerLabelFor } = require('./render');
const { isRemoteCli, resolveRemoteCommand, ensureDesktop, cancelRemoteRun, getLinkedInstance } = require('./remote-desktop');
const { lookupAgentConfig } = require('./state');

/**
 * @param {object} manifest
 * @param {object} [options]
 * @param {object} [options.agentConfig] - Agent config (system_prompt, mcps)
 * @param {object} [options.agentSession] - { sessionId, hasStarted }
 */
function buildClaudeArgs(manifest, options = {}) {
  const agentConfig = options.agentConfig || null;
  const agentSession = options.agentSession || null;

  // Check if this is a remote agent (running inside a container)
  const isRemoteAgent = agentConfig && typeof agentConfig.cli === 'string' && agentConfig.cli.startsWith('qa-remote');

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  // For local agents: isolate from user/project MCP configs
  // For remote agents: let the container use its own MCP config (correct container paths)
  if (!isRemoteAgent) {
    args.push('--setting-sources', 'local', '--strict-mcp-config');
  }

  // Use agent-specific session if provided, otherwise default worker session
  const session = agentSession || manifest.worker;
  if (session.hasStarted) {
    args.push('--resume', session.sessionId);
  } else {
    args.push('--session-id', session.sessionId);
  }

  const model = (agentConfig && agentConfig.model) || manifest.worker.model;
  if (model) {
    args.push('--model', model);
  }

  if (manifest.worker.allowedTools) {
    args.push('--allowedTools', manifest.worker.allowedTools);
  }

  if (manifest.worker.tools) {
    args.push('--tools', manifest.worker.tools);
  }

  if (manifest.worker.disallowedTools) {
    args.push('--disallowedTools', manifest.worker.disallowedTools);
  }

  // NOTE: Bash disabling moved to after MCP merge below

  if (manifest.worker.permissionPromptTool) {
    args.push('--permission-prompt-tool', manifest.worker.permissionPromptTool);
  }

  if (manifest.worker.maxTurns != null) {
    args.push('--max-turns', String(manifest.worker.maxTurns));
  }

  if (manifest.worker.maxBudgetUsd != null) {
    args.push('--max-budget-usd', String(manifest.worker.maxBudgetUsd));
  }

  for (const dir of manifest.worker.addDirs || []) {
    args.push('--add-dir', dir);
  }

  // Pass MCP servers via --mcp-config with inline JSON (prefer role-specific, fall back to shared)
  // IMPORTANT: must come BEFORE --system-prompt because multiline prompts break cmd.exe on Windows
  const baseMcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
  const agentMcps = (agentConfig && agentConfig.mcps) || {};
  const mcpServers = { ...baseMcpServers, ...agentMcps };
  if (Object.keys(mcpServers).length > 0) {
    const mcpConfig = { mcpServers: {} };
    for (const [name, server] of Object.entries(mcpServers)) {
      if (!server) continue;
      // Support HTTP MCP servers (for container access via host.docker.internal)
      if (server.url) {
        mcpConfig.mcpServers[name] = { type: 'http', url: server.url };
        continue;
      }
      if (!server.command) continue;
      mcpConfig.mcpServers[name] = {
        type: 'stdio',
        command: server.command,
        args: server.args || [],
      };
      if (server.env) {
        mcpConfig.mcpServers[name].env = server.env;
      }
    }
    if (Object.keys(mcpConfig.mcpServers).length > 0) {
      let mcpJson = JSON.stringify(mcpConfig);
      // Replace placeholders with actual values
      if (manifest.chromeDebugPort) {
        mcpJson = mcpJson.replace(/\{CHROME_DEBUG_PORT\}/g, String(manifest.chromeDebugPort));
      }
      if (manifest.extensionDir) {
        mcpJson = mcpJson.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/'));
      }
      if (manifest.repoRoot) {
        mcpJson = mcpJson.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/'));
      }
      args.push('--mcp-config', mcpJson);
    }
    // Disable built-in Claude in Chrome when we have our own chrome-devtools MCP
    if (!isRemoteAgent && mcpServers['chrome-devtools']) {
      args.push('--no-chrome');
    }
    // Disable built-in Bash when detached-command MCP is available (prevents session hangs)
    // For remote agents, the container's config handles this
    if (!isRemoteAgent && mcpServers['detached-command']) {
      const existing = args.indexOf('--disallowedTools');
      if (existing >= 0) {
        args[existing + 1] = args[existing + 1] + ',Bash';
      } else {
        args.push('--disallowedTools', 'Bash');
      }
    }
  }

  // System prompt: agent with custom prompt uses --system-prompt (full replacement),
  // otherwise --append-system-prompt adds to Claude Code's default system prompt
  // NOTE: must be LAST because multiline text breaks cmd.exe arg parsing on Windows
  const selfTestOpts = manifest.selfTesting ? { selfTesting: true, selfTestPrompts: manifest.selfTestPrompts } : undefined;
  const _promptsDirs = buildPromptsDirs(manifest.repoRoot);
  if (agentConfig && agentConfig.system_prompt) {
    const sysPrompt = buildAgentWorkerSystemPrompt(
      agentConfig,
      selfTestOpts ? { ...selfTestOpts, repoRoot: manifest.repoRoot } : { repoRoot: manifest.repoRoot },
      _promptsDirs
    );
    args.push('--system-prompt', sysPrompt);
  } else {
    const appendSystemPrompt = buildAgentWorkerSystemPrompt(
      agentConfig,
      selfTestOpts ? { ...selfTestOpts, repoRoot: manifest.repoRoot } : { repoRoot: manifest.repoRoot },
      _promptsDirs
    ) || manifest.worker.appendSystemPrompt || buildDefaultWorkerAppendSystemPrompt();
    if (appendSystemPrompt) {
      args.push('--append-system-prompt', appendSystemPrompt);
    }
  }

  // Prompt is passed via stdin to avoid Windows cmd.exe command-line length limits
  console.error('[DEBUG claude.js] buildClaudeArgs agentConfig:', JSON.stringify(agentConfig), 'args:', args.join(' '));
  return args;
}

async function runWorkerTurn({ manifest, request, loop, workerRecord, prompt, visiblePrompt = null, renderer, emitEvent, abortSignal, agentId, turnTracker = null }) {
  await writeText(workerRecord.promptFile, `${prompt}\n`);

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
        lastSeenChatLine: 0,
        lastSeenTranscriptLine: 0,
      };
    }
    agentSession = manifest.worker.agentSessions[agentId];
  }

  let args = buildClaudeArgs(manifest, { agentConfig, agentSession });

  let accumulatedText = '';
  let lastAssistantMessage = '';
  let finalResultText = '';
  let finalEvent = null;
  let discoveredSessionId = agentSession ? agentSession.sessionId : manifest.worker.sessionId;
  let sawTextDelta = false;
  const pendingToolCalls = new Map();

  // Resolve binary and display label
  let workerBin = (agentConfig && agentConfig.cli) || manifest.worker.bin || 'codex';
  const agentName = agentConfig && agentConfig.name;
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = workerLabelFor(workerBin, agentName);

  // Ensure remote desktop is running and inject --remote-port for qa-remote-* backends
  if (isRemoteCli(workerBin)) {
    // If already aborted before we even start the desktop, bail out
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Claude Code process was interrupted.');
    }
    if (!getLinkedInstance(manifest.panelId)) {
      renderer.banner('Starting desktop container\u2026');
    }
    const desktop = await ensureDesktop(manifest.repoRoot, manifest.panelId, manifest.useSnapshot !== false);
    // Check again — abort may have fired during ensureDesktop
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Claude Code process was interrupted.');
    }
    if (desktop) {
      if (desktop.isNew) {
        renderer.banner(`Desktop container started (API port ${desktop.apiPort}, noVNC port ${desktop.novncPort})`);
        // New container = old sessions are gone. Reset so we don't --resume a dead session.
        if (agentSession && agentSession.hasStarted) {
          agentSession.sessionId = crypto.randomUUID();
          agentSession.hasStarted = false;
          args = buildClaudeArgs(manifest, { agentConfig, agentSession });
        }
      }
      renderer.desktopReady(desktop.novncPort);
      // Resolve to bundled Node.js proxy instead of qa-remote-* on PATH
      const resolved = resolveRemoteCommand(workerBin, args, desktop);
      workerBin = resolved.command;
      args = resolved.args;
      // On abort, also send HTTP cancel directly to the container for immediate stop
      if (abortSignal) {
        const onRemoteAbort = () => cancelRemoteRun(desktop.apiPort).catch(() => {});
        abortSignal.addEventListener('abort', onRemoteAbort, { once: true });
      }
    } else {
      renderer.banner('Warning: Failed to start desktop container — is Docker running?');
    }
  }

  // Per-agent thinking: override CLAUDE_CODE_EFFORT_LEVEL if agent specifies it
  // Strip ELECTRON_RUN_AS_NODE which VSCode extension host sets — it breaks Claude CLI behavior
  const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env;
  let spawnEnv = cleanEnv;
  if (agentConfig && agentConfig.thinking) {
    spawnEnv = { ...cleanEnv, CLAUDE_CODE_EFFORT_LEVEL: agentConfig.thinking };
  }

  // Debug: log the exact command and key env vars
  try {
    const _shellArgs = args.map(a => a.includes(' ') || a.includes('"') || a.includes('{') ? "'" + a.replace(/'/g, "'\\''") + "'" : a);
    const _envInfo = `PATH_has_claude=${(spawnEnv.PATH || '').includes('claude')}, CLAUDE_CONFIG_DIR=${spawnEnv.CLAUDE_CONFIG_DIR || 'unset'}, CLAUDE_CODE_SIMPLE=${spawnEnv.CLAUDE_CODE_SIMPLE || 'unset'}, NODE_OPTIONS=${spawnEnv.NODE_OPTIONS || 'unset'}, ELECTRON_RUN_AS_NODE=${spawnEnv.ELECTRON_RUN_AS_NODE || 'unset'}`;
    require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'cc-chrome-debug.log'), `[${new Date().toISOString()}] CWD: ${manifest.repoRoot}\nENV: ${_envInfo}\nCMD: ${workerBin} ${_shellArgs.join(' ')}\n\n`);
  } catch {}

  const result = await spawnStreamingProcess({
    command: workerBin,
    args,
    cwd: manifest.repoRoot,
    stdinText: prompt,
    env: spawnEnv,
    abortSignal,
    resolveOnResult: true,
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
        renderer.claude(`(unparsed claude line) ${line}`);
        return;
      }
      // Debug: log the init event to see what MCPs Claude actually loaded
      if (raw.type === 'system' && raw.mcp_servers) {
        try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'cc-chrome-debug.log'), `\nINIT_MCP_SERVERS: ${JSON.stringify(raw.mcp_servers)}\n`); } catch {}
      }
      if (raw.session_id) {
        discoveredSessionId = raw.session_id;
      }
      if (raw.type === 'stream_event') {
        const event = raw.event || {};
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          if (!sawTextDelta && event.delta.text) {
            event.delta.text = event.delta.text.replace(/^\n+/, '');
          }
          accumulatedText += event.delta.text || '';
          sawTextDelta = true;
        }
      }
      if (raw.type === 'assistant_message' || raw.type === 'assistant') {
        const text = extractTextFromClaudeContent(raw.message?.content || raw.content);
        if (text) {
          lastAssistantMessage = text;
        }
      }
      if (raw.type === 'result_message' || raw.type === 'result') {
        finalEvent = raw;
        if (typeof raw.result === 'string') {
          finalResultText = raw.result;
        } else if (typeof raw.result?.text === 'string') {
          finalResultText = raw.result.text;
        } else {
          finalResultText = extractTextFromClaudeContent(raw.message?.content || raw.content);
        }
      }

      if ((raw.type === 'assistant_message' || raw.type === 'assistant') && sawTextDelta) {
        if (turnTracker) await turnTracker.flushPendingMutations();
        return;
      }
      if ((raw.type === 'result_message' || raw.type === 'result') && sawTextDelta) {
        renderer.flushStream();
        if (turnTracker) await turnTracker.flushPendingMutations();
        return;
      }
      if (turnTracker) {
        const summary = summarizeClaudeEvent(raw);
        if (summary && summary.kind === 'tool-start') {
          pendingToolCalls.set(summary.index, { name: summary.toolName, inputJson: '' });
        } else if (summary && summary.kind === 'tool-input-delta') {
          const pending = pendingToolCalls.get(summary.index);
          if (pending) pending.inputJson += summary.text || '';
        } else if (summary && summary.kind === 'block-stop') {
          const pending = pendingToolCalls.get(summary.index);
          let input = {};
          if (pending) {
            try { input = JSON.parse(pending.inputJson || '{}'); } catch {}
            turnTracker.noteRenderedToolCard(pending.name, input, renderer.workerLabel);
            turnTracker.queueMutation(pending.name, input, renderer.workerLabel);
            pendingToolCalls.delete(summary.index);
          }
        }
      }
      renderer.claudeEvent(raw);
      if (turnTracker) await turnTracker.flushPendingMutations();
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

  if (result.aborted) {
    // User-initiated abort, not turn-completed cleanup
    if (agentSession) {
      agentSession.sessionId = discoveredSessionId;
      agentSession.hasStarted = true;
    } else {
      manifest.worker.sessionId = discoveredSessionId;
      manifest.worker.hasStarted = true;
    }
    throw new Error('Claude Code process was interrupted.');
  }

  if (!finalResultText) {
    finalResultText = lastAssistantMessage || accumulatedText || '';
  }

  // Update the correct session
  if (agentSession) {
    agentSession.sessionId = discoveredSessionId;
    agentSession.hasStarted = true;
  } else {
    manifest.worker.sessionId = discoveredSessionId;
    manifest.worker.hasStarted = true;
  }

  workerRecord.exitCode = result.code;
  workerRecord.resultText = finalResultText;
  workerRecord.sessionId = discoveredSessionId;

  const workerResult = {
    prompt: visiblePrompt == null ? prompt : visiblePrompt,
    exitCode: result.code,
    signal: result.signal,
    sessionId: discoveredSessionId,
    hadTextDelta: sawTextDelta,
    resultText: finalResultText,
    finalEvent,
  };

  request.latestWorkerResult = workerResult;
  await writeJson(workerRecord.finalFile, workerResult);
  return workerResult;
}

/**
 * Build CLI args for interactive mode (no -p, no --output-format, no --verbose).
 * These flags are print-mode-only; interactive mode runs the TUI directly.
 */
function buildInteractiveArgs(manifest, options = {}) {
  const agentConfig = options.agentConfig || null;
  const args = [
    '--dangerously-skip-permissions',
    '--setting-sources', 'local',
    '--strict-mcp-config',
  ];

  const model = (agentConfig && agentConfig.model) || manifest.worker.model;
  if (model) args.push('--model', model);

  if (manifest.worker.allowedTools) args.push('--allowedTools', manifest.worker.allowedTools);
  if (manifest.worker.tools) args.push('--tools', manifest.worker.tools);
  if (manifest.worker.disallowedTools) args.push('--disallowedTools', manifest.worker.disallowedTools);
  if (manifest.worker.permissionPromptTool) args.push('--permission-prompt-tool', manifest.worker.permissionPromptTool);
  if (manifest.worker.maxTurns != null) args.push('--max-turns', String(manifest.worker.maxTurns));
  if (manifest.worker.maxBudgetUsd != null) args.push('--max-budget-usd', String(manifest.worker.maxBudgetUsd));
  for (const dir of manifest.worker.addDirs || []) args.push('--add-dir', dir);

  // MCP config (same logic as buildClaudeArgs)
  const baseMcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
  const agentMcps = (agentConfig && agentConfig.mcps) || {};
  const mcpServers = { ...baseMcpServers, ...agentMcps };
  if (Object.keys(mcpServers).length > 0) {
    const mcpConfig = { mcpServers: {} };
    for (const [name, server] of Object.entries(mcpServers)) {
      if (!server) continue;
      if (server.url) { mcpConfig.mcpServers[name] = { type: 'http', url: server.url }; continue; }
      if (!server.command) continue;
      mcpConfig.mcpServers[name] = { type: 'stdio', command: server.command, args: server.args || [] };
      if (server.env) mcpConfig.mcpServers[name].env = server.env;
    }
    if (Object.keys(mcpConfig.mcpServers).length > 0) {
      let mcpJson = JSON.stringify(mcpConfig);
      if (manifest.chromeDebugPort) mcpJson = mcpJson.replace(/\{CHROME_DEBUG_PORT\}/g, String(manifest.chromeDebugPort));
      args.push('--mcp-config', mcpJson);
    }
    // Disable built-in Claude in Chrome when we have our own chrome-devtools MCP
    if (mcpServers['chrome-devtools']) {
      args.push('--no-chrome');
    }
  }

  // System prompt (same logic as buildClaudeArgs)
  const selfTestOpts2 = manifest.selfTesting ? { selfTesting: true, selfTestPrompts: manifest.selfTestPrompts } : undefined;
  const _promptsDirs2 = buildPromptsDirs(manifest.repoRoot);
  if (agentConfig && agentConfig.system_prompt) {
    const sysPrompt2 = buildAgentWorkerSystemPrompt(
      agentConfig,
      selfTestOpts2 ? { ...selfTestOpts2, repoRoot: manifest.repoRoot } : { repoRoot: manifest.repoRoot },
      _promptsDirs2
    );
    args.push('--system-prompt', sysPrompt2);
  } else {
    const appendSystemPrompt = buildAgentWorkerSystemPrompt(
      agentConfig,
      selfTestOpts2 ? { ...selfTestOpts2, repoRoot: manifest.repoRoot } : { repoRoot: manifest.repoRoot },
      _promptsDirs2
    ) || manifest.worker.appendSystemPrompt || buildDefaultWorkerAppendSystemPrompt();
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  }

  return args;
}

/**
 * Interactive-mode worker turn: uses ClaudeSession (persistent PTY)
 * instead of spawning a fresh process per turn.
 */
async function runWorkerTurnInteractive({ manifest, request, loop, workerRecord, prompt, renderer, emitEvent, abortSignal, agentId, turnTracker = null }) {
  await writeText(workerRecord.promptFile, `${prompt}\n`);

  const isCustomAgent = agentId && agentId !== 'default';
  let agentConfig = null;
  if (isCustomAgent) {
    agentConfig = lookupAgentConfig(manifest.agents, agentId);
  }

  const workerBin = (agentConfig && agentConfig.cli) || manifest.worker.bin || 'codex';
  const agentName = agentConfig && agentConfig.name;
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = workerLabelFor(workerBin, agentName);

  // Per-agent thinking
  const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env;
  let spawnEnv = cleanEnv;
  if (agentConfig && agentConfig.thinking) {
    spawnEnv = { ...cleanEnv, CLAUDE_CODE_EFFORT_LEVEL: agentConfig.thinking };
  }

  // Get or create persistent ClaudeSession
  const sessionKey = agentId || '_default';
  if (!manifest.worker._interactiveSessions) manifest.worker._interactiveSessions = {};

  const { ClaudeSession } = require('../claude-parser');

  let session = manifest.worker._interactiveSessions[sessionKey];
  if (!session || session._closed) {
    session = new ClaudeSession({
      cwd: manifest.repoRoot,
      bin: workerBin,
      args: buildInteractiveArgs(manifest, { agentConfig }),
      env: spawnEnv,
    });
    manifest.worker._interactiveSessions[sessionKey] = session;
  }

  // Handle abort
  let abortHandler;
  if (abortSignal) {
    abortHandler = () => { session.abort(); };
    abortSignal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'cc-interactive-debug.log'),
      `[${new Date().toISOString()}] runWorkerTurnInteractive START prompt=${JSON.stringify(prompt.slice(0,50))}\n`);

    let hadStreamedText = false;
    const result = await session.send(prompt, {
      async onEvent(event) {
        try {
          require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'cc-interactive-debug.log'),
            `[${new Date().toISOString()}] EVENT ${JSON.stringify(event)}\n`);
        } catch {}

        Promise.resolve(emitEvent({
          ts: new Date().toISOString(),
          source: 'worker-interactive',
          requestId: request.id,
          loopIndex: loop.index,
          event,
        })).catch(() => {});

        if (event.kind === 'text-delta') {
          hadStreamedText = true;
          renderer.streamMarkdown(renderer.workerLabel, event.text + '\n', '\x1b[32m');
        } else if (event.kind === 'tool-start') {
          hadStreamedText = true;
          renderer.flushStream();
          if (turnTracker) {
            turnTracker.noteRenderedToolCard(event.toolName || '', {}, renderer.workerLabel);
            turnTracker.queueMutation(event.toolName || '', {}, renderer.workerLabel);
          }
          const tn = event.toolName || '';
          const isComputerUse = tn.startsWith('mcp__computer-control__') || tn.startsWith('mcp__chrome-devtools__');
          const isChromeDevtools = tn.startsWith('mcp__chrome-devtools__');
          if (renderer._post) {
            renderer._post({ type: 'toolCall', label: renderer.workerLabel, text: event.toolText, isComputerUse, isChromeDevtools });
          } else {
            renderer.claude(`Tool: ${event.toolText}`);
          }
        } else if (event.kind === 'tool-output') {
          hadStreamedText = true;
          renderer.claude(`  ${event.text}`);
        } else if (event.kind === 'final-text') {
          // If nothing was streamed during this turn (repaint timing),
          // render the final result text so the user sees something
          if (!hadStreamedText && event.text) {
            const plainText = event.text.replace(/^● /gm, '').replace(/^ {2}⎿\s*/gm, '  ');
            renderer.streamMarkdown(renderer.workerLabel, plainText + '\n', '\x1b[32m');
          }
          renderer.flushStream();
        }
        if (turnTracker) {
          await turnTracker.flushPendingMutations();
        }
      }
    });

    require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'cc-interactive-debug.log'),
      `[${new Date().toISOString()}] DONE resultText=${JSON.stringify(result.resultText)}\n`);

    renderer.workerLabel = prevWorkerLabel;

    workerRecord.exitCode = result.exitCode;
    workerRecord.resultText = result.resultText;
    workerRecord.sessionId = result.sessionId;

    const workerResult = {
      prompt,
      exitCode: result.exitCode,
      signal: result.signal,
      sessionId: result.sessionId,
      hadTextDelta: result.hadTextDelta,
      resultText: result.resultText,
      finalEvent: result.finalEvent,
    };

    request.latestWorkerResult = workerResult;
    await writeJson(workerRecord.finalFile, workerResult);
    return workerResult;
  } catch (err) {
    renderer.workerLabel = prevWorkerLabel;

    if (abortSignal && abortSignal.aborted) {
      throw new Error('Claude Code process was interrupted.');
    }
    throw err;
  } finally {
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Close all interactive sessions stored in the manifest.
 */
function closeInteractiveSessions(manifest) {
  const sessions = manifest.worker && manifest.worker._interactiveSessions;
  if (!sessions) return;
  for (const [key, session] of Object.entries(sessions)) {
    try { session.close(); } catch {}
  }
  manifest.worker._interactiveSessions = {};
}

module.exports = {
  buildClaudeArgs,
  buildInteractiveArgs,
  runWorkerTurn,
  runWorkerTurnInteractive,
  closeInteractiveSessions,
};
