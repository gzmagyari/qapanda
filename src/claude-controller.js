const path = require('node:path');
const { writeText, writeJson, randomId } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');
const { parseJsonLine, extractTextFromClaudeContent } = require('./events');
const { buildControllerPrompt } = require('./prompts');
const { validateControllerDecision, controllerDecisionSchema } = require('./schema');
const { countTranscriptLinesSync } = require('./transcript');
const { redactHostedWorkflowValue } = require('./cloud/workflow-hosted-runs');
const { isClaudeCliCommand, sanitizeClaudeSessionImagesForResume } = require('./claude-session-sanitizer');

async function materializeClaudeControllerLaunchFiles(manifest, loop) {
  const baseFile = loop && loop.controller && loop.controller.promptFile
    ? loop.controller.promptFile.replace(/\.prompt\.txt$/i, '')
    : path.join(manifest.runDir || manifest.repoRoot || '.', 'controller');
  const controllerMcp = manifest.controllerMcpServers || manifest.mcpServers || {};
  if (Object.keys(controllerMcp).length === 0) {
    return {};
  }
  const mcpConfig = { mcpServers: {} };
  for (const [name, server] of Object.entries(controllerMcp)) {
    if (!server) continue;
    if (server.url) {
      mcpConfig.mcpServers[name] = { type: 'http', url: server.url };
      continue;
    }
    if (!server.command) continue;
    mcpConfig.mcpServers[name] = { type: 'stdio', command: server.command, args: server.args || [] };
    if (server.env) mcpConfig.mcpServers[name].env = server.env;
  }
  if (Object.keys(mcpConfig.mcpServers).length === 0) {
    return {};
  }
  let json = JSON.stringify(mcpConfig);
  if (manifest.extensionDir) {
    json = json.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/'));
  }
  if (manifest.repoRoot) {
    json = json.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/'));
  }
  const mcpConfigPath = `${baseFile}.mcp-config.json`;
  await writeJson(mcpConfigPath, JSON.parse(json));
  return { mcpConfigPath };
}

function buildClaudeControllerArgs(manifest, loop, options = {}) {
  const mcpConfigPath = options.mcpConfigPath || null;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--setting-sources', 'local',
    '--strict-mcp-config',
  ];

  if (manifest.controller.sessionId) {
    args.push('--resume', manifest.controller.sessionId);
  } else {
    // Generate a proper UUID for the initial session (Claude CLI requires valid UUIDs)
    if (!manifest.controller.claudeSessionId) {
      manifest.controller.claudeSessionId = randomId();
    }
    args.push('--session-id', manifest.controller.claudeSessionId);
  }

  if (manifest.controller.model) {
    args.push('--model', manifest.controller.model);
  }

  // Enforce structured JSON output — works with both --session-id and --resume in -p mode
  args.push('--json-schema', JSON.stringify(controllerDecisionSchema));

  // Pass controller MCP servers
  const controllerMcp = manifest.controllerMcpServers || manifest.mcpServers || {};
  if (Object.keys(controllerMcp).length > 0) {
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);
    } else {
      const mcpConfig = { mcpServers: {} };
      for (const [name, server] of Object.entries(controllerMcp)) {
        if (!server) continue;
        if (server.url) {
          mcpConfig.mcpServers[name] = { type: 'http', url: server.url };
          continue;
        }
        if (!server.command) continue;
        mcpConfig.mcpServers[name] = { type: 'stdio', command: server.command, args: server.args || [] };
        if (server.env) mcpConfig.mcpServers[name].env = server.env;
      }
      if (Object.keys(mcpConfig.mcpServers).length > 0) {
        let mcpJson = JSON.stringify(mcpConfig);
        if (manifest.extensionDir) {
          mcpJson = mcpJson.replace(/\{EXTENSION_DIR\}/g, manifest.extensionDir.replace(/\\/g, '/'));
        }
        if (manifest.repoRoot) {
          mcpJson = mcpJson.replace(/\{REPO_ROOT\}/g, manifest.repoRoot.replace(/\\/g, '/'));
        }
        args.push('--mcp-config', mcpJson);
      }
    }
    // Disable built-in Bash when detached-command is available
    if (controllerMcp['detached-command']) {
      args.push('--disallowedTools', 'Bash');
    }
  }

  return args;
}

