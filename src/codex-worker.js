const crypto = require('node:crypto');
const { readText, writeText, writeJson } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, summarizeCodexWorkerEvent } = require('./events');
const { buildAgentWorkerSystemPrompt } = require('./prompts');
const { workerLabelFor } = require('./render');
const { isRemoteCli, injectRemotePort, ensureDesktop, cancelRemoteRun } = require('./remote-desktop');
const { lookupAgentConfig } = require('./state');

const MCP_STARTUP_TIMEOUT_SEC = 30;

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
    if (!server || !server.command) continue;
    args.push('-c', `mcp_servers.${name}.command="${tomlEsc(server.command)}"`);
    if (Array.isArray(server.args) && server.args.length > 0) {
      const argsToml = `[${server.args.map((a) => `"${tomlEsc(a)}"`).join(', ')}]`;
      args.push('-c', `mcp_servers.${name}.args=${argsToml}`);
    }
    if (server.env && typeof server.env === 'object') {
      for (const [key, val] of Object.entries(server.env)) {
        args.push('-c', `mcp_servers.${name}.env.${key}="${tomlEsc(val)}"`);
      }
    }
    args.push('-c', `mcp_servers.${name}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
  }

  args.push('-');
  return args;
}

/**
 * Build stdin text for Codex worker.
 * Codex reads its full instructions from stdin (no --append-system-prompt flag).
 * For agents with a system_prompt, we prepend it before the actual user prompt.
 */
function buildCodexWorkerStdin(prompt, agentConfig) {
  if (!agentConfig) return prompt;
  const systemPrompt = buildAgentWorkerSystemPrompt(agentConfig);
  if (!systemPrompt) return prompt;
  return `${systemPrompt}\n\n---\n\n${prompt}`;
}

async function runCodexWorkerTurn({ manifest, request, loop, workerRecord, prompt, renderer, emitEvent, abortSignal, agentId }) {
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
      renderer.banner('Warning: qa-desktop not available — install with: pip install qa-agent-desktop');
    }
  }

  const args = injectRemotePort(workerBin, buildCodexWorkerArgs(manifest, workerRecord, { agentConfig, agentSession }), desktop);
  const stdinText = buildCodexWorkerStdin(prompt, agentConfig);

  await writeText(workerRecord.promptFile, `${stdinText}\n`);

  let discoveredSessionId = agentSession ? agentSession.sessionId : manifest.worker.sessionId;
  let finalResultText = '';

  const result = await spawnStreamingProcess({
    command: workerBin,
    args,
    cwd: manifest.repoRoot,
    stdinText,
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
        renderer.claude(`(unparsed codex line) ${line}`);
        return;
      }

      // Capture session ID from thread.started
      if (raw.type === 'thread.started' && raw.thread_id) {
        discoveredSessionId = raw.thread_id;
      }

      // Detect computer-control MCP tool calls for inline VNC
      if (raw.type === 'item.started' && raw.item && raw.item.type === 'mcp_tool_call') {
        const server = raw.item.server || '';
        if (server.includes('computer-control') || server.includes('computer_control') || server.includes('chrome-devtools') || server.includes('chrome_devtools')) {
          renderer.computerUseDetected();
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

  if (result.aborted) {
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
    hadTextDelta: false,
    resultText: finalResultText,
    finalEvent: null,
  };

  request.latestWorkerResult = workerResult;
  await writeJson(workerRecord.finalFile, workerResult);
  return workerResult;
}

module.exports = {
  buildCodexWorkerArgs,
  runCodexWorkerTurn,
};
