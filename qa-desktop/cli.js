#!/usr/bin/env node
/**
 * qa-desktop CLI — Node.js replacement for the Python qa-desktop CLI.
 * Manages Docker container instances for QA Agent Desktop.
 *
 * Usage:
 *   node cli.js up [NAME] --workspace PATH [--no-snapshot] [--json]
 *   node cli.js down NAME
 *   node cli.js ls [--json]
 *   node cli.js snapshot NAME [--workspace PATH] [--json]
 *   node cli.js snapshot-delete NAME [--workspace PATH]
 *   node cli.js snapshot-exists [--workspace PATH] [--json]
 */
const os = require('node:os');
const path = require('node:path');
const { findFreePorts } = require('./lib/ports');
const { LABEL, LABEL_API_PORT, LABEL_VNC_PORT, LABEL_NOVNC_PORT, CONTAINER_API_PORT, CONTAINER_VNC_PORT, CONTAINER_NOVNC_PORT } = require('./lib/labels');
const { docker, listInstances, findInstance, getImageName, stopContainer, removeVolume, createVolume, commitContainer, removeImage } = require('./lib/docker');
const { waitForHealth } = require('./lib/health');
const { snapshotTagForWorkspace, snapshotExists } = require('./lib/snapshot');
const { volumeName, startSync, stopSync, getSyncStatus } = require('./lib/mutagen');

// ── Arg parsing ──────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const positionals = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [key, ...valParts] = arg.slice(2).split('=');
      const camelKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (valParts.length > 0) {
        flags[camelKey] = valParts.join('=');
      } else if (key.startsWith('no-')) {
        flags[key.slice(3).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = false;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[camelKey] = args[++i];
      } else {
        flags[camelKey] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, flags };
}

// ── Commands ─────────────────────────────────────────────────────

async function cmdUp({ positionals, flags }) {
  const name = positionals[0] || 'default';
  const workspace = flags.workspace || '';
  const useJson = flags.json === true;
  const noSnapshot = flags.snapshot === false;

  // Check if already running
  const existing = await findInstance(name);
  if (existing) {
    const result = { name: existing.name, container_id: existing.containerId, api_port: existing.apiPort, vnc_port: existing.vncPort, novnc_port: existing.novncPort, status: 'existing' };
    if (useJson) console.log(JSON.stringify(result));
    else {
      console.log(`Instance '${name}' already running.`);
      console.log(`  API:    ws://localhost:${existing.apiPort}/ws/raw`);
      console.log(`  noVNC:  http://localhost:${existing.novncPort}/vnc.html?autoconnect=true&resize=scale`);
    }
    return;
  }

  const [apiPort, vncPort, novncPort] = await findFreePorts(3);
  const containerName = `qa-desktop-${name}`;

  // Check for snapshot
  let snapshotTag = null;
  let image = null;
  if (!noSnapshot && workspace) {
    const snap = await snapshotExists(workspace);
    if (snap.exists) snapshotTag = snap.tag;
  }
  image = await getImageName(snapshotTag ? snapshotTagForWorkspace(workspace) : null, (msg) => {
    if (!useJson) console.error(msg);
  });
  if (!image) {
    console.error('Docker image not found and auto-pull failed. Is Docker running?');
    process.exit(1);
  }

  // Get environment from host
  const hostHome = os.homedir();
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  // Create workspace volume
  const volName = volumeName(name);
  await createVolume(volName);

  // Build docker run args
  const dockerArgs = [
    'run', '-d',
    '--name', containerName,
    '--shm-size', '2g',
    '--tty',
    '--label', `${LABEL}=true`,
    '--label', `${LABEL_API_PORT}=${apiPort}`,
    '--label', `${LABEL_VNC_PORT}=${vncPort}`,
    '--label', `${LABEL_NOVNC_PORT}=${novncPort}`,
    '-p', `127.0.0.1:${apiPort}:${CONTAINER_API_PORT}`,
    '-p', `127.0.0.1:${vncPort}:${CONTAINER_VNC_PORT}`,
    '-p', `127.0.0.1:${novncPort}:${CONTAINER_NOVNC_PORT}`,
    '-v', `${hostHome}:/host-home:ro`,
    '-v', `${volName}:/workspace`,
    '-e', 'HOME=/home/agent',
    '-e', 'USER=agent',
    '-e', 'DISPLAY=:1',
    '-e', 'WORKSPACE_DIR=/workspace',
    '-e', 'TZ=UTC',
    '-e', 'VNC_PASSWORD=secret',
    '-e', 'SCREEN_WIDTH=1920',
    '-e', 'SCREEN_HEIGHT=1080',
    '-e', 'SCREEN_DEPTH=24',
    '-e', 'VNC_PORT=5901',
    '-e', 'NOVNC_PORT=6080',
    '-e', 'API_PORT=8765',
    '-e', 'MAX_CONCURRENT_RUNS=2',
    '-e', `OPENAI_API_KEY=${openaiKey}`,
    '-e', `ANTHROPIC_API_KEY=${anthropicKey}`,
    '-e', 'CLAUDE_MCP_CONFIG=/opt/qa-agent/config/claude.mcp.json',
    '-e', 'QA_PROMPT_FILE=/opt/qa-agent/prompts/qa-engineer.md',
    '-e', 'COMPUTER_CONTROL_MCP_SCREENSHOT_DIR=/home/agent/Downloads/screenshots',
    '--health-cmd', `curl -fsS http://localhost:${CONTAINER_API_PORT}/healthz`,
    '--health-interval', '30s',
    '--health-timeout', '5s',
    '--health-retries', '5',
    '--health-start-period', '60s',
    '--restart', 'unless-stopped',
    image,
  ];

  const result = await docker(dockerArgs, { timeout: 60000 });
  if (result.code !== 0) {
    console.error(`Failed to start instance:\n${result.stderr}`);
    await removeVolume(volName);
    process.exit(1);
  }

  const containerId = result.stdout.slice(0, 12);

  // Start Mutagen sync
  let syncOk = false;
  if (workspace) {
    try { syncOk = await startSync(name, workspace, containerName); } catch {}
  }

  if (useJson) {
    console.log(JSON.stringify({
      name, container_id: containerId, api_port: apiPort, vnc_port: vncPort, novnc_port: novncPort,
      status: 'started', snapshot: !!snapshotTag, image, sync: syncOk ? 'active' : 'none',
    }));
  } else {
    console.log(`Instance '${name}' started (${containerId})`);
    console.log(`  API:    ws://localhost:${apiPort}/ws/raw`);
    console.log(`  noVNC:  http://localhost:${novncPort}/vnc.html?autoconnect=true&resize=scale`);
    console.log(`  VNC:    localhost:${vncPort}`);
    if (syncOk) console.log(`  Sync:   active`);
  }
}

