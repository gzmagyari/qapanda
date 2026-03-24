#!/usr/bin/env node
/**
 * WebSocket proxy CLI — Node.js replacement for qa-remote-claude / qa-remote-codex.
 *
 * Connects to the container's /ws/raw endpoint and streams CLI output.
 *
 * Usage:
 *   node proxy.js --agent claude --remote-port 8765 [claude args...]
 *   node proxy.js --agent codex  --remote-port 8765 [codex args...]
 *
 * Or via symlink/alias:
 *   qa-remote-claude --remote-port=8765 -p "hello"
 *   qa-remote-codex  --remote-port=8765 exec -p "hello"
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');

// ── Proxy flag extraction ────────────────────────────────────────

function extractProxyFlags(argv) {
  const cfg = {
    agent: null,
    host: 'localhost',
    port: 8765,
    timeout: null,
    cwd: '/workspace',
    sessionId: null,
    forwardArgs: [],
  };

  const it = argv[Symbol.iterator]();
  for (const arg of it) {
    if (arg === '--agent') cfg.agent = it.next().value || cfg.agent;
    else if (arg.startsWith('--agent=')) cfg.agent = arg.split('=', 2)[1];
    else if (arg === '--remote-host') cfg.host = it.next().value || cfg.host;
    else if (arg.startsWith('--remote-host=')) cfg.host = arg.split('=', 2)[1];
    else if (arg === '--remote-port') cfg.port = parseInt(it.next().value || cfg.port, 10);
    else if (arg.startsWith('--remote-port=')) cfg.port = parseInt(arg.split('=', 2)[1], 10);
    else if (arg === '--remote-timeout') cfg.timeout = parseInt(it.next().value || '0', 10) || null;
    else if (arg.startsWith('--remote-timeout=')) cfg.timeout = parseInt(arg.split('=', 2)[1], 10) || null;
    else if (arg === '--remote-cwd') cfg.cwd = it.next().value || cfg.cwd;
    else if (arg.startsWith('--remote-cwd=')) cfg.cwd = arg.split('=', 2)[1];
    else if (arg === '--session-id') cfg.sessionId = it.next().value || null;
    else if (arg.startsWith('--session-id=')) cfg.sessionId = arg.split('=', 2)[1];
    else cfg.forwardArgs.push(arg);
  }

  // Auto-detect agent from binary name
  if (!cfg.agent) {
    const bin = path.basename(process.argv[1] || '');
    if (bin.includes('codex')) cfg.agent = 'codex';
    else cfg.agent = 'claude';
  }

  return cfg;
}

// ── Argv rewriting ───────────────────────────────────────────────

const CONTAINER_MCP_DIR = '/tmp/mcp-proxied';
const PATH_RE = /^(?:[A-Za-z]:[/\\]|\/)[^]*[/\\].+/;

function looksLikeFile(s) {
  if (!PATH_RE.test(s)) return false;
  try { return fs.statSync(s).isFile(); } catch { return false; }
}

function containerPath(hostPath) {
  const name = path.basename(hostPath);
  const h = crypto.createHash('sha256').update(hostPath).digest('hex').slice(0, 12);
  return `${CONTAINER_MCP_DIR}/${h}/${name}`;
}

function proxyFilesInMcpJson(configStr, files) {
  let config;
  try { config = JSON.parse(configStr); } catch { return configStr; }
  const servers = config.mcpServers || {};
  let changed = false;
  for (const server of Object.values(servers)) {
    if (!server || !Array.isArray(server.args)) continue;
    server.args = server.args.map(arg => {
      if (typeof arg === 'string' && looksLikeFile(arg)) {
        const cpath = containerPath(arg);
        try { files[cpath] = fs.readFileSync(arg, 'utf8'); changed = true; return cpath; }
        catch { return arg; }
      }
      return arg;
    });
  }
  return changed ? JSON.stringify(config) : configStr;
}

function proxyFilesInTomlArgs(val, files) {
  const m = val.trim().match(/^\[(.+)\]$/);
  if (!m) return val;
  const elements = m[1].match(/"([^"]*)"/g);
  if (!elements) return val;
  let changed = false;
  const newElements = elements.map(e => {
    const inner = e.slice(1, -1);
    if (looksLikeFile(inner)) {
      const cpath = containerPath(inner);
      try { files[cpath] = fs.readFileSync(inner, 'utf8'); changed = true; return `"${cpath}"`; }
      catch { return e; }
    }
    return e;
  });
  return changed ? `[${newElements.join(', ')}]` : val;
}

function rewriteArgv(argv) {
  const cleaned = [];
  let outputLastMessage = null;
  const files = {};

  const it = argv[Symbol.iterator]();
  for (const arg of it) {
    if (arg === '--output-last-message') {
      outputLastMessage = it.next().value || null;
    } else if (arg.startsWith('--output-last-message=')) {
      outputLastMessage = arg.split('=', 2)[1];
    } else if (arg === '--cd') {
      it.next(); // consume and discard
    } else if (arg.startsWith('--cd=')) {
      // discard
    } else if (arg === '-c') {
      const val = it.next().value || '';
      const m = val.match(/^(mcp_servers\.\S+\.args)=(.+)$/);
      if (m) {
        const rewritten = proxyFilesInTomlArgs(m[2], files);
        cleaned.push('-c', `${m[1]}=${rewritten}`);
      } else {
        cleaned.push('-c', val);
      }
    } else if (arg === '--mcp-config') {
      const val = it.next().value || '{}';
      cleaned.push('--mcp-config', proxyFilesInMcpJson(val, files));
    } else if (arg.startsWith('--mcp-config=')) {
      const val = arg.split('=', 2)[1];
      cleaned.push('--mcp-config', proxyFilesInMcpJson(val, files));
    } else {
      cleaned.push(arg);
    }
  }

  return { argv: cleaned, outputLastMessage, files };
}

// ── Container MCP injection ──────────────────────────────────────

function injectContainerMcps(argv, agent) {
  const CONTAINER_MCP_CONFIG = '/opt/qa-agent/config/claude.mcp.json';

  if (agent === 'claude' || argv[0] === 'claude') {
    argv.push('--mcp-config', CONTAINER_MCP_CONFIG);
  }
  // For codex, container MCPs are already baked into the image config
  // The Python proxy reads the host config file for this, but the container
  // entrypoint already sets up MCPs via supervisord
  return argv;
}

// ── WebSocket passthrough ────────────────────────────────────────

function passthrough(cfg) {
  return new Promise((resolve) => {
    const fullArgv = [cfg.agent, ...cfg.forwardArgs];
    const rw = rewriteArgv(fullArgv);
    const argv = injectContainerMcps(rw.argv, cfg.agent);

    const payload = { argv, cwd: cfg.cwd };
    if (cfg.timeout) payload.timeout_seconds = cfg.timeout;
    if (rw.files && Object.keys(rw.files).length > 0) payload.files = rw.files;
    if (cfg.sessionId) payload.session_id = cfg.sessionId;

    // Read stdin if piped
    if (!process.stdin.isTTY) {
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => {
        const stdinText = Buffer.concat(chunks).toString('utf8');
        if (stdinText) payload.stdin = stdinText;
        connect(payload, rw.outputLastMessage);
      });
    } else {
      connect(payload, rw.outputLastMessage);
    }

    let exitCode = 1;
    let cancelled = false;
    let ws = null;

    function connect(payload, outputLastMessage) {
      const uri = `ws://${cfg.host}:${cfg.port}/ws/raw`;
      ws = new WebSocket(uri, { maxPayload: 100 * 1024 * 1024 });

      let lastAgentMessage = '';

      ws.on('open', () => {
        ws.send(JSON.stringify(payload));
      });

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        const type = msg.type || '';

        if (type === 'stream.text') {
          const target = msg.stream === 'stderr' ? process.stderr : process.stdout;
          target.write(msg.text || '');
        } else if (type === 'agent.event') {
          const event = msg.event;
          const target = msg.stream === 'stderr' ? process.stderr : process.stdout;
          target.write(JSON.stringify(event) + '\n');
          // Track last agent message for --output-last-message
          if (outputLastMessage) {
            const etype = event && event.type || '';
            if (etype === 'item.started' || etype === 'item.completed') {
              const item = event.item || {};
              if (item.type === 'agent_message' && item.text) {
                lastAgentMessage = item.text;
              }
            }
          }
        } else if (type === 'run.completed') {
          exitCode = msg.exit_code || 0;
          // Write captured last message to local file
          if (outputLastMessage && lastAgentMessage) {
            try {
              fs.mkdirSync(path.dirname(outputLastMessage), { recursive: true });
              fs.writeFileSync(outputLastMessage, lastAgentMessage, 'utf8');
            } catch (e) {
              process.stderr.write(`Warning: could not write --output-last-message: ${e.message}\n`);
            }
          }
          ws.close();
        } else if (type === 'error') {
          process.stderr.write((msg.message || 'Unknown error') + '\n');
          exitCode = 1;
          ws.close();
        } else if (type === 'run.cancel_requested') {
          process.stderr.write('Remote process cancelled.\n');
          ws.close();
        } else if (type === 'run.timed_out') {
          process.stderr.write(`Remote process timed out after ${msg.timeout_seconds}s.\n`);
          ws.close();
        }
        // queue.waiting, run.started — silently ignored
      });

      ws.on('close', () => {
        resolve(exitCode);
      });

      ws.on('error', (err) => {
        if (!cancelled) {
          process.stderr.write(`Error: Cannot connect to ws://${cfg.host}:${cfg.port}/ws/raw — is the container running?\n${err.message}\n`);
        }
        resolve(1);
      });
    }

    // Signal handling: Ctrl+C → cancel, second Ctrl+C → force exit
    let ctrlcCount = 0;
    process.on('SIGINT', () => {
      ctrlcCount++;
      if (ctrlcCount >= 2) process.exit(130);
      cancelled = true;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel' }));
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const cfg = extractProxyFlags(process.argv.slice(2));
  const exitCode = await passthrough(cfg);
  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = { extractProxyFlags, rewriteArgv, injectContainerMcps, passthrough };
