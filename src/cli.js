const path = require('node:path');

const { loadFeatureFlags } = require('./feature-flags');
const _flags = loadFeatureFlags(null, process.cwd());
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
  discoverExternalChatSessions,
} = require('./external-chat-discovery');
const {
  importExternalChatSession,
} = require('./external-chat-import');
const {
  searchExternalChatSessions,
} = require('./external-chat-search');
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
const {
  bindResumeAlias,
  createRepoRootDescriptor,
  ensureNamedWorkspace,
  resolveResumeToken,
} = require('./named-workspaces');
const { createCloudBoundary } = require('./cloud');
const { runCloudCommand, CLOUD_COMMAND_USAGE } = require('./cloud/cli-auth');
const {
  createHostedWorkflowRedactor,
  materializeHostedWorkflowRun,
  redactHostedWorkflowValue,
  sanitizeHostedWorkflowCloudRunSpec,
  setHostedWorkflowExecutionContext,
} = require('./cloud/workflow-hosted-runs');
const {
  CLOUD_RUN_ARG_SPEC,
  buildCloudRunOptions,
  createCloudRunEventBridge,
  emitCloudRunRawEvent,
  loadCloudRunSpec,
  writeCloudRunArtifacts,
} = require('./cloud-run');

function usage() {
  return `qapanda

Commands:
  qapanda                         Start the interactive shell
  qapanda shell                   Start the interactive shell
  qapanda run <message...>        Start a new run, process until STOP, then exit
  qapanda import-chat             Import a Codex or Claude chat into a new QA Panda run
  qapanda test list               List tracked Panda prompt tests
  qapanda test run [path-or-glob ...]
                                  Run tracked Panda prompt tests
  qapanda run --print --agent dev <message>   One-shot: agent runs once, exits
  qapanda resume <run-id-or-alias> [message...]  Resume or continue an existing run
  qapanda status <run-id>         Show run status
  qapanda logs <run-id> [--tail n]       Show recent events
  qapanda list                    List saved runs
  qapanda doctor                  Check health of all dependencies
  qapanda setup                   Run first-time setup wizard
  qapanda agents                  List all available agents
  qapanda modes                   List all available modes
  qapanda cloud <subcommand>      Cloud auth, identity, and hosted links
  qapanda cloud-run --spec <file> --raw-events
                                  Execute a versioned cloud-run spec file

Common options:
  --repo <path>                      Project root directory
  --workspace <name>                 Named QA Panda workspace
  --state-dir <path>                 State directory
  --resume <run-id-or-alias>         Resume an existing run or alias
  --save-resume-as <alias>           Save this run under a resume alias
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
  --api-provider <name>              API provider (built-in or named custom provider from Settings)
  --api-base-url <url>               Legacy/manual API base URL override
  --wait <delay>                     Auto-pass delay (1m, 5m, 1h, etc.)
  --no-mcp-inject                    Disable system MCP auto-injection
  --raw-events                       Show raw streaming events
  --quiet                            Minimal output

Panda test options:
  --id <id>                          Select Panda tests by source id (repeatable)
  --tag <tag>                        Select Panda tests by tag (repeatable; OR semantics)
  --reporter <human|json|junit|ndjson>
  --output <path>                    Write JSON/JUnit/NDJSON output to a file
  --fail-fast                        Stop after the first failed/error Panda test
  --agent <id>                       Override the Panda test agent (defaults to QA-Browser)

Cloud commands:
${CLOUD_COMMAND_USAGE}
`;
}