async function cmdDown({ positionals }) {
  const name = positionals[0];
  if (!name) { console.error('Usage: qa-desktop down NAME'); process.exit(1); }

  const inst = await findInstance(name);
  if (!inst) { console.error(`Instance '${name}' not found.`); process.exit(1); }

  await stopSync(inst.name);
  await stopContainer(`qa-desktop-${inst.name}`);
  await removeVolume(volumeName(inst.name));
  console.log(`Instance '${inst.name}' stopped and removed.`);
}

async function cmdLs({ flags }) {
  const useJson = flags.json === true;
  const instances = await listInstances();

  if (useJson) {
    const data = [];
    for (const inst of instances) {
      const sync = await getSyncStatus(inst.name);
      data.push({ name: inst.name, container_id: inst.containerId, api_port: inst.apiPort, vnc_port: inst.vncPort, novnc_port: inst.novncPort, status: inst.status, sync });
    }
    console.log(JSON.stringify(data));
    return;
  }

  if (instances.length === 0) { console.log('No instances running.'); return; }
  console.log(`${'NAME'.padEnd(20)} ${'STATUS'.padEnd(20)} ${'API'.padEnd(7)} ${'NOVNC'.padEnd(7)} ${'VNC'.padEnd(7)}`);
  console.log('-'.repeat(61));
  for (const inst of instances) {
    const status = inst.status.split('(')[0].trim();
    console.log(`${inst.name.padEnd(20)} ${status.padEnd(20)} ${String(inst.apiPort).padEnd(7)} ${String(inst.novncPort).padEnd(7)} ${String(inst.vncPort).padEnd(7)}`);
  }
}

async function cmdSnapshot({ positionals, flags }) {
  const name = positionals[0];
  if (!name) { console.error('Usage: qa-desktop snapshot NAME [--workspace PATH]'); process.exit(1); }

  const inst = await findInstance(name);
  if (!inst) { console.error(`Instance '${name}' not found.`); process.exit(1); }

  const workspace = flags.workspace || '';
  const useJson = flags.json === true;
  const tag = workspace ? `${snapshotTagForWorkspace(workspace)}:latest` : `qa-snapshot-${name}:latest`;

  // Write snapshot marker inside container so entrypoint skips slow chown
  await docker(['exec', `qa-desktop-${name}`, 'touch', '/root/.qa-snapshot']);

  await commitContainer(`qa-desktop-${name}`, tag);

  if (useJson) console.log(JSON.stringify({ name, tag, status: 'created' }));
  else console.log(`Snapshot created: ${tag}`);
}

async function cmdSnapshotDelete({ positionals, flags }) {
  const name = positionals[0];
  const workspace = flags.workspace || '';
  const tag = workspace ? `${snapshotTagForWorkspace(workspace)}:latest` : `qa-snapshot-${name}:latest`;

  try {
    await removeImage(tag);
    console.log(`Snapshot deleted: ${tag}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

async function cmdSnapshotExists({ flags }) {
  const workspace = flags.workspace || '';
  const useJson = flags.json === true;

  if (!workspace) { console.error('Usage: qa-desktop snapshot-exists --workspace PATH'); process.exit(1); }

  const result = await snapshotExists(workspace);
  if (useJson) console.log(JSON.stringify(result));
  else console.log(result.exists ? `Snapshot exists: ${result.tag}` : 'No snapshot found.');
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const parsed = parseArgs(process.argv);

  const commands = {
    up: cmdUp,
    down: cmdDown,
    ls: cmdLs,
    snapshot: cmdSnapshot,
    'snapshot-delete': cmdSnapshotDelete,
    'snapshot-exists': cmdSnapshotExists,
  };

  const handler = commands[parsed.command];
  if (!handler) {
    console.log('Usage: qa-desktop <command> [options]');
    console.log('Commands: up, down, ls, snapshot, snapshot-delete, snapshot-exists');
    process.exit(parsed.command === 'help' ? 0 : 1);
  }

  try {
    await handler(parsed);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}

// Only run when invoked directly (not when required as module)
if (require.main === module) {
  main();
}

module.exports = { cmdUp, cmdDown, cmdLs, cmdSnapshot, cmdSnapshotDelete, cmdSnapshotExists, parseArgs };
