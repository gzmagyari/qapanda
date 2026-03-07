const path = require('node:path');

const { execForText } = require('./process-utils');
const { Renderer } = require('./render');
const { printEventTail, printRunSummary, runManagerLoop } = require('./orchestrator');
const {
  defaultStateRoot,
  listRunManifests,
  loadManifestFromDir,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./state');
const { parseInteger, parseNumber, readAllStdin } = require('./utils');
const { runInteractiveShell } = require('./shell');

function usage() {
  return `cc-manager

Commands:
  cc-manager                       Start the interactive shell
  cc-manager shell                 Start the interactive shell
  cc-manager run <message...>      Start a new run, process until STOP, then exit
  cc-manager resume <run-id> [message...]  Resume or continue an existing run
  cc-manager status <run-id>       Show run status
  cc-manager logs <run-id> [--tail n]      Show recent events
  cc-manager list                  List saved runs
  cc-manager doctor                Verify codex and claude binaries

Common options:
  --repo <path>
  --state-dir <path>
  --codex-bin <path>
  --claude-bin <path>
  --controller-model <name>
  --controller-profile <name>
  --controller-sandbox <read-only|workspace-write|danger-full-access>
  --controller-config <key=value>          repeatable
  --controller-skip-git-repo-check
  --controller-extra-instructions <text>
  --worker-model <name>
  --worker-session-id <uuid>
  --worker-allowed-tools <rules>
  --worker-tools <rules>
  --worker-disallowed-tools <rules>
  --worker-permission-prompt-tool <name>
  --worker-max-turns <n>
  --worker-max-budget-usd <amount>
  --worker-add-dir <path>                  repeatable
  --worker-append-system-prompt <text>
  --raw-events
  --quiet
`;
}

const RUN_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'codex-bin': { key: 'codexBin', kind: 'value' },
  'claude-bin': { key: 'claudeBin', kind: 'value' },
  'controller-model': { key: 'controllerModel', kind: 'value' },
  'controller-profile': { key: 'controllerProfile', kind: 'value' },
  'controller-sandbox': { key: 'controllerSandbox', kind: 'value' },
  'controller-config': { key: 'controllerConfig', kind: 'list' },
  'controller-skip-git-repo-check': { key: 'controllerSkipGitRepoCheck', kind: 'boolean' },
  'controller-extra-instructions': { key: 'controllerExtraInstructions', kind: 'value' },
  'worker-model': { key: 'workerModel', kind: 'value' },
  'worker-session-id': { key: 'workerSessionId', kind: 'value' },
  'worker-allowed-tools': { key: 'workerAllowedTools', kind: 'value' },
  'worker-tools': { key: 'workerTools', kind: 'value' },
  'worker-disallowed-tools': { key: 'workerDisallowedTools', kind: 'value' },
  'worker-permission-prompt-tool': { key: 'workerPermissionPromptTool', kind: 'value' },
  'worker-max-turns': { key: 'workerMaxTurns', kind: 'value' },
  'worker-max-budget-usd': { key: 'workerMaxBudgetUsd', kind: 'value' },
  'worker-add-dir': { key: 'workerAddDir', kind: 'list' },
  'worker-append-system-prompt': { key: 'workerAppendSystemPrompt', kind: 'value' },
  'raw-events': { key: 'rawEvents', kind: 'boolean' },
  'quiet': { key: 'quiet', kind: 'boolean' },
};

const STATUS_SPEC = {
  'state-dir': { key: 'stateRoot', kind: 'value' },
};

const LOGS_SPEC = {
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'tail': { key: 'tail', kind: 'value' },
};

const DOCTOR_SPEC = {
  'codex-bin': { key: 'codexBin', kind: 'value' },
  'claude-bin': { key: 'claudeBin', kind: 'value' },
};

function parseArgs(argv, spec) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const definition = spec[name];
    if (!definition) {
      throw new Error(`Unknown option: --${name}`);
    }
    if (definition.kind === 'boolean') {
      options[definition.key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null) {
      throw new Error(`Option --${name} requires a value.`);
    }
    index += 1;
    if (definition.kind === 'list') {
      if (!Array.isArray(options[definition.key])) {
        options[definition.key] = [];
      }
      options[definition.key].push(value);
      continue;
    }
    options[definition.key] = value;
  }

  return { options, positionals };
}

function normalizeOptions(options) {
  return {
    ...options,
    repoRoot: options.repoRoot ? path.resolve(options.repoRoot) : process.cwd(),
    stateRoot: options.stateRoot ? path.resolve(options.stateRoot) : undefined,
    workerMaxTurns: parseInteger(options.workerMaxTurns, '--worker-max-turns'),
    workerMaxBudgetUsd: parseNumber(options.workerMaxBudgetUsd, '--worker-max-budget-usd'),
  };
}