const RUN_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'workspace': { key: 'workspace', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'resume': { key: 'resume', kind: 'value' },
  'save-resume-as': { key: 'saveResumeAs', kind: 'value' },
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

const STATUS_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'workspace': { key: 'workspace', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
};
const LOGS_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'workspace': { key: 'workspace', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'tail': { key: 'tail', kind: 'value' },
};
const TEST_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'workspace': { key: 'workspace', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'id': { key: 'ids', kind: 'list' },
  'tag': { key: 'tags', kind: 'list' },
  'reporter': { key: 'reporter', kind: 'value' },
  'output': { key: 'outputPath', kind: 'value' },
  'fail-fast': { key: 'failFast', kind: 'boolean' },
  'agent': { key: 'agent', kind: 'value' },
};
const DOCTOR_SPEC = { 'codex-bin': { key: 'codexBin', kind: 'value' }, 'claude-bin': { key: 'claudeBin', kind: 'value' } };
const IMPORT_CHAT_SPEC = {
  'repo': { key: 'repoRoot', kind: 'value' },
  'workspace': { key: 'workspace', kind: 'value' },
  'state-dir': { key: 'stateRoot', kind: 'value' },
  'provider': { key: 'provider', kind: 'value' },
  'latest': { key: 'latest', kind: 'boolean' },
  'session-id': { key: 'sessionId', kind: 'value' },
  'query': { key: 'query', kind: 'value' },
};

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

async function resolveCliRootDescriptor(options) {
  if (options.workspace) {
    if (!_flags.enablePersonalWorkspaces) {
      throw new Error('Named workspaces are disabled. Enable enablePersonalWorkspaces first.');
    }
    return await ensureNamedWorkspace(options.workspace);
  }
  return createRepoRootDescriptor(options.repoRoot || process.cwd());
}

async function applyRootDescriptorToOptions(options) {
  const normalized = normalizeOptions(options || {});
  const rootDescriptor = await resolveCliRootDescriptor(normalized);
  return {
    rootDescriptor,
    options: {
      ...normalized,
      repoRoot: rootDescriptor.repoRoot,
      stateRoot: normalized.stateRoot ? path.resolve(normalized.stateRoot) : rootDescriptor.stateRoot,
      workspaceName: rootDescriptor.workspaceName || null,
      rootKind: rootDescriptor.kind,
      rootIdentity: rootDescriptor.rootIdentity,
    },
  };
}

async function bindResumeAliasIfRequested(manifest, options) {
  const alias = options && options.saveResumeAs ? String(options.saveResumeAs).trim() : '';
  if (!alias || !manifest || !manifest.runId) return;
  await bindResumeAlias(manifest.repoRoot, alias, manifest.runId, {
    chatTarget: manifest.chatTarget || null,
  });
  manifest.resumeToken = alias;
}

async function closeCliRunConnections(runId) {
  if (!runId) return;
  try {
    const { closeConnectionsWhere } = require('./codex-app-server');
    await closeConnectionsWhere((key) => key === runId || String(key).startsWith(`${runId}-worker-`));
  } catch {}
}

function chatTargetForSelection(agent) {
  const value = String(agent || '').trim();
  if (!value) return null;
  if (value === 'controller' || value === 'claude') return value;
  return `agent-${value}`;
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
  if (options.chromePort) {
    return {
      port: parseInt(options.chromePort, 10),
      panelId: null,
      autoStarted: false,
    };
  }

  // Auto-start headless Chrome
  try {
    const chromeManager = require('../extension/chrome-manager');
    const panelId = 'cli-' + Date.now();
    const result = await chromeManager.ensureChrome(panelId);
    if (result && result.port) {
      // Register cleanup on exit
      process.on('exit', () => { try { chromeManager.killChrome(panelId); } catch {} });
      process.on('SIGINT', () => { try { chromeManager.killChrome(panelId); } catch {} process.exit(130); });
      return {
        port: result.port,
        panelId,
        autoStarted: true,
      };
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
  const options = parsed.options;
  let message = parsed.positionals.join(' ').trim();
  if (!message) message = (await readAllStdin()).trim();
  if (!message) throw new Error('Missing initial user message.');

  await runPreparedOneShot(message, options, { preloadCloud: true });
}

async function runPreparedOneShot(message, options, { preloadCloud = true, onEvent = null, afterRun = null, printSummary = true } = {}) {
  const { options: normalizedOptions } = await applyRootDescriptorToOptions(options);

  // Load config and apply mode/agent/MCP injection
  const config = loadConfig(normalizedOptions.repoRoot);
  if (preloadCloud) {
    await config.cloud.preload();
  }
  const { options: enriched, directAgent } = applyConfigToOptions(normalizedOptions, config);

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
  let chromeSession = null;
  if (!enriched.noChrome) {
    chromeSession = await ensureChromeIfNeeded(directAgent, config.allAgents, enriched);
    if (chromeSession && chromeSession.port) enriched.chromeDebugPort = chromeSession.port;
  }

  let manifest;
  let pendingResumeAlias = null;
  if (normalizedOptions.resume) {
    const resolvedResume = await resolveResumeToken(normalizedOptions.resume, normalizedOptions.repoRoot, normalizedOptions.stateRoot, {
      allowPendingAlias: true,
      chatTarget: chatTargetForSelection(directAgent),
    });
    if (resolvedResume.kind === 'alias' || resolvedResume.kind === 'run') {
      const runDir = await resolveRunDir(resolvedResume.runId, normalizedOptions.stateRoot);
      manifest = await loadManifestFromDir(runDir);
      manifest.resumeToken = resolvedResume.kind === 'alias' ? resolvedResume.alias : resolvedResume.runId;
    } else if (resolvedResume.kind === 'pending-alias' || resolvedResume.kind === 'stale-alias') {
      pendingResumeAlias = resolvedResume.alias;
    } else {
      throw new Error(`Run or alias not found: ${normalizedOptions.resume}`);
    }
  }

  if (!manifest) {
    manifest = await prepareNewRun(message, enriched);
    manifest.resumeToken = pendingResumeAlias || normalizedOptions.saveResumeAs || manifest.resumeToken || null;
  }

  // Pass Chrome port to manifest for placeholder replacement in buildClaudeArgs
  if (enriched.chromeDebugPort) manifest.chromeDebugPort = enriched.chromeDebugPort;

  const renderer = new Renderer({ rawEvents: manifest.settings.rawEvents, quiet: manifest.settings.quiet });
  renderer.requestStarted(manifest.runId);

  try {
    if (directAgent || enriched.print) {
      // Direct agent mode or print mode — skip controller
      const agentId = directAgent || null;
      await runDirectWorkerTurn(manifest, renderer, { userMessage: message, agentId, onEvent });
    } else {
      await runManagerLoop(manifest, renderer, { userMessage: message, onEvent });
    }
  } finally {
    renderer.close();
    await closeCliRunConnections(manifest.runId);
    if (chromeSession && chromeSession.autoStarted && chromeSession.panelId) {
      try { require('../extension/chrome-manager').killChrome(chromeSession.panelId); } catch {}
    }
    await bindResumeAliasIfRequested(manifest, { saveResumeAs: normalizedOptions.saveResumeAs || pendingResumeAlias });
    await saveManifest(manifest);
  }
  if (typeof afterRun === 'function') {
    await afterRun(manifest);
  }
  if (printSummary) {
    await printRunSummary(manifest);
  }
  return manifest;
}

async function runPreparedHostedWorkflowCloudRun(spec, options) {
  const { options: normalizedOptions } = await applyRootDescriptorToOptions(options);
  const config = loadConfig(normalizedOptions.repoRoot);
  await config.cloud.preload();
  const workflowContext = await materializeHostedWorkflowRun(spec, {
    repoRoot: normalizedOptions.repoRoot,
    secretStore: config.cloud.createWorkflowSecretStore(),
  });
  if (!workflowContext) {
    throw new Error('Hosted workflow cloud-run spec is missing workflowDefinition.');
  }

  workflowContext.targetUrl = spec.targetUrl || null;
  workflowContext.targetType = spec.targetType || null;
  workflowContext.browserPreset = spec.browserPreset || null;
  workflowContext.aiProfile = spec.aiProfile || null;
  const redactor = createHostedWorkflowRedactor(workflowContext);
  const redactValue = redactor ? (value) => redactor.redactValue(value) : (value) => value;
  const bridge = createCloudRunEventBridge(spec, { redactValue });

  const { options: enriched, directAgent } = applyConfigToOptions(normalizedOptions, config);
  if (directAgent) {
    throw new Error('Hosted workflow cloud-run specs do not support direct agent mode.');
  }

  const controllerIsCodex = !enriched.controllerCli || enriched.controllerCli === 'codex' || enriched.controllerCli === 'qa-remote-codex';
  const controllerIsClaude = enriched.controllerCli === 'claude' || enriched.controllerCli === 'qa-remote-claude';
  const workerIsClaude = enriched.workerCli === 'claude' || enriched.workerCli === 'qa-remote-claude';
  if (controllerIsCodex) {
    await ensureBinaryAvailable(enriched.codexBin || 'codex');
  }
  if (controllerIsClaude || workerIsClaude) {
    await ensureBinaryAvailable(enriched.claudeBin || 'claude');
  }

  const manifest = await prepareNewRun(workflowContext.launchInstruction, enriched);
  const renderer = new Renderer({ rawEvents: manifest.settings.rawEvents, quiet: manifest.settings.quiet });
  manifest.cloudRunSpec = sanitizeHostedWorkflowCloudRunSpec(enriched.cloudRunSpec || {});
  setHostedWorkflowExecutionContext(manifest, workflowContext);
  renderer.redactValue = redactValue;
  renderer.requestStarted(manifest.runId);

  try {
    await saveManifest(manifest);
    await runManagerLoop(manifest, renderer, { userMessage: workflowContext.launchInstruction, onEvent: bridge });
  } catch (error) {
    if (error instanceof Error) {
      error.message = String(redactHostedWorkflowValue(workflowContext, error.message));
    }
    throw error;
  } finally {
    renderer.close();
    await bindResumeAliasIfRequested(manifest, normalizedOptions);
    await saveManifest(manifest);
  }

  return manifest;
}

async function runCloudRunCommand(argv) {
  const parsed = parseArgs(argv, CLOUD_RUN_ARG_SPEC);
  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected positional arguments for cloud-run: ${parsed.positionals.join(' ')}`);
  }
  const { spec } = loadCloudRunSpec(parsed.options.specPath);
  const options = buildCloudRunOptions(spec, parsed.options);
  emitCloudRunRawEvent({ type: 'session.started', mode: 'cloud-run', targetUrl: spec.targetUrl || undefined });
  if (spec.targetUrl) {
    emitCloudRunRawEvent({ type: 'browser.navigation', url: spec.targetUrl });
  }
  try {
    const manifest = spec.workflowDefinition
      ? await runPreparedHostedWorkflowCloudRun(spec, options)
      : await runPreparedOneShot(spec.prompt, options, {
          preloadCloud: false,
          onEvent: createCloudRunEventBridge(spec),
          printSummary: false,
        });
    const artifacts = await writeCloudRunArtifacts(manifest, spec);
    for (const artifact of artifacts) {
      emitCloudRunRawEvent({
        type: 'artifact.created',
        artifactType: artifact.artifactType,
        filename: artifact.filename,
      });
    }
    emitCloudRunRawEvent({
      type: 'session.completed',
      outcome: manifest.status === 'idle' ? 'succeeded' : manifest.status,
    });
  } catch (error) {
    emitCloudRunRawEvent({
      type: 'session.failed',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function resumeRun(argv) {
  const parsed = parseArgs(argv, RUN_SPEC);
  const { options } = await applyRootDescriptorToOptions(parsed.options);
  const token = parsed.positionals[0] || options.resume;
  if (!token) throw new Error('Missing run id or alias for resume.');
  const message = parsed.positionals.slice(1).join(' ').trim();
  const stateRoot = options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd());
  const resolved = await resolveResumeToken(token, options.repoRoot, stateRoot, {
    allowPendingAlias: false,
    chatTarget: chatTargetForSelection(options.agent),
  });
  if (resolved.kind !== 'alias' && resolved.kind !== 'run') {
    throw new Error(`Run or alias not found: ${token}`);
  }
  const runDir = await resolveRunDir(resolved.runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  manifest.resumeToken = resolved.kind === 'alias' ? resolved.alias : resolved.runId;
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
    await bindResumeAliasIfRequested(manifest, options);
    await saveManifest(manifest);
  }
  await printRunSummary(manifest);
}

async function showStatus(argv) {
  const parsed = parseArgs(argv, STATUS_SPEC);
  const runId = parsed.positionals[0];
  if (!runId) throw new Error('Missing run id for status.');
  const { options } = await applyRootDescriptorToOptions(parsed.options);
  const stateRoot = options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd());
  const runDir = await resolveRunDir(runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  await printRunSummary(manifest);
}

async function showLogs(argv) {
  const parsed = parseArgs(argv, LOGS_SPEC);
  const runId = parsed.positionals[0];
  if (!runId) throw new Error('Missing run id for logs.');
  const { options } = await applyRootDescriptorToOptions(parsed.options);
  const stateRoot = options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd());
  const tail = parseInteger(parsed.options.tail, '--tail') || 40;
  const runDir = await resolveRunDir(runId, stateRoot);
  const manifest = await loadManifestFromDir(runDir);
  await printEventTail(manifest, tail);
}

async function showList(argv) {
  const parsed = parseArgs(argv, STATUS_SPEC);
  const { options } = await applyRootDescriptorToOptions(parsed.options);
  const stateRoot = options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd());
  const manifests = await listRunManifests(stateRoot);
  if (manifests.length === 0) { process.stdout.write(`No runs found in ${stateRoot}\n`); return; }
  for (const manifest of manifests) {
    process.stdout.write(`${manifest.runId} | ${manifest.status} | ${manifest.transcriptSummary || ''}\n`);
  }
}

// ── MCP management ───────────────────────────────────────────────

function createExitError(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  error.stack = error.message;
  return error;
}

function normalizePandaReporter(value) {
  const reporter = String(value || 'human').trim().toLowerCase();
  if (reporter === 'human' || reporter === 'json' || reporter === 'junit' || reporter === 'ndjson') {
    return reporter;
  }
  throw createExitError(`Unsupported Panda test reporter "${value}".`, 2);
}

function printPandaTestList(entries) {
  if (!entries || entries.length === 0) {
    process.stdout.write('No Panda tests matched the requested selection.\n');
    return;
  }
  process.stdout.write('Panda tests:\n\n');
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? entry.tags.join(', ') : '(none)';
    const runtime = entry.runtimeTestId || '(unbound)';
    process.stdout.write(`  ${entry.id}\n`);
    process.stdout.write(`    Title: ${entry.title}\n`);
    process.stdout.write(`    Path: ${entry.path}\n`);
    process.stdout.write(`    Tags: ${tags}\n`);
    process.stdout.write(`    Agent: ${entry.agent}\n`);
    process.stdout.write(`    Managed: ${entry.managed ? 'yes' : 'no'}\n`);
    process.stdout.write(`    Runtime test: ${runtime}\n\n`);
  }
}

function printImportChatList(entries, options = {}) {
  const query = String(options.query || '').trim();
  if (!entries || entries.length === 0) {
    process.stdout.write('No matching external chats found for this repository.\n');
    return;
  }
  process.stdout.write(query ? `Matching chats for "${query}":\n\n` : 'Importable chats:\n\n');
  for (const entry of entries) {
    process.stdout.write(`  ${entry.provider} ${entry.sessionId}\n`);
    process.stdout.write(`    Updated: ${entry.updatedAt || '(unknown)'}\n`);
    process.stdout.write(`    Path: ${entry.filePath}\n`);
    if (entry.preview) {
      process.stdout.write(`    Preview: ${entry.preview}\n`);
    }
    if (entry.matchPreview) {
      process.stdout.write(`    Match: ${entry.matchPreview}\n`);
    }
    process.stdout.write('\n');
  }
}

async function pandaTestCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (!subcommand || (subcommand !== 'list' && subcommand !== 'run')) {
    throw createExitError('Usage: qapanda test <list|run> [options] [path-or-glob ...]', 2);
  }

  const parsed = parseArgs(rest, TEST_SPEC);
  const explicitStateRoot = Boolean(parsed.options.stateRoot);
  const { options } = await applyRootDescriptorToOptions(parsed.options);
  const pandaOptions = {
    repoRoot: options.repoRoot,
    stateRoot: options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd()),
    stateRootExplicit: explicitStateRoot,
    workspaceName: options.workspaceName || null,
    patterns: parsed.positionals,
    ids: parsed.options.ids || [],
    tags: parsed.options.tags || [],
    agent: parsed.options.agent || null,
    reporter: subcommand === 'run' ? normalizePandaReporter(parsed.options.reporter) : 'human',
    outputPath: parsed.options.outputPath ? path.resolve(parsed.options.outputPath) : null,
    failFast: Boolean(parsed.options.failFast),
  };

  const { listPandaTests, runPandaTestSuite } = require('./panda-test-runner');

  try {
    if (subcommand === 'list') {
      printPandaTestList(listPandaTests(pandaOptions));
      return;
    }

    const suiteResult = await runPandaTestSuite(pandaOptions);
    if (suiteResult.suite.errors > 0) {
      process.exitCode = 2;
    } else if (suiteResult.suite.failed > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error && !error.exitCode) {
      error.exitCode = 2;
      error.stack = error.message;
    }
    throw error;
  }
}

async function importChatCommand(argv) {
  const parsed = parseArgs(argv, IMPORT_CHAT_SPEC);
  const provider = String(parsed.options.provider || '').trim().toLowerCase();
  if (provider !== 'codex' && provider !== 'claude') {
    throw createExitError('Usage: qapanda import-chat --provider <codex|claude> [--query <text> | --latest | --session-id <id>] [--repo <path>]', 2);
  }

  const { options } = await applyRootDescriptorToOptions(parsed.options);
  const query = String(parsed.options.query || '').trim();
  const selectionCount = Number(!!parsed.options.latest) + Number(!!parsed.options.sessionId) + Number(!!query);
  if (selectionCount > 1) {
    throw createExitError('--query cannot be combined with --latest or --session-id.', 2);
  }

  if (query) {
    printImportChatList(await searchExternalChatSessions({
      repoRoot: options.repoRoot,
      provider,
      query,
      limit: 20,
    }), { query });
    return;
  }

  if (!parsed.options.latest && !parsed.options.sessionId) {
    printImportChatList(await discoverExternalChatSessions({
      repoRoot: options.repoRoot,
      provider,
      limit: 20,
    }));
    return;
  }

  const config = loadConfig(options.repoRoot);
  await config.cloud.preload();
  const { options: enriched } = applyConfigToOptions(options, config);

  const targetSession = parsed.options.latest
    ? (await discoverExternalChatSessions({
        repoRoot: options.repoRoot,
        provider,
        limit: 1,
      }))[0] || null
    : null;
  const sessionId = parsed.options.sessionId || (targetSession && targetSession.sessionId);
  if (!sessionId) {
    throw createExitError(`No ${provider} chats found for ${options.repoRoot}.`, 2);
  }

  const imported = await importExternalChatSession({
    repoRoot: options.repoRoot,
    stateRoot: options.stateRoot || defaultStateRoot(options.repoRoot || process.cwd()),
    provider,
    sessionId,
    runOptions: enriched,
  });

  process.stdout.write(`Imported ${provider} session ${sessionId} into run ${imported.manifest.runId}\n`);
  process.stdout.write(`Source: ${imported.manifest.importSource.filePath}\n`);
}

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
    const { options } = await applyRootDescriptorToOptions(parsed.options);
    await runInteractiveShell(options);
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
  if (command === 'test') { await pandaTestCommand(rest); return; }
  if (command === 'import-chat') { await importChatCommand(rest); return; }
  if (command === 'cloud') { await runCloudCommand(rest); return; }
  if (command === 'cloud-run') { await runCloudRunCommand(rest); return; }
  if (command === 'mcp') { await mcpCmd(rest); return; }

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

module.exports = { main, parseArgs, normalizeOptions, loadConfig, applyConfigToOptions, runCloudCommand, runCloudRunCommand };
