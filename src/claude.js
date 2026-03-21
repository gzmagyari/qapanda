const crypto = require('node:crypto');
const { writeJson, writeText } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, extractTextFromClaudeContent } = require('./events');
const { buildDefaultWorkerAppendSystemPrompt, buildAgentWorkerSystemPrompt } = require('./prompts');
const { workerLabelFor } = require('./render');
const { isRemoteCli, injectRemotePort, ensureDesktop, cancelRemoteRun } = require('./remote-desktop');
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

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--setting-sources', 'local',
    '--strict-mcp-config',
  ];

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
      // Replace {CHROME_DEBUG_PORT} placeholder with actual port
      if (manifest.chromeDebugPort) {
        mcpJson = mcpJson.replace(/\{CHROME_DEBUG_PORT\}/g, String(manifest.chromeDebugPort));
      }
      args.push('--mcp-config', mcpJson);
    }
  }

  // System prompt: agent with custom prompt uses --system-prompt (full replacement),
  // otherwise --append-system-prompt adds to Claude Code's default system prompt
  // NOTE: must be LAST because multiline text breaks cmd.exe arg parsing on Windows
  if (agentConfig && agentConfig.system_prompt) {
    args.push('--system-prompt', agentConfig.system_prompt);
  } else {
    const appendSystemPrompt = agentConfig
      ? buildAgentWorkerSystemPrompt(agentConfig)
      : (manifest.worker.appendSystemPrompt || buildDefaultWorkerAppendSystemPrompt());
    if (appendSystemPrompt) {
      args.push('--append-system-prompt', appendSystemPrompt);
    }
  }

  // Prompt is passed via stdin to avoid Windows cmd.exe command-line length limits
  console.error('[DEBUG claude.js] buildClaudeArgs agentConfig:', JSON.stringify(agentConfig), 'args:', args.join(' '));
  return args;
}

async function runWorkerTurn({ manifest, request, loop, workerRecord, prompt, renderer, emitEvent, abortSignal, agentId }) {
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

  // Resolve binary and display label
  const workerBin = (agentConfig && agentConfig.cli) || manifest.worker.bin || 'claude';
  const agentName = agentConfig && agentConfig.name;
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = workerLabelFor(workerBin, agentName);

  // Ensure remote desktop is running and inject --remote-port for qa-remote-* backends
  if (isRemoteCli(workerBin)) {
    // If already aborted before we even start the desktop, bail out
    if (abortSignal && abortSignal.aborted) {
      throw new Error('Claude Code process was interrupted.');
    }
    renderer.banner('Starting desktop container\u2026');
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
      args = injectRemotePort(workerBin, args, desktop);
      // On abort, also send HTTP cancel directly to the container for immediate stop
      if (abortSignal) {
        const onRemoteAbort = () => cancelRemoteRun(desktop.apiPort).catch(() => {});
        abortSignal.addEventListener('abort', onRemoteAbort, { once: true });
      }
    } else {
      renderer.banner('Warning: qa-desktop not available — install with: pip install qa-agent-desktop');
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
    require('fs').appendFileSync(require('path').join(require('os').homedir(), 'Desktop', 'cc-chrome-debug.log'), `[${new Date().toISOString()}] CWD: ${manifest.repoRoot}\nENV: ${_envInfo}\nCMD: ${workerBin} ${_shellArgs.join(' ')}\n\n`);
  } catch {}

  const result = await spawnStreamingProcess({
    command: workerBin,
    args,
    cwd: manifest.repoRoot,
    stdinText: prompt,
    env: spawnEnv,
    abortSignal,
    onStdoutLine: (line) => {
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
        try { require('fs').appendFileSync(require('path').join(require('os').homedir(), 'Desktop', 'cc-chrome-debug.log'), `\nINIT_MCP_SERVERS: ${JSON.stringify(raw.mcp_servers)}\n`); } catch {}
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
        return;
      }
      if ((raw.type === 'result_message' || raw.type === 'result') && sawTextDelta) {
        renderer.flushStream();
        return;
      }
      renderer.claudeEvent(raw);
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
    // Mark session as started so resume uses --resume instead of --session-id
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
    prompt,
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

module.exports = {
  buildClaudeArgs,
  runWorkerTurn,
};
