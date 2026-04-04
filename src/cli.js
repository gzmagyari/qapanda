const path = require('node:path');

const { loadFeatureFlags } = require('./feature-flags');
const _flags = loadFeatureFlags();
const { execForText } = require('./process-utils');
const { Renderer } = require('./render');
const { printEventTail, printRunSummary, runManagerLoop, runDirectWorkerTurn } = require('./orchestrator');
const {
  defaultStateRoot,
  listRunManifests,
  loadManifestFromDir,
  lookupAgentConfig,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./state');
const { parseInteger, parseNumber, readAllStdin } = require('./utils');
const { runInteractiveShell } = require('./shell');
const {
  findResourcesDir,
  loadMergedAgents,
  loadMergedModes,
  loadMergedMcpServers,
  enabledAgents,
  enabledModes,
  resolveByEnv,
  getCliDefaults,
  loadOnboarding,
  isOnboardingComplete,
} = require('./config-loader');
const { mcpServersForRole } = require('./mcp-injector');
const { createCloudBoundary } = require('./cloud');
const { runCloudCommand, CLOUD_COMMAND_USAGE } = require('./cloud/cli-auth');

function usage() {
  return `qapanda

Commands:
  qapanda                         Start the interactive shell
  qapanda shell                   Start the interactive shell
  qapanda run <message...>        Start a new run, process until STOP, then exit
  qapanda run --print --agent dev <message>   One-shot: agent runs once, exits
  qapanda resume <run-id> [message...]  Resume or continue an existing run
  qapanda status <run-id>         Show run status
  qapanda logs <run-id> [--tail n]       Show recent events
  qapanda list                    List saved runs
  qapanda doctor                  Check health of all dependencies
  qapanda setup                   Run first-time setup wizard
  qapanda agents                  List all available agents
  qapanda modes                   List all available modes
  qapanda cloud <subcommand>      Cloud auth, identity, and hosted links

Common options:
  --repo <path>                      Project root directory
  --state-dir <path>                 State directory
  --mode <id>                        Select mode (quick-test, auto-test, quick-dev, auto-dev, auto-dev-test)
  --agent <id>                       Direct to specific agent (bypasses controller)
  --test-env <browser${_flags.enableRemoteDesktop ? '|computer' : ''}>      Test environment for modes
  --print                            One-shot: run single turn, print result, exit
  --controller-cli <codex|api${_flags.enableClaudeCli ? '|claude' : ''}>    Controller CLI backend
  --controller-model <name>          Controller model
  --controller-thinking <level>      Controller thinking (minimal/low/medium/high/xhigh)
  --worker-cli <codex|api${_flags.enableClaudeCli ? '|claude' : ''}>        Worker CLI backend
  --worker-model <name>              Worker model
  --worker-thinking <level>          Worker thinking (low/medium/high)
  --api-provider <name>              API provider (openrouter/openai/anthropic/gemini/custom)
  --api-base-url <url>               API base URL override
  --wait <delay>                     Auto-pass delay (1m, 5m, 1h, etc.)
  --no-mcp-inject                    Disable system MCP auto-injection
  --raw-events                       Show raw streaming events
  --quiet                            Minimal output

Cloud commands:
${CLOUD_COMMAND_USAGE}
`;
}

const RUN_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'codex-bin': { key: 'codexBin', kind: 'value' },
  'claude-bin': { key: 'claudeBin', kind: 'value' },
  // New flags
  'mode': { key: 'mode', kind: 'value' },
  'agent': { key: 'agent', kind: 'value' },
  'test-env': { key: 'testEnv', kind: 'value' },
  'print': { key: 'print', kind: 'boolean' },
  'no-mcp-inject': { key: 'noMcpInject', kind: 'boolean' },
  'chrome-port': { key: 'chromePort', kind: 'value' },
  'no-chrome': { key: 'noChrome', kind: 'boolean' },
  'no-desktop': { key: 'noDesktop', kind: 'boolean' },
  'no-snapshot': { key: 'noSnapshot', kind: 'boolean' },
  'wait': { key: 'wait', kind: 'value' },
  // Controller
  'controller-cli': { key: 'controllerCli', kind: 'value' },
  'controller-model': { key: 'controllerModel', kind: 'value' },
  'controller-thinking': { key: 'controllerThinking', kind: 'value' },
  'controller-profile': { key: 'controllerProfile', kind: 'value' },
  'controller-sandbox': { key: 'controllerSandbox', kind: 'value' },
  'controller-config': { key: 'controllerConfig', kind: 'list' },
  'controller-skip-git-repo-check': { key: 'controllerSkipGitRepoCheck', kind: 'boolean' },
  'controller-extra-instructions': { key: 'controllerExtraInstructions', kind: 'value' },
  // Worker
  'worker-cli': { key: 'workerCli', kind: 'value' },
  'worker-model': { key: 'workerModel', kind: 'value' },
  'worker-thinking': { key: 'workerThinking', kind: 'value' },
  'api-provider': { key: 'apiProvider', kind: 'value' },
  'api-base-url': { key: 'apiBaseUrl', kind: 'value' },
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
  'self-testing': { key: 'selfTesting', kind: 'boolean' },
};