async function ensureBinaryAvailable(binary) {
  const result = await execForText(binary, ['--version']);
  if (result.code !== 0) {
    throw new Error(`Could not execute ${binary} --version. stderr:\n${result.stderr}`);
  }
  return (result.stdout || result.stderr).trim();
}

async function runDoctor(argv) {
  const { options } = parseArgs(argv, DOCTOR_SPEC);
  const codexBin = options.codexBin || 'codex';
  const claudeBin = options.claudeBin || 'claude';
  const codexVersion = await ensureBinaryAvailable(codexBin);
  const claudeVersion = await ensureBinaryAvailable(claudeBin);
  process.stdout.write(`codex: ${codexVersion}\n`);
  process.stdout.write(`claude: ${claudeVersion}\n`);
}

async function runOneShot(argv) {
  const parsed = parseArgs(argv, RUN_SPEC);
  const options = normalizeOptions(parsed.options);
  let message = parsed.positionals.join(' ').trim();
  if (!message) {
    message = (await readAllStdin()).trim();
  }
  if (!message) {
    throw new Error('Missing initial user message.');
  }

  await ensureBinaryAvailable(options.codexBin || 'codex');
  await ensureBinaryAvailable(options.claudeBin || 'claude');

  const manifest = await prepareNewRun(message, options);
  const renderer = new Renderer({ rawEvents: manifest.settings.rawEvents, quiet: manifest.settings.quiet });
  renderer.requestStarted(manifest.runId);
  try {
    await runManagerLoop(manifest, renderer, { userMessage: message });
  } finally {
    renderer.close();
    await saveManifest(manifest);
  }
  await printRunSummary(manifest);
}

async function resumeRun(argv) {
  const parsed = parseArgs(argv, RUN_SPEC);
  const options = normalizeOptions(parsed.options);
  const runId = parsed.positionals[0];
  if (!runId) {
    throw new Error('Missing run id for resume.');
  }
  const message = parsed.positionals.slice(1).join(' ').trim();
  const stateRoot = options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd());
  const runDir = await resolveRunDir(runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  const renderer = new Renderer({ rawEvents: manifest.settings.rawEvents, quiet: manifest.settings.quiet });
  renderer.requestStarted(manifest.runId);
  try {
    if (message) {
      await runManagerLoop(manifest, renderer, { userMessage: message });
    } else {
      await runManagerLoop(manifest, renderer, {});
    }
  } finally {
    renderer.close();
    await saveManifest(manifest);
  }
  await printRunSummary(manifest);
}

async function showStatus(argv) {
  const parsed = parseArgs(argv, STATUS_SPEC);
  const runId = parsed.positionals[0];
  if (!runId) {
    throw new Error('Missing run id for status.');
  }
  const stateRoot = parsed.options.stateRoot || defaultStateRoot(process.cwd());
  const runDir = await resolveRunDir(runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  await printRunSummary(manifest);
}

async function showLogs(argv) {
  const parsed = parseArgs(argv, LOGS_SPEC);
  const runId = parsed.positionals[0];
  if (!runId) {
    throw new Error('Missing run id for logs.');
  }
  const stateRoot = parsed.options.stateRoot || defaultStateRoot(process.cwd());
  const tail = parseInteger(parsed.options.tail, '--tail') || 40;
  const runDir = await resolveRunDir(runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  await printEventTail(manifest, tail);
}

async function showList(argv) {
  const parsed = parseArgs(argv, STATUS_SPEC);
  const stateRoot = parsed.options.stateRoot || defaultStateRoot(process.cwd());
  const manifests = await listRunManifests(stateRoot);
  if (manifests.length === 0) {
    process.stdout.write(`No runs found in ${stateRoot}\n`);
    return;
  }
  for (const manifest of manifests) {
    process.stdout.write(`${manifest.runId} | ${manifest.status} | ${manifest.transcriptSummary || ''}\n`);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'shell' || String(command).startsWith('--')) {
    const shellArgv = !command ? [] : (command === 'shell' ? rest : argv);
    const parsed = parseArgs(shellArgv, RUN_SPEC);
    await runInteractiveShell(normalizeOptions(parsed.options));
    return;
  }

  if (command === 'run') {
    await runOneShot(rest);
    return;
  }

  if (command === 'resume') {
    await resumeRun(rest);
    return;
  }

  if (command === 'status') {
    await showStatus(rest);
    return;
  }

  if (command === 'logs') {
    await showLogs(rest);
    return;
  }

  if (command === 'list') {
    await showList(rest);
    return;
  }

  if (command === 'doctor') {
    await runDoctor(rest);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

module.exports = {
  main,
};