async function runClaudeControllerTurn({ manifest, request, loop, renderer, emitEvent, abortSignal, controllerPromptOverride = null }) {
  const prompt = buildControllerPrompt(manifest, request, { systemPromptOverride: controllerPromptOverride });
  await writeText(loop.controller.promptFile, `${redactHostedWorkflowValue(manifest, prompt)}\n`);

  const launchFiles = await materializeClaudeControllerLaunchFiles(manifest, loop);
  const args = buildClaudeControllerArgs(manifest, loop, launchFiles);
  let discoveredSessionId = manifest.controller.sessionId;

  const configuredControllerSessionId = manifest.controller.sessionId;
  if (isClaudeCliCommand(manifest.controller.bin) && configuredControllerSessionId) {
    try {
      const stats = await sanitizeClaudeSessionImagesForResume({
        repoRoot: manifest.repoRoot,
        sessionId: configuredControllerSessionId,
        maxDimension: 2000,
      });
      if (stats.changed) {
        require('fs').appendFileSync(
          require('path').join(require('os').tmpdir(), 'cc-chrome-debug.log'),
          `[${new Date().toISOString()}] sanitized claude-controller session images sessionId=${configuredControllerSessionId} replaced=${stats.replacedImages} file=${stats.filePath} backup=${stats.backupPath}\n`
        );
      }
    } catch (error) {
      try {
        require('fs').appendFileSync(
          require('path').join(require('os').tmpdir(), 'cc-chrome-debug.log'),
          `[${new Date().toISOString()}] failed to sanitize claude-controller session images sessionId=${configuredControllerSessionId} error=${error && error.message ? error.message : String(error)}\n`
        );
      } catch {}
    }
  }

  let accumulatedText = '';
  let lastAssistantMessage = '';
  let structuredOutput = null;
  let sawTextDelta = false;

  // Strip ELECTRON_RUN_AS_NODE to prevent Claude Code from running as plain Node
  const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env;

  const result = await spawnStreamingProcess({
    command: manifest.controller.bin,
    args,
    cwd: manifest.repoRoot,
    env: cleanEnv,
    stdinText: prompt,
    abortSignal,
    onStdoutLine: (line) => {
      const raw = parseJsonLine(line);
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'controller-json',
        requestId: request.id,
        loopIndex: loop.index,
        rawLine: line,
        parsed: raw,
      })).catch(() => {});

      if (!raw) {
        renderer.controller(`(unparsed claude-controller line) ${line}`);
        return;
      }

      // Discover session ID from system event
      if (raw.session_id) {
        discoveredSessionId = raw.session_id;
      }

      // Accumulate text from streaming deltas (for rendering only)
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
        if (text) lastAssistantMessage = text;
      }

      // Capture structured_output from the result event (set by --json-schema)
      if (raw.type === 'result_message' || raw.type === 'result') {
        if (raw.structured_output && typeof raw.structured_output === 'object') {
          structuredOutput = raw.structured_output;
        }
      }

      // Render controller events — use controllerEvent for streaming events,
      // skip assistant/result if we have text deltas (same logic as claude.js worker)
      if ((raw.type === 'assistant_message' || raw.type === 'assistant') && sawTextDelta) {
        return;
      }
      if ((raw.type === 'result_message' || raw.type === 'result') && sawTextDelta) {
        renderer.flushStream();
        return;
      }

      // Render as controller activity (not worker)
      renderer.claudeControllerEvent(raw);
    },
    onStderrLine: (line) => {
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'controller-stderr',
        requestId: request.id,
        loopIndex: loop.index,
        text: line,
      })).catch(() => {});
      if (!manifest.settings.quiet) {
        renderer.controller(line);
      }
    },
  });

  loop.controller.exitCode = result.code;
  loop.controller.sessionId = discoveredSessionId;
  manifest.controller.sessionId = discoveredSessionId;
  try {
    manifest.controller.lastSeenTranscriptLine = countTranscriptLinesSync(manifest.files && manifest.files.transcript);
  } catch {}

  if (result.aborted) {
    throw new Error('Claude controller process was interrupted.');
  }

  if (result.code !== 0) {
    throw new Error(`Claude controller exited with code ${result.code}. See ${loop.controller.stderrFile}`);
  }

  // Use structured_output from --json-schema (guaranteed valid JSON on resume and fresh sessions)
  if (!structuredOutput) {
    throw new Error('Claude controller did not return structured JSON output.');
  }
  const decision = validateControllerDecision(structuredOutput);
  loop.controller.decision = decision;
  request.latestControllerDecision = decision;

  return {
    prompt,
    decision,
    sessionId: discoveredSessionId,
  };
}

module.exports = {
  buildClaudeControllerArgs,
  materializeClaudeControllerLaunchFiles,
  runClaudeControllerTurn,
};