const STATUS_SPEC = { 'state-dir': { key: 'stateRoot', kind: 'value' } };
const LOGS_SPEC = { 'state-dir': { key: 'stateRoot', kind: 'value' }, 'tail': { key: 'tail', kind: 'value' } };
const DOCTOR_SPEC = { 'codex-bin': { key: 'codexBin', kind: 'value' }, 'claude-bin': { key: 'claudeBin', kind: 'value' } };

function parseArgs(argv, spec) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') { positionals.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const name = token.slice(2);
    const definition = spec[name];
    if (!definition) throw new Error(`Unknown option: --${name}`);
    if (definition.kind === 'boolean') { options[definition.key] = true; continue; }
    const value = argv[index + 1];
    if (value == null) throw new Error(`Option --${name} requires a value.`);
    index += 1;
    if (definition.kind === 'list') {
      if (!Array.isArray(options[definition.key])) options[definition.key] = [];
      options[definition.key].push(value);
      continue;
    }
    options[definition.key] = value;
  }
  return { options, positionals };
}

function isPathLike(value) {
  if (!value) return false;
  if (path.isAbsolute(value)) return false;
  return value.includes('/') || value.startsWith('.');
}

function normalizeOptions(options) {
  return {
    ...options,
    repoRoot: options.repoRoot ? path.resolve(options.repoRoot) : process.cwd(),
    stateRoot: options.stateRoot ? path.resolve(options.stateRoot) : undefined,
    codexBin: isPathLike(options.codexBin) ? path.resolve(options.codexBin) : options.codexBin,
    claudeBin: isPathLike(options.claudeBin) ? path.resolve(options.claudeBin) : options.claudeBin,
    workerMaxTurns: parseInteger(options.workerMaxTurns, '--worker-max-turns'),
    workerMaxBudgetUsd: parseNumber(options.workerMaxBudgetUsd, '--worker-max-budget-usd'),
  };
}

async function ensureBinaryAvailable(binary) {
  const result = await execForText(binary, ['--version']);
  if (result.code !== 0) throw new Error(`Could not execute ${binary} --version. stderr:\n${result.stderr}`);
  return (result.stdout || result.stderr).trim();
}

// ── Config loading ───────────────────────────────────────────────

function loadConfig(repoRoot) {
  const resourcesDir = findResourcesDir();
  const agentsData = loadMergedAgents(repoRoot, resourcesDir);
  const modesData = loadMergedModes(repoRoot, resourcesDir);
  const mcpData = loadMergedMcpServers(repoRoot);
  const allAgents = enabledAgents(agentsData);
  const allModes = enabledModes(modesData);
  const defaults = getCliDefaults();
  const cloud = createCloudBoundary({ target: 'cli', repoRoot });
  cloud.preload().catch(() => {});
  return { agentsData, modesData, mcpData, allAgents, allModes, defaults, resourcesDir, cloud };
}

