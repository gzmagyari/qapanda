const { readText, writeText, parsePossiblyFencedJson } = require('./utils');
const { spawnStreamingProcess } = require('./process-utils');

const MCP_STARTUP_TIMEOUT_SEC = 30;
const { parseJsonLine } = require('./events');
const { buildControllerPrompt } = require('./prompts');
const { validateControllerDecision } = require('./schema');

function buildCodexArgs(manifest, loop) {
  const args = ['exec'];
  const isResume = !!manifest.controller.sessionId;

  if (isResume) {
    args.push('resume', manifest.controller.sessionId);
  }

  if (!isResume) {
    args.push(
      '--cd',
      manifest.repoRoot,
      '--color',
      'never',
      '--output-schema',
      manifest.controller.schemaFile,
    );

    if (manifest.controller.profile) {
      args.push('--profile', manifest.controller.profile);
    }
  }

  args.push(
    '--dangerously-bypass-approvals-and-sandbox',
    '--json',
    '--output-last-message',
    loop.controller.finalFile,
  );

  if (manifest.controller.model) {
    args.push('--model', manifest.controller.model);
  }

  if (!isResume && manifest.controller.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }

  for (const entry of manifest.controller.config || []) {
    args.push('--config', entry);
  }

  // Pass MCP servers via -c config overrides (prefer role-specific, fall back to shared)
  const controllerMcp = manifest.controllerMcpServers || manifest.mcpServers || {};
  // Escape backslashes for TOML string values (Windows paths)
  const tomlEsc = (s) => s.replace(/\\/g, '\\\\');
  for (const [name, server] of Object.entries(controllerMcp)) {
    if (!server) continue;
    // Codex uses underscores in MCP names (not hyphens)
    const codexName = name.replace(/-/g, '_');
    // HTTP MCP servers
    if (server.url) {
      args.push('-c', `mcp_servers.${codexName}.url="${tomlEsc(server.url)}"`);
      args.push('-c', `mcp_servers.${codexName}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
      continue;
    }
    // Stdio MCP servers
    if (!server.command) continue;
    args.push('-c', `mcp_servers.${codexName}.command="${tomlEsc(server.command)}"`);
    if (Array.isArray(server.args) && server.args.length > 0) {
      const argsToml = `[${server.args.map(a => `"${tomlEsc(a)}"`).join(', ')}]`;
      args.push('-c', `mcp_servers.${codexName}.args=${argsToml}`);
    }
    if (server.env && typeof server.env === 'object') {
      for (const [key, val] of Object.entries(server.env)) {
        args.push('-c', `mcp_servers.${codexName}.env.${key}="${tomlEsc(val)}"`);
      }
    }
    args.push('-c', `mcp_servers.${codexName}.startup_timeout_sec=${MCP_STARTUP_TIMEOUT_SEC}`);
  }

  // Disable built-in shell when detached-command MCP is available (prevents session hangs)
  if (controllerMcp['detached-command']) {
    args.push('-c', 'features.shell_tool=false');
  }

  args.push('-');
  return args;
}

async function runControllerTurn({ manifest, request, loop, renderer, emitEvent, abortSignal }) {
  const prompt = buildControllerPrompt(manifest, request);
  await writeText(loop.controller.promptFile, `${prompt}\n`);

  const args = buildCodexArgs(manifest, loop);
  let discoveredSessionId = manifest.controller.sessionId;

  // Strip ELECTRON_RUN_AS_NODE and use a clean CODEX_HOME with auth but no MCPs
  // so only our explicitly passed MCP servers are loaded (not kanban, memory, etc. from config.toml)
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env;
  const codexHome = path.join(os.tmpdir(), 'cc-codex-controller-home');
  const realCodexHome = path.join(os.homedir(), '.codex');
  try {
    fs.mkdirSync(codexHome, { recursive: true });
    // Copy auth files but not config.toml (which has MCP definitions)
    for (const f of ['auth.json', 'cap_sid']) {
      const src = path.join(realCodexHome, f);
      const dst = path.join(codexHome, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
  } catch {}
  cleanEnv.CODEX_HOME = codexHome;

  const result = await spawnStreamingProcess({
    command: manifest.controller.bin,
    args,
    cwd: manifest.repoRoot,
    stdinText: prompt,
    abortSignal,
    env: cleanEnv,
    onStdoutLine: (line) => {
      const raw = parseJsonLine(line);
      if (raw && raw.type === 'thread.started' && raw.thread_id) {
        discoveredSessionId = raw.thread_id;
      }
      Promise.resolve(emitEvent({
        ts: new Date().toISOString(),
        source: 'controller-json',
        requestId: request.id,
        loopIndex: loop.index,
        rawLine: line,
        parsed: raw,
      })).catch(() => {});
      if (raw) {
        renderer.controllerEvent(raw);
      } else {
        renderer.controller(`(unparsed codex line) ${line}`);
      }
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
  // Track how far the controller has seen in chat.jsonl for incremental transcript on resume
  try {
    const chatLogFile = manifest.files && manifest.files.chatLog;
    if (chatLogFile && require('node:fs').existsSync(chatLogFile)) {
      const lineCount = require('node:fs').readFileSync(chatLogFile, 'utf8').trim().split('\n').length;
      manifest.controller.lastSeenChatLine = lineCount;
    }
  } catch {}


  if (result.aborted) {
    throw new Error('Codex controller process was interrupted.');
  }

  if (result.code !== 0) {
    throw new Error(`Codex controller exited with code ${result.code}. See ${loop.controller.stderrFile}`);
  }

  const finalText = await readText(loop.controller.finalFile);
  const decision = validateControllerDecision(parsePossiblyFencedJson(finalText));
  loop.controller.decision = decision;
  request.latestControllerDecision = decision;

  return {
    prompt,
    decision,
    sessionId: discoveredSessionId,
  };
}

module.exports = {
  buildCodexArgs,
  runControllerTurn,
};
