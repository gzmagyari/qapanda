const { writeJson, writeText } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, extractTextFromClaudeContent } = require('./events');
const { buildDefaultWorkerAppendSystemPrompt } = require('./prompts');

function buildClaudeArgs(manifest) {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (manifest.worker.hasStarted) {
    args.push('--resume', manifest.worker.sessionId);
  } else {
    args.push('--session-id', manifest.worker.sessionId);
  }

  if (manifest.worker.model) {
    args.push('--model', manifest.worker.model);
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

  const appendSystemPrompt = manifest.worker.appendSystemPrompt || buildDefaultWorkerAppendSystemPrompt();
  if (appendSystemPrompt) {
    args.push('--append-system-prompt', appendSystemPrompt);
  }

  // Pass MCP servers via --mcp-config with inline JSON (prefer role-specific, fall back to shared)
  const mcpServers = manifest.workerMcpServers || manifest.mcpServers || {};
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

async function runWorkerTurn({ manifest, request, loop, workerRecord, prompt, renderer, emitEvent, abortSignal }) {
  await writeText(workerRecord.promptFile, `${prompt}\n`);
  const args = buildClaudeArgs(manifest);

  let accumulatedText = '';
  let lastAssistantMessage = '';
  let finalResultText = '';
  let finalEvent = null;
  let discoveredSessionId = manifest.worker.sessionId;
  let sawTextDelta = false;

  const result = await spawnStreamingProcess({
    command: manifest.worker.bin,
    args,
    cwd: manifest.repoRoot,
    stdinText: prompt,
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

  if (result.aborted) {
    // Mark session as started so resume uses --resume instead of --session-id
    manifest.worker.sessionId = discoveredSessionId;
    manifest.worker.hasStarted = true;
    throw new Error('Claude Code process was interrupted.');
  }

  if (!finalResultText) {
    finalResultText = lastAssistantMessage || accumulatedText || '';
  }

  manifest.worker.sessionId = discoveredSessionId;
  manifest.worker.hasStarted = true;

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