function applyApiConfigToOptions(options, agents) {
  const anyAgentUsesApi = Object.values(agents || {}).some((agent) => agent && agent.cli === 'api');
  const anyApi = options.controllerCli === 'api' || options.workerCli === 'api' || anyAgentUsesApi;
  if (!anyApi) return;

  const shared = {
    provider: options.apiProvider || (options.apiConfig && options.apiConfig.provider) || 'openrouter',
    baseURL: options.apiBaseUrl || (options.apiConfig && options.apiConfig.baseURL) || '',
  };

  options.apiConfig = { ...(options.apiConfig || {}), ...shared };

  if (options.controllerCli === 'api') {
    options.controllerApiConfig = {
      ...shared,
      model: options.controllerModel || '',
      thinking: options.controllerThinking || '',
    };
  }

  if (options.workerCli === 'api' || anyAgentUsesApi) {
    options.workerApiConfig = {
      ...shared,
      model: options.workerModel || '',
      thinking: options.workerThinking || '',
    };
  }
}

/**
 * Apply mode + agent + MCP injection to options before creating a run.
 */
function applyConfigToOptions(options, config) {
  const { allAgents, allModes, mcpData, defaults } = config;

  // Apply onboarding defaults if not explicitly set
  if (!options.controllerCli) options.controllerCli = defaults.controllerCli;
  if (!options.workerCli) options.workerCli = defaults.workerCli;

  // Apply worker thinking via env var (same as extension)
  if (options.workerThinking) {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = options.workerThinking;
  }

  // Apply mode
  let directAgent = options.agent || null;
  if (options.mode) {
    const mode = allModes[options.mode];
    if (!mode) throw new Error(`Unknown mode: ${options.mode}. Use --list-modes to see available modes.`);

    const testEnv = options.testEnv || 'browser';
    if (mode.requiresTestEnv && !options.testEnv) {
      console.error(`Mode '${options.mode}' requires --test-env (browser or computer).`);
    }

    // Set controller prompt from mode
    if (mode.controllerPrompt) {
      options.controllerSystemPrompt = resolveByEnv(mode.controllerPrompt, testEnv);
    }

    // Direct agent mode (no controller)
    if (!mode.useController) {
      directAgent = resolveByEnv(mode.defaultAgent, testEnv);
    }
  }

  // Load all agents into manifest
  options.agents = allAgents;
  applyApiConfigToOptions(options, allAgents);

  // Auto-inject system MCPs (unless disabled)
  if (!options.noMcpInject) {
    const workerMcps = mcpServersForRole('worker', {
      globalMcps: mcpData.global,
      projectMcps: mcpData.project,
      repoRoot: options.repoRoot,
      controllerCli: options.controllerCli,
      workerCli: options.workerCli,
      agents: options.agents,
    });
    const controllerMcps = mcpServersForRole('controller', {
      globalMcps: mcpData.global,
      projectMcps: mcpData.project,
      repoRoot: options.repoRoot,
      controllerCli: options.controllerCli,
      workerCli: options.workerCli,
      agents: options.agents,
    });
    options.workerMcpServers = workerMcps;
    options.controllerMcpServers = controllerMcps;
  }

  return { options, directAgent };
}

/**
 * If the target agent uses chrome-devtools MCP, auto-start Chrome and set the port.
 * Returns the chromeDebugPort to set on the manifest, or null.
 */
