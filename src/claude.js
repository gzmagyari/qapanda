const crypto = require('node:crypto');
const { writeJson, writeText } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, extractTextFromClaudeContent } = require('./events');
const { buildDefaultWorkerAppendSystemPrompt, buildAgentWorkerSystemPrompt } = require('./prompts');
const { workerLabelFor } = require('./render');
const { isRemoteCli, injectRemotePort, ensureDesktop } = require('./remote-desktop');

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

  // System prompt: agent-specific or default
  const appendSystemPrompt = agentConfig
    ? buildAgentWorkerSystemPrompt(agentConfig)
    : (manifest.worker.appendSystemPrompt || buildDefaultWorkerAppendSystemPrompt());
  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }

  // Pass MCP servers via --mcp-config with inline JSON (prefer role-specific, fall back to shared)
  // Merge agent-specific MCPs on top of base worker MCPs
  const baseMcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
  const agentMcps = (agentConfig && agentConfig.mcps) || {};
  const mcpServers = { ...baseMcpServers, ...agentMcps };
  if (Object.keys(mcpServers).length > 0) {
    const mcpConfig = { mcpServers: {} };
    for (const [name, server] of Object.entries(mcpServers)) {
      if (!server || !server.command) continue;
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
      args.push('--mcp-config', JSON.stringify(mcpConfig));
    }
  }

  // Prompt is passed via stdin to avoid Windows cmd.exe command-line length limits
  return args;
}

async function runWorkerTurn({ manifest, request, loop, workerRecord, prompt, renderer, emitEvent, abortSignal, agentId }) {
  await writeText(workerRecord.promptFile, `${prompt}\n`);

  // Resolve agent config and session
  const isCustomAgent = agentId && agentId !== 'default';
  let agentConfig = null;
  let agentSession = null;

  if (isCustomAgent) {
    agentConfig = (manifest.agents || {})[agentId] || null;
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
  const prevWorkerLabel = renderer.workerLabel;
  renderer.workerLabel = workerLabelFor(workerBin);

  // Ensure remote desktop is running and inject --remote-port for qa-remote-* backends
  if (isRemoteCli(workerBin)) {
    const desktop = await ensureDesktop(manifest.repoRoot, manifest.panelId);
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
    } else {
      renderer.banner('Warning: qa-desktop not available — install with: pip install qa-agent-desktop');
    }
  }

  // Per-agent thinking: override CLAUDE_CODE_EFFORT_LEVEL if agent specifies it
  let spawnEnv = process.env;
  if (agentConfig && agentConfig.thinking) {
    spawnEnv = { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: agentConfig.thinking };
  }

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