async function ensureChromeIfNeeded(directAgent, allAgents, options) {
  if (!directAgent) return null;
  const agent = allAgents[directAgent];
  if (!agent || !agent.mcps) return null;
  if (!agent.mcps['chrome-devtools'] && !agent.mcps['chrome_devtools']) return null;

  // Don't start Chrome for remote agents (container has its own Chrome)
  if (agent.cli && agent.cli.startsWith('qa-remote')) return null;

  // Use explicit --chrome-port if provided
  if (options.chromePort) return parseInt(options.chromePort, 10);

  // Auto-start headless Chrome
  try {
    const chromeManager = require('../extension/chrome-manager');
    const panelId = 'cli-' + Date.now();
    const result = await chromeManager.ensureChrome(panelId);
    if (result && result.port) {
      // Register cleanup on exit
      process.on('exit', () => { try { chromeManager.killChrome(panelId); } catch {} });
      process.on('SIGINT', () => { try { chromeManager.killChrome(panelId); } catch {} process.exit(130); });
      return result.port;
    }
  } catch (e) {
    console.error(`Warning: Could not start Chrome: ${e.message}`);
  }
  return null;
}

// ── Commands ─────────────────────────────────────────────────────

async function runDoctor(argv) {
  const { options } = parseArgs(argv, DOCTOR_SPEC);

  const { detectCli, detectChrome, detectDocker, detectQaDesktop } = require('../extension/onboarding');

  console.log('QA Panda Doctor\n');

  // CLIs
  if (_flags.enableClaudeCli) {
    const claude = await detectCli('claude');
    console.log(`Claude Code CLI:    ${claude.available ? '✓ ' + claude.version.split('\n')[0] : '✗ Not found'}`);
  }
  const codex = await detectCli('codex');
  console.log(`Codex CLI:          ${codex.available ? '✓ ' + codex.version.split('\n')[0] : '✗ Not found'}`);

  // Tools
  const chrome = await detectChrome();
  console.log(`Google Chrome:      ${chrome.available ? '✓ Found' : '✗ Not found'}`);
  if (_flags.enableRemoteDesktop) {
    const docker = await detectDocker();
    console.log(`Docker Desktop:     ${docker.available ? (docker.running ? '✓ Running' : '⚠ Installed but not running') : '✗ Not found'}`);
    const qaDesktop = await detectQaDesktop();
    console.log(`qa-desktop:         ${qaDesktop.available ? '✓ Available' : '✗ Not found'}`);
  }

  // Bundled tools
  const { findDetachedCommandPath, findTasksMcpPath } = require('./mcp-injector');
  console.log(`detached-command:   ${findDetachedCommandPath() ? '✓ Bundled' : '✗ Not found'}`);
  console.log(`tasks-mcp:          ${findTasksMcpPath() ? '✓ Bundled' : '✗ Not found'}`);

  // Onboarding
  const onboarding = loadOnboarding();
  if (onboarding && onboarding.completedAt) {
    console.log(`Onboarding:         ✓ Complete (preference: ${onboarding.cliPreference || 'both'})`);
  } else {
    console.log(`Onboarding:         ✗ Not complete — run: qapanda setup`);
  }
}

async function runSetup() {
  const readline = require('node:readline');
  const { detectCli, detectChrome, detectDocker, detectQaDesktop, completeOnboarding, getCliDefaults: getDefaults } = require('../extension/onboarding');
  const { readJsonFile } = require('./config-loader');

  console.log('QA Panda Setup\n');
  console.log('Detecting environment...');

  const checks = [detectCli('codex'), detectChrome()];
  if (_flags.enableClaudeCli) checks.unshift(detectCli('claude'));
  if (_flags.enableRemoteDesktop) { checks.push(detectDocker()); checks.push(detectQaDesktop()); }
  const results = await Promise.all(checks);

  let idx = 0;
  const claude = _flags.enableClaudeCli ? results[idx++] : { available: false };
  const codex = results[idx++];
  const chrome = results[idx++];
  const docker = _flags.enableRemoteDesktop ? results[idx++] : { available: false, running: false };
  const qaDesktop = _flags.enableRemoteDesktop ? results[idx++] : { available: false };

  if (_flags.enableClaudeCli) {
    console.log(`  ${claude.available ? '✓' : '✗'} Claude Code CLI ${claude.available ? claude.version.split('\n')[0] : '— not found'}`);
  }
  console.log(`  ${codex.available ? '✓' : '✗'} Codex CLI ${codex.available ? codex.version.split('\n')[0] : '— not found'}`);
  console.log(`  ${chrome.available ? '✓' : '⚠'} Google Chrome ${chrome.available ? '— found' : '— not found (browser testing unavailable)'}`);
  if (_flags.enableRemoteDesktop) {
    console.log(`  ${docker.available && docker.running ? '✓' : '⚠'} Docker Desktop ${docker.available ? (docker.running ? '— running' : '— installed but not running') : '— not found (desktop testing unavailable)'}`);
  }
  console.log('');

  const effectiveClaudeOk = _flags.enableClaudeCli && claude.available;
  if (!effectiveClaudeOk && !codex.available) {
    console.error('Error: Codex CLI not found. Install with: npm install -g @openai/codex');
    process.exit(1);
  }

  // Determine preference
  let preference = 'codex-only';
  if (_flags.enableClaudeCli && claude.available && codex.available) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    preference = await new Promise((resolve) => {
      rl.question('CLI preference? [both/claude-only/codex-only] (both): ', (answer) => {
        rl.close();
        const a = (answer || '').trim().toLowerCase();
        if (a === 'claude-only' || a === 'codex-only') resolve(a);
        else resolve('both');
      });
    });
  } else if (_flags.enableClaudeCli && claude.available) {
    preference = 'claude-only';
    console.log('Only Claude Code found — using claude-only mode.');
  } else {
    preference = 'codex-only';
    if (!_flags.enableClaudeCli) console.log('Using Codex.');
    else console.log('Only Codex found — using codex-only mode.');
  }

  // Auto-pull Docker image if Docker is running but image missing
  if (_flags.enableRemoteDesktop && docker.available && docker.running) {
    const { getImageName } = require('../qa-desktop/lib/docker');
    console.log('\nChecking Docker image...');
    const image = await getImageName(null, (msg) => console.log(`  ${msg}`));
    if (image) console.log(`  ✓ Image ready: ${image}`);
    else console.log('  ⚠ Image not available');
  }

  // Save
  const resourcesDir = findResourcesDir();
  const bundledPath = path.join(resourcesDir, 'system-agents.json');
  const bundledAgents = readJsonFile(bundledPath);
  const detected = {
    clis: { claude, codex },
    tools: { chrome, docker, qaDesktop: { available: true, version: 'bundled' } },
  };

  completeOnboarding({ preference, detected, bundledAgents });

  const defaults = getDefaults(preference);
  console.log(`\nSetup complete!`);
  console.log(`  Controller CLI: ${defaults.controllerCli}`);
  console.log(`  Worker CLI: ${defaults.workerCli}`);
  console.log(`  Saved to ~/.qpanda/onboarding.json`);
}

async function listAgentsCmd(argv) {
  const { options } = parseArgs(argv, { 'repo': { key: 'repoRoot', kind: 'value' } });
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : process.cwd();
  const { allAgents } = loadConfig(repoRoot);
  console.log('Available agents:\n');
  for (const [id, agent] of Object.entries(allAgents)) {
    console.log(`  ${id.padEnd(20)} ${(agent.name || '').padEnd(25)} cli: ${agent.cli || 'codex'}`);
  }
}

async function listModesCmd(argv) {
  const { options } = parseArgs(argv, { 'repo': { key: 'repoRoot', kind: 'value' } });
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : process.cwd();
  const { allModes } = loadConfig(repoRoot);
  console.log('Available modes:\n');
  for (const [id, mode] of Object.entries(allModes)) {
    const ctrl = mode.useController ? 'controller' : 'direct';
    const env = mode.requiresTestEnv ? ' (needs --test-env)' : '';
    console.log(`  ${id.padEnd(20)} ${(mode.name || '').padEnd(25)} ${ctrl}${env}`);
  }
}

async function runOneShot(argv) {
  const parsed = parseArgs(argv, RUN_SPEC);
  const options = normalizeOptions(parsed.options);
  let message = parsed.positionals.join(' ').trim();
  if (!message) message = (await readAllStdin()).trim();
  if (!message) throw new Error('Missing initial user message.');

  // Load config and apply mode/agent/MCP injection
  const config = loadConfig(options.repoRoot);
  await config.cloud.preload();
  const { options: enriched, directAgent } = applyConfigToOptions(options, config);

  // Verify CLIs — only check binaries that are actually configured
  const controllerIsCodex = !enriched.controllerCli || enriched.controllerCli === 'codex' || enriched.controllerCli === 'qa-remote-codex';
  const controllerIsClaude = enriched.controllerCli === 'claude' || enriched.controllerCli === 'qa-remote-claude';
  const workerIsCodex = !enriched.workerCli || enriched.workerCli === 'codex' || enriched.workerCli === 'qa-remote-codex';
  const workerIsClaude = enriched.workerCli === 'claude' || enriched.workerCli === 'qa-remote-claude';
  if (controllerIsCodex && !directAgent) {
    await ensureBinaryAvailable(enriched.codexBin || 'codex');
  }
  if (controllerIsClaude || workerIsClaude) {
    await ensureBinaryAvailable(enriched.claudeBin || 'claude');
  } else if (directAgent && workerIsCodex) {
    await ensureBinaryAvailable(enriched.codexBin || 'codex');
  }

  // Auto-start Chrome if needed (for agents with chrome-devtools MCP)
  if (!enriched.noChrome) {
    const chromePort = await ensureChromeIfNeeded(directAgent, config.allAgents, enriched);
    if (chromePort) enriched.chromeDebugPort = chromePort;
  }

  const manifest = await prepareNewRun(message, enriched);

  // Pass Chrome port to manifest for placeholder replacement in buildClaudeArgs
  if (enriched.chromeDebugPort) manifest.chromeDebugPort = enriched.chromeDebugPort;

  const renderer = new Renderer({ rawEvents: manifest.settings.rawEvents, quiet: manifest.settings.quiet });
  renderer.requestStarted(manifest.runId);

  try {
    if (directAgent || enriched.print) {
      // Direct agent mode or print mode — skip controller
      const agentId = directAgent || null;
      await runDirectWorkerTurn(manifest, renderer, { userMessage: message, agentId });
    } else {
      await runManagerLoop(manifest, renderer, { userMessage: message });
    }
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
  if (!runId) throw new Error('Missing run id for resume.');
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
  if (!runId) throw new Error('Missing run id for status.');
  const stateRoot = parsed.options.stateRoot || defaultStateRoot(process.cwd());
  const runDir = await resolveRunDir(runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  await printRunSummary(manifest);
}

async function showLogs(argv) {
  const parsed = parseArgs(argv, LOGS_SPEC);
  const runId = parsed.positionals[0];
  if (!runId) throw new Error('Missing run id for logs.');
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
  if (manifests.length === 0) { process.stdout.write(`No runs found in ${stateRoot}\n`); return; }
  for (const manifest of manifests) {
    process.stdout.write(`${manifest.runId} | ${manifest.status} | ${manifest.transcriptSummary || ''}\n`);
  }
}

// ── MCP management ───────────────────────────────────────────────

async function mcpCmd(argv) {
  const repoRoot = process.cwd();
  const mcpData = loadMergedMcpServers(repoRoot);
  const sub = argv[0];

  if (!sub || sub === 'list') {
    console.log('MCP Servers:\n');
    console.log('  Global (~/.qpanda/mcp.json):');
    const globalEntries = Object.entries(mcpData.global);
    if (globalEntries.length === 0) console.log('    (none)');
    for (const [name, s] of globalEntries) {
      console.log(`    ${name.padEnd(25)} ${s.url ? 'http' : 'stdio'}  target: ${s.target || 'both'}`);
    }
    console.log('\n  Project (.qpanda/mcp.json):');
    const projectEntries = Object.entries(mcpData.project);
    if (projectEntries.length === 0) console.log('    (none)');
    for (const [name, s] of projectEntries) {
      console.log(`    ${name.padEnd(25)} ${s.url ? 'http' : 'stdio'}  target: ${s.target || 'both'}`);
    }
    console.log('\n  Auto-injected: detached-command, cc-tasks');
    return;
  }

  if (sub === 'add') {
    const name = argv[1];
    if (!name) { console.error('Usage: qapanda mcp add <name> --command <cmd> [--args <a>] [--scope global|project] [--target both|controller|worker]'); return; }
    const opts = {};
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '--command') opts.command = argv[++i];
      else if (argv[i] === '--args') opts.args = argv[++i].split(',');
      else if (argv[i] === '--url') opts.url = argv[++i];
      else if (argv[i] === '--scope') opts.scope = argv[++i];
      else if (argv[i] === '--target') opts.target = argv[++i];
    }
    const scope = opts.scope || 'project';
    const filePath = scope === 'global' ? require('path').join(require('os').homedir(), '.qpanda', 'mcp.json') : require('path').join(repoRoot, '.qpanda', 'mcp.json');
    const data = readJsonFile(filePath);
    data[name] = {};
    if (opts.url) { data[name].type = 'http'; data[name].url = opts.url; }
    else if (opts.command) { data[name].command = opts.command; if (opts.args) data[name].args = opts.args; }
    if (opts.target) data[name].target = opts.target;
    writeJsonFile(filePath, data);
    console.log(`Added MCP server '${name}' to ${scope} config.`);
    return;
  }

  if (sub === 'delete' || sub === 'remove') {
    const name = argv[1];
    const scope = argv.includes('--scope') ? argv[argv.indexOf('--scope') + 1] : 'project';
    const filePath = scope === 'global' ? require('path').join(require('os').homedir(), '.qpanda', 'mcp.json') : require('path').join(repoRoot, '.qpanda', 'mcp.json');
    const data = readJsonFile(filePath);
    if (!data[name]) { console.error(`MCP server '${name}' not found in ${scope} config.`); return; }
    delete data[name];
    writeJsonFile(filePath, data);
    console.log(`Deleted MCP server '${name}' from ${scope} config.`);
    return;
  }

  console.log('Usage: qapanda mcp [list|add|delete]');
}

// ── Main ─────────────────────────────────────────────────────────

async function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === 'shell' || String(command).startsWith('--')) {
    const shellArgv = !command ? [] : (command === 'shell' ? rest : argv);
    const parsed = parseArgs(shellArgv, RUN_SPEC);
    await runInteractiveShell(normalizeOptions(parsed.options));
    return;
  }

  if (command === 'run') { await runOneShot(rest); return; }
  if (command === 'resume') { await resumeRun(rest); return; }
  if (command === 'status') { await showStatus(rest); return; }
  if (command === 'logs') { await showLogs(rest); return; }
  if (command === 'list') { await showList(rest); return; }
  if (command === 'doctor') { await runDoctor(rest); return; }
  if (command === 'setup') { await runSetup(); return; }
  if (command === 'agents') { await listAgentsCmd(rest); return; }
  if (command === 'modes') { await listModesCmd(rest); return; }
  if (command === 'cloud') { await runCloudCommand(rest); return; }
  if (command === 'mcp') { await mcpCmd(rest); return; }

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

module.exports = { main, parseArgs, normalizeOptions, loadConfig, applyConfigToOptions, runCloudCommand };
