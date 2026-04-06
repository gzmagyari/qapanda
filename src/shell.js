const fs = require('node:fs');
const readline = require('node:readline/promises');
const path = require('node:path');

const { loadFeatureFlags } = require('./feature-flags');
const _flags = loadFeatureFlags(null, process.cwd());
const { Renderer } = require('./render');
const { printEventTail, printRunSummary, runManagerLoop, runDirectWorkerTurn } = require('./orchestrator');
const { loadWorkflows, buildCopilotBasePrompt, buildContinueDirective } = require('./prompts');
const {
  WAIT_OPTIONS,
  defaultStateRoot,
  formatWaitDelay,
  listRunManifests,
  loadManifestFromDir,
  lookupAgentConfig,
  parseWaitDelay,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./state');
const { summarizeError } = require('./utils');
const {
  findResourcesDir,
  loadMergedAgents,
  loadMergedModes,
  loadMergedMcpServers,
  enabledAgents,
  enabledModes,
  resolveByEnv,
  getCliDefaults,
  readJsonFile,
  writeJsonFile,
} = require('./config-loader');
const { mcpServersForRole } = require('./mcp-injector');
const { PROVIDERS } = require('./llm-client');
const { compactApiSessionHistory, currentApiSessionTarget, describeCompactionResult } = require('./api-compaction');

const ERROR_RETRY_DELAY_MS = 30 * 60_000;

function isAbortError(error) {
  const msg = error && (error.message || String(error));
  return msg && (msg.includes('was interrupted') || msg.includes('external-abort'));
}

function parseCommand(line) {
  const trimmed = String(line || '').trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return { command: trimmed, rest: '' };
  return { command: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

function resolveInitialDirectAgent(options = {}) {
  if (options.agent) return options.agent;
  if (options.mode) return null;
  return 'QA-Browser';
}

function printHelp(renderer) {
  renderer.banner(`
Commands:
  /help                Show this help
  /new <message>       Start a new run and send the first user message
  /resume <run-id>     Attach to an existing run
  /use <run-id>        Alias for /resume
  /run                 Continue an interrupted request in the attached run
  /status              Show status for the attached run
  /list                List saved runs
  /logs [n]            Show the last n event lines for the attached run
  /wait [delay]        Set auto-pass delay (e.g. 5m, 1h, 1d, none)
  /workflow [name]     List or run a workflow
  /detach              Detach from the current run
  /clear               Clear chat, detach, start fresh
  /compact             Compact the current API session now
  /quit                Exit the shell

Config:
  /config              Show current configuration
  /mode [id]           Show or select a mode
  /modes               List all available modes
  /agent [id]          Show or switch to a direct agent
  /agents              List all available agents
  /controller-cli [c]  Show or set controller CLI${_flags.enableClaudeCli ? ' (codex/api/claude)' : ' (codex/api)'}
  /worker-cli [c]      Show or set worker CLI${_flags.enableClaudeCli ? ' (codex/api/claude)' : ' (codex/api)'}
  /controller-model [m] Show or set controller model
  /worker-model [m]    Show or set worker model
  /controller-thinking [l] Show or set controller thinking level
  /worker-thinking [l] Show or set worker thinking level
  /api-provider [p]    Show or set API provider
  /api-base-url [u]    Show or set API base URL

Tasks:
  /tasks               List tasks from .qpanda/tasks.json
  /task add <title>    Create a new task
  /task done <id>      Mark task as done
  /task <id>           Show task details
${_flags.enableRemoteDesktop ? `
Instances:
  /instances           List Docker desktop instances` : ''}
  /mcp                 List configured MCP servers

Plain text:
  - If no run is attached, plain text starts a new run.
  - If a run is attached, plain text becomes the next user message.
`);
}

function latestRequestMeta(manifest) {
  const requests = (manifest && manifest.requests) || [];
  const request = requests[requests.length - 1] || null;
  const loops = (request && request.loops) || [];
  const loop = loops[loops.length - 1] || null;
  return {
    requestId: request && request.id ? request.id : null,
    loopIndex: loop && loop.index != null ? loop.index : null,
  };
}

async function runInteractiveShell(options = {}) {
  const cwd = path.resolve(options.repoRoot || process.cwd());
  const stateRoot = path.resolve(options.stateRoot || defaultStateRoot(cwd));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const renderer = new Renderer({ rawEvents: Boolean(options.rawEvents), quiet: false });

  // ── Load config at startup ─────────────────────────────────────
  const resourcesDir = findResourcesDir();
  let agentsData = loadMergedAgents(cwd, resourcesDir);
  let modesData = loadMergedModes(cwd, resourcesDir);
  let mcpData = loadMergedMcpServers(cwd);
  let allAgents = enabledAgents(agentsData);
  let allModes = enabledModes(modesData);
  const defaults = getCliDefaults();

  // Session config (can be changed mid-session)
  let controllerCli = options.controllerCli || defaults.controllerCli || 'codex';
  let workerCli = options.workerCli || defaults.workerCli || 'codex';
  let controllerModel = options.controllerModel || null;
  let workerModel = options.workerModel || null;
  let controllerThinking = options.controllerThinking || null;
  let workerThinking = options.workerThinking || null;
  let apiProvider = options.apiProvider || 'openrouter';
  let apiBaseURL = options.apiBaseUrl || '';
  let currentMode = options.mode || null;
  let currentTestEnv = options.testEnv || null;
  let directAgent = resolveInitialDirectAgent(options);
  let loopMode = false;

  let activeManifest = null;
  let waitDelay = options.wait || '';
  let waitTimer = null;
  let chromePort = null;
  let chromePanelId = null;

  function anyAgentUsesApi() {
    return Object.values(allAgents || {}).some((agent) => agent && agent.cli === 'api');
  }

  function syncActiveManifestApiConfig() {
    if (!activeManifest) return;
    const shared = { provider: apiProvider || 'openrouter', baseURL: apiBaseURL || '' };
    const needsSharedApiConfig = controllerCli === 'api' || workerCli === 'api' || anyAgentUsesApi();

    activeManifest.controller.model = controllerModel || null;
    activeManifest.worker.model = workerModel || null;
    activeManifest.apiConfig = needsSharedApiConfig ? shared : null;
    activeManifest.controller.apiConfig = controllerCli === 'api'
      ? { ...shared, model: controllerModel || '', thinking: controllerThinking || '' }
      : null;
    activeManifest.worker.apiConfig = (workerCli === 'api' || anyAgentUsesApi())
      ? { ...shared, model: workerModel || '', thinking: workerThinking || '' }
      : null;
  }

  async function persistActiveManifestConfig() {
    if (!activeManifest) return;
    syncActiveManifestApiConfig();
    await saveManifest(activeManifest);
  }

  // ── Build run options from current config ──────────────────────
  function buildRunOptions() {
    const runOpts = {
      ...options,
      repoRoot: cwd,
      stateRoot,
      controllerCli,
      workerCli,
      controllerModel,
      workerModel,
      agents: allAgents,
    };

    const sharedApiConfig = { provider: apiProvider || 'openrouter', baseURL: apiBaseURL || '' };
    if (controllerCli === 'api' || workerCli === 'api' || anyAgentUsesApi()) {
      runOpts.apiConfig = sharedApiConfig;
      if (controllerCli === 'api') {
        runOpts.controllerApiConfig = {
          ...sharedApiConfig,
          model: controllerModel || '',
          thinking: controllerThinking || '',
        };
      }
      if (workerCli === 'api' || anyAgentUsesApi()) {
        runOpts.workerApiConfig = {
          ...sharedApiConfig,
          model: workerModel || '',
          thinking: workerThinking || '',
        };
      }
    }

    // Apply thinking via env var
    if (workerThinking) process.env.CLAUDE_CODE_EFFORT_LEVEL = workerThinking;
    else delete process.env.CLAUDE_CODE_EFFORT_LEVEL;

    // Apply mode
    if (currentMode) {
      const mode = allModes[currentMode];
      if (mode) {
        const env = currentTestEnv || 'browser';
        if (mode.controllerPrompt) runOpts.controllerSystemPrompt = resolveByEnv(mode.controllerPrompt, env);
        if (!mode.useController) directAgent = resolveByEnv(mode.defaultAgent, env);
      }
    }

    // Auto-inject MCPs
    if (!options.noMcpInject) {
      runOpts.workerMcpServers = mcpServersForRole('worker', {
        globalMcps: mcpData.global,
        projectMcps: mcpData.project,
        repoRoot: cwd,
        controllerCli,
        workerCli,
        agents: allAgents,
      });
      runOpts.controllerMcpServers = mcpServersForRole('controller', {
        globalMcps: mcpData.global,
        projectMcps: mcpData.project,
        repoRoot: cwd,
        controllerCli,
        workerCli,
        agents: allAgents,
      });
    }

    return runOpts;
  }

  // ── Timer management ───────────────────────────────────────────
  function stopWaitTimer() { if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; } }

  function clearWaitTimer() {
    stopWaitTimer();
    if (activeManifest) {
      activeManifest.nextWakeAt = null;
      activeManifest.errorRetry = false;
      saveManifest(activeManifest).catch(() => {});
    }
  }

  function scheduleNextPass() {
    clearWaitTimer();
    if (!activeManifest || activeManifest.status !== 'running') return;
    const delayMs = parseWaitDelay(waitDelay);
    if (!delayMs) return;
    const wakeAt = new Date(Date.now() + delayMs).toISOString();
    activeManifest.nextWakeAt = wakeAt;
    saveManifest(activeManifest).catch(() => {});
    renderer.banner(`Next auto-pass in ${formatWaitDelay(delayMs)} (at ${wakeAt.slice(11, 19)})`);
    waitTimer = setTimeout(async () => {
      waitTimer = null;
      if (!activeManifest || activeManifest.status !== 'running') return;
      activeManifest.nextWakeAt = null;
      renderer.banner('Auto-pass starting...');
      try {
        activeManifest = await runManagerLoop(activeManifest, renderer, { singlePass: true });
        await saveManifest(activeManifest);
        scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) { renderer.banner(`Run error: ${summarizeError(error)}`); scheduleErrorRetry(); }
        else renderer.banner('Run stopped by user.');
      } finally { renderer.close(); }
    }, delayMs);
  }

  function scheduleErrorRetry() {
    stopWaitTimer();
    if (!activeManifest) return;
    if (activeManifest.status !== 'running' && activeManifest.status !== 'interrupted') return;
    const wakeAt = new Date(Date.now() + ERROR_RETRY_DELAY_MS).toISOString();
    activeManifest.nextWakeAt = wakeAt;
    activeManifest.errorRetry = true;
    saveManifest(activeManifest).catch(() => {});
    renderer.banner(`Error backoff: retrying in 30 min (at ${wakeAt.slice(11, 19)})`);
    waitTimer = setTimeout(async () => {
      waitTimer = null;
      if (!activeManifest) return;
      activeManifest.status = 'running';
      activeManifest.nextWakeAt = null;
      activeManifest.errorRetry = false;
      renderer.banner('Error-retry auto-pass starting...');
      try {
        activeManifest = await runManagerLoop(activeManifest, renderer, { singlePass: true });
        await saveManifest(activeManifest);
        scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) { renderer.banner(`Run error: ${summarizeError(error)}`); scheduleErrorRetry(); }
        else renderer.banner('Run stopped by user.');
      } finally { renderer.close(); }
    }, ERROR_RETRY_DELAY_MS);
  }

  async function runWithScheduling(manifest, renderer, loopOptions) {
    const delayMs = parseWaitDelay(waitDelay);
    if (!delayMs) return await runManagerLoop(manifest, renderer, loopOptions);
    return await runManagerLoop(manifest, renderer, { ...loopOptions, singlePass: true });
  }

  // ── Execute a user message (new run or continue) ───────────────
  async function executeMessage(message) {
    clearWaitTimer();
    try {
      if (!activeManifest) {
        const runOpts = buildRunOptions();

        // Auto-start Chrome if the direct agent needs chrome-devtools MCP
        if (directAgent && !chromePort && !options.noChrome) {
          const agent = allAgents[directAgent];
          if (agent && agent.mcps && (agent.mcps['chrome-devtools'] || agent.mcps['chrome_devtools'])) {
            if (!agent.cli || !agent.cli.startsWith('qa-remote')) {
              try {
                const chromeManager = require('../extension/chrome-manager');
                chromePanelId = 'cli-shell-' + Date.now();
                const chromeResult = await chromeManager.ensureChrome(chromePanelId);
                if (chromeResult && chromeResult.port) {
                  chromePort = chromeResult.port;
                  renderer.banner(`Chrome started on debug port ${chromePort}`);
                }
              } catch (e) { renderer.banner(`Warning: Could not start Chrome: ${e.message}`); }
            }
          }
        }
        if (chromePort) runOpts.chromeDebugPort = chromePort;

        activeManifest = await prepareNewRun(message, runOpts);
        if (chromePort) activeManifest.chromeDebugPort = chromePort;
        renderer.requestStarted(activeManifest.runId);
      }
      if (directAgent) {
        activeManifest = await runDirectWorkerTurn(activeManifest, renderer, { userMessage: message, agentId: directAgent });
      } else {
        activeManifest = await runWithScheduling(activeManifest, renderer, { userMessage: message });
      }
      await saveManifest(activeManifest);
      scheduleNextPass();
    } catch (error) {
      if (!isAbortError(error)) { renderer.banner(`Run error: ${summarizeError(error)}`); scheduleErrorRetry(); }
      else renderer.banner('Run stopped by user.');
    } finally { renderer.close(); }
  }

  // ── Tasks helpers ──────────────────────────────────────────────
  function loadTasks() {
    const tasksFile = path.join(cwd, '.qpanda', 'tasks.json');
    try { return JSON.parse(fs.readFileSync(tasksFile, 'utf8')); }
    catch { return { nextId: 1, tasks: [] }; }
  }

  function saveTasks(data) {
    const tasksFile = path.join(cwd, '.qpanda', 'tasks.json');
    fs.mkdirSync(path.dirname(tasksFile), { recursive: true });
    fs.writeFileSync(tasksFile, JSON.stringify(data, null, 2), 'utf8');
  }

  // ── Main loop ──────────────────────────────────────────────────
  renderer.banner('\uD83D\uDC3C QA Panda interactive session');
  renderer.banner(`Repo root: ${cwd}`);
  renderer.banner('Type /help for commands, or type a message to start.');

  try {
    while (true) {
      const prompt = renderer.userPrompt();
      let line;
      try { line = await rl.question(prompt); }
      catch (error) { if (error && error.code === 'ERR_USE_AFTER_CLOSE') break; throw error; }
      const trimmed = String(line || '').trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('/')) {
        const { command, rest } = parseCommand(trimmed);

        if (command === '/quit' || command === '/exit') break;
        if (command === '/help') { printHelp(renderer); continue; }

        if (command === '/loop') {
          loopMode = !loopMode;
          renderer.banner(`Loop mode: ${loopMode ? 'ON — controller auto-continues after each response' : 'OFF'}`);
          continue;
        }

        if (command === '/orchestrate') {
          const text = rest || '';
          renderer.banner('Running orchestration...');
          clearWaitTimer();
          try {
            if (!activeManifest) {
              activeManifest = await prepareNewRun(text || '[ORCHESTRATE]', buildRunOptions());
              renderer.requestStarted(activeManifest.runId);
            }
            // Direct controller with persistent session — loops until controller says STOP
            activeManifest = await runWithScheduling(activeManifest, renderer, {
              userMessage: text || '[ORCHESTRATE] Decide the next step based on the conversation transcript.',
            });
            await saveManifest(activeManifest);
          } catch (error) {
            if (!isAbortError(error)) { renderer.banner(`Run error: ${summarizeError(error)}`); scheduleErrorRetry(); }
            else renderer.banner('Run stopped by user.');
          } finally { renderer.close(); }
          continue;
        }

        if (command === '/continue') {
          const guidance = rest || '';
          renderer.banner('Running controller continue...');
          clearWaitTimer();
          try {
            if (!activeManifest) {
              activeManifest = await prepareNewRun(guidance || '[AUTO-CONTINUE]', buildRunOptions());
              renderer.requestStarted(activeManifest.runId);
            }
            // Set copilot prompt + continue directive so controller knows what to do
            const originalPrompt = activeManifest.controllerSystemPrompt;
            const basePrompt = originalPrompt || buildCopilotBasePrompt({ selfTesting: activeManifest.selfTesting, repoRoot: activeManifest.repoRoot });
            const directive = buildContinueDirective(guidance, directAgent);
            activeManifest.controllerSystemPrompt = basePrompt + '\n\n' + directive;
            // Copilot mode: fresh one-shot controller — don't resume any existing session
            const savedControllerSessionId = activeManifest.controller.sessionId;
            activeManifest.controller.sessionId = null;
            const userMessage = guidance
              ? `[CONTROLLER GUIDANCE] ${guidance}`
              : '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.';
            activeManifest = await runWithScheduling(activeManifest, renderer, { userMessage });
            // Restore original prompt and direct-mode controller session
            activeManifest.controllerSystemPrompt = originalPrompt;
            activeManifest.controller.sessionId = savedControllerSessionId;
            await saveManifest(activeManifest);
            if (loopMode && activeManifest.status === 'running') {
              scheduleNextPass();
            }
          } catch (error) {
            if (!isAbortError(error)) { renderer.banner(`Run error: ${summarizeError(error)}`); scheduleErrorRetry(); }
            else renderer.banner('Run stopped by user.');
          } finally { renderer.close(); }
          continue;
        }

        if (command === '/clear') {
          clearWaitTimer();
          activeManifest = null;
          renderer.banner('Chat cleared.');
          continue;
        }

        if (command === '/compact') {
          if (!activeManifest) {
            renderer.banner('No run is attached.');
            continue;
          }
          const targetInfo = directAgent
            ? currentApiSessionTarget({
                manifest: activeManifest,
                target: directAgent === 'default' ? 'worker-default' : 'worker-agent',
                directAgent: directAgent === 'default' ? null : directAgent,
                workerCli,
              })
            : currentApiSessionTarget({
                manifest: activeManifest,
                target: 'controller',
                controllerCli,
                workerCli,
              });
          if (!targetInfo) {
            renderer.banner('The current target is not using API mode.');
            continue;
          }
          const { requestId, loopIndex } = latestRequestMeta(activeManifest);
          renderer.banner(`Compacting ${directAgent ? 'current agent session' : 'controller session'}...`);
          const result = await compactApiSessionHistory({
            manifest: activeManifest,
            sessionKey: targetInfo.sessionKey,
            backend: targetInfo.backend,
            requestId,
            loopIndex,
            provider: targetInfo.provider,
            baseURL: targetInfo.baseURL,
            model: targetInfo.model,
            thinking: targetInfo.thinking,
            force: true,
          });
          renderer.banner(describeCompactionResult(result, directAgent ? 'Current agent session' : 'Controller session'));
          continue;
        }

        if (command === '/detach') {
          clearWaitTimer();
          activeManifest = null;
          renderer.banner('Detached from the current run.');
          continue;
        }

        if (command === '/list') {
          const manifests = await listRunManifests(stateRoot);
          if (manifests.length === 0) renderer.banner('No runs found.');
          else for (const m of manifests) renderer.banner(`${m.runId} | ${m.status} | ${m.transcriptSummary || ''}`);
          continue;
        }

        if (command === '/resume' || command === '/use') {
          if (!rest) { renderer.banner('Usage: /resume <run-id>'); continue; }
          clearWaitTimer();
          const runDir = await resolveRunDir(rest, stateRoot);
          activeManifest = await loadManifestFromDir(runDir);
          if (activeManifest.waitDelay) { waitDelay = activeManifest.waitDelay; renderer.banner(`Wait delay restored: ${formatWaitDelay(parseWaitDelay(waitDelay))}`); }
          renderer.requestStarted(activeManifest.runId);
          continue;
        }

        if (command === '/status') {
          if (!activeManifest) { renderer.banner('No run is attached.'); continue; }
          await printRunSummary(activeManifest);
          continue;
        }

        if (command === '/logs') {
          if (!activeManifest) { renderer.banner('No run is attached.'); continue; }
          await printEventTail(activeManifest, rest ? Number.parseInt(rest, 10) || 40 : 40);
          continue;
        }

        if (command === '/run') {
          if (!activeManifest) { renderer.banner('No run is attached.'); continue; }
          clearWaitTimer();
          try {
            activeManifest = await runWithScheduling(activeManifest, renderer, {});
            await saveManifest(activeManifest);
            scheduleNextPass();
          } catch (error) {
            if (!isAbortError(error)) { renderer.banner(`Run error: ${summarizeError(error)}`); scheduleErrorRetry(); }
            else renderer.banner('Run stopped by user.');
          } finally { renderer.close(); }
          continue;
        }

        if (command === '/new') {
          if (!rest) { renderer.banner('Usage: /new <message>'); continue; }
          clearWaitTimer();
          activeManifest = null; // Force new run
          await executeMessage(rest);
          continue;
        }

        // ── Config commands ──────────────────────────────────────

        if (command === '/config') {
          const lines = [
            `Mode: ${currentMode || 'none'}`,
            `Test env: ${currentTestEnv || 'none'}`,
            `Direct agent: ${directAgent || 'none (using controller)'}`,
            `Controller CLI: ${controllerCli}`,
            `Controller model: ${controllerModel || 'default'}`,
            `Controller thinking: ${controllerThinking || 'default'}`,
            `Worker CLI: ${workerCli}`,
            `Worker model: ${workerModel || 'default'}`,
            `Worker thinking: ${workerThinking || 'default'}`,
            `API provider: ${apiProvider || 'openrouter'}`,
            `API base URL: ${apiBaseURL || '(default)'}`,
            `Wait delay: ${waitDelay || 'none'}`,
            `Run attached: ${activeManifest ? activeManifest.runId : 'no'}`,
          ];
          renderer.banner(lines.join('\n'));
          continue;
        }

        if (command === '/modes') {
          const lines = ['Available modes:'];
          for (const [id, mode] of Object.entries(allModes)) {
            const ctrl = mode.useController ? 'controller' : 'direct';
            const env = mode.requiresTestEnv ? ' (needs test-env)' : '';
            const active = id === currentMode ? ' ← active' : '';
            lines.push(`  ${id.padEnd(20)} ${(mode.name || '').padEnd(25)} ${ctrl}${env}${active}`);
          }
          renderer.banner(lines.join('\n'));
          continue;
        }

        if (command === '/mode') {
          if (!rest) {
            renderer.banner(`Current mode: ${currentMode || 'none'}\nUse /mode <id> to select. Use /modes to list.`);
            continue;
          }
          if (!allModes[rest]) { renderer.banner(`Unknown mode: ${rest}. Use /modes to list.`); continue; }
          clearWaitTimer();
          activeManifest = null;
          currentMode = rest;
          const mode = allModes[rest];
          if (mode.requiresTestEnv && !currentTestEnv) {
            currentTestEnv = 'browser'; // default
            renderer.banner(`Mode '${rest}' requires test environment. Defaulting to browser. Use /test-env computer to change.`);
          }
          if (!mode.useController) {
            directAgent = resolveByEnv(mode.defaultAgent, currentTestEnv || 'browser');
            renderer.banner(`Mode set to '${rest}' — direct to agent '${directAgent}'`);
          } else {
            directAgent = null;
            renderer.banner(`Mode set to '${rest}' — using controller`);
          }
          continue;
        }

        if (command === '/agents') {
          const lines = ['Available agents:'];
          for (const [id, agent] of Object.entries(allAgents)) {
            const active = id === directAgent ? ' ← active' : '';
            lines.push(`  ${id.padEnd(20)} ${(agent.name || '').padEnd(25)} cli: ${agent.cli || 'codex'}${active}`);
          }
          renderer.banner(lines.join('\n'));
          continue;
        }

        if (command === '/agent') {
          if (!rest) {
            renderer.banner(`Current agent: ${directAgent || 'none (using controller)'}\nUse /agent <id> to switch. Use /agents to list.`);
            continue;
          }
          if (rest === 'none' || rest === 'controller') {
            directAgent = null;
            renderer.banner('Switched to controller mode.');
            continue;
          }
          if (!allAgents[rest]) { renderer.banner(`Unknown agent: ${rest}. Use /agents to list.`); continue; }
          directAgent = rest;
          renderer.banner(`Switched to direct agent: ${rest} (${allAgents[rest].name})`);
          continue;
        }

        if (command === '/controller-cli') {
          if (!rest) { renderer.banner(`Controller CLI: ${controllerCli}`); continue; }
          if (!_flags.enableClaudeCli && (rest === 'claude' || rest === 'qa-remote-claude')) {
            renderer.banner('Claude CLI is not enabled. Use codex.'); continue;
          }
          if (!_flags.enableRemoteDesktop && rest.startsWith('qa-remote')) {
            renderer.banner('Remote desktop is not enabled.'); continue;
          }
          controllerCli = rest;
          if (activeManifest) { activeManifest.controller.cli = rest; activeManifest.controller.sessionId = null; }
          await persistActiveManifestConfig();
          renderer.banner(`Controller CLI set to: ${rest}`);
          continue;
        }

        if (command === '/worker-cli') {
          if (!rest) { renderer.banner(`Worker CLI: ${workerCli}`); continue; }
          if (!_flags.enableClaudeCli && (rest === 'claude' || rest === 'qa-remote-claude')) {
            renderer.banner('Claude CLI is not enabled. Use codex.'); continue;
          }
          if (!_flags.enableRemoteDesktop && rest.startsWith('qa-remote')) {
            renderer.banner('Remote desktop is not enabled.'); continue;
          }
          workerCli = rest;
          await persistActiveManifestConfig();
          renderer.banner(`Worker CLI set to: ${rest}`);
          continue;
        }

        if (command === '/api-provider') {
          if (!rest) { renderer.banner(`API provider: ${apiProvider}`); continue; }
          if (!Object.prototype.hasOwnProperty.call(PROVIDERS, rest)) {
            renderer.banner(`Unknown API provider: ${rest}`);
            continue;
          }
          apiProvider = rest;
          await persistActiveManifestConfig();
          renderer.banner(`API provider set to: ${apiProvider}`);
          continue;
        }

        if (command === '/api-base-url') {
          if (!rest) { renderer.banner(`API base URL: ${apiBaseURL || '(default)'}`); continue; }
          apiBaseURL = (rest === 'default' || rest === 'none') ? '' : rest;
          await persistActiveManifestConfig();
          renderer.banner(`API base URL set to: ${apiBaseURL || '(default)'}`);
          continue;
        }

        if (command === '/controller-model') {
          if (!rest) { renderer.banner(`Controller model: ${controllerModel || 'default'}`); continue; }
          controllerModel = rest === 'default' ? null : rest;
          if (activeManifest) activeManifest.controller.model = controllerModel;
          await persistActiveManifestConfig();
          renderer.banner(`Controller model set to: ${controllerModel || 'default'}`);
          continue;
        }

        if (command === '/worker-model') {
          if (!rest) { renderer.banner(`Worker model: ${workerModel || 'default'}`); continue; }
          workerModel = rest === 'default' ? null : rest;
          if (activeManifest) activeManifest.worker.model = workerModel;
          await persistActiveManifestConfig();
          renderer.banner(`Worker model set to: ${workerModel || 'default'}`);
          continue;
        }

        if (command === '/controller-thinking') {
          if (!rest) { renderer.banner(`Controller thinking: ${controllerThinking || 'default'}`); continue; }
          controllerThinking = rest === 'default' ? null : rest;
          await persistActiveManifestConfig();
          renderer.banner(`Controller thinking set to: ${controllerThinking || 'default'}`);
          continue;
        }

        if (command === '/worker-thinking') {
          if (!rest) { renderer.banner(`Worker thinking: ${workerThinking || 'default'}`); continue; }
          workerThinking = rest === 'default' ? null : rest;
          if (workerThinking) process.env.CLAUDE_CODE_EFFORT_LEVEL = workerThinking;
          else delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
          await persistActiveManifestConfig();
          renderer.banner(`Worker thinking set to: ${workerThinking || 'default'}`);
          continue;
        }

        // ── Tasks commands ───────────────────────────────────────

        if (command === '/tasks') {
          const data = loadTasks();
          if (!data.tasks || data.tasks.length === 0) { renderer.banner('No tasks.'); continue; }
          const byStatus = {};
          for (const t of data.tasks) { (byStatus[t.status] = byStatus[t.status] || []).push(t); }
          const lines = [];
          for (const [status, tasks] of Object.entries(byStatus)) {
            lines.push(`\n  ${status.toUpperCase()}`);
            for (const t of tasks) lines.push(`    ${t.id} — ${t.title}`);
          }
          renderer.banner(lines.join('\n'));
          continue;
        }

        if (command === '/task') {
          if (!rest) { renderer.banner('Usage: /task <id> or /task add <title> or /task done <id>'); continue; }
          const parts = rest.split(' ');
          if (parts[0] === 'add') {
            const title = parts.slice(1).join(' ');
            if (!title) { renderer.banner('Usage: /task add <title>'); continue; }
            const data = loadTasks();
            const id = 'task-' + (data.nextId || 1);
            data.nextId = (data.nextId || 1) + 1;
            data.tasks.push({ id, title, description: '', detail_text: '', status: 'todo', comments: [], progress_updates: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
            saveTasks(data);
            renderer.banner(`Created: ${id} — ${title}`);
            continue;
          }
          if (parts[0] === 'done') {
            const taskId = parts[1];
            if (!taskId) { renderer.banner('Usage: /task done <id>'); continue; }
            const data = loadTasks();
            const task = data.tasks.find(t => t.id === taskId);
            if (!task) { renderer.banner(`Task not found: ${taskId}`); continue; }
            task.status = 'done';
            task.updated_at = new Date().toISOString();
            saveTasks(data);
            renderer.banner(`Marked done: ${taskId}`);
            continue;
          }
          if (parts[0] === 'status') {
            const taskId = parts[1];
            const newStatus = parts[2];
            if (!taskId || !newStatus) { renderer.banner('Usage: /task status <id> <status>'); continue; }
            const data = loadTasks();
            const task = data.tasks.find(t => t.id === taskId);
            if (!task) { renderer.banner(`Task not found: ${taskId}`); continue; }
            task.status = newStatus;
            task.updated_at = new Date().toISOString();
            saveTasks(data);
            renderer.banner(`${taskId} status → ${newStatus}`);
            continue;
          }
          // Show task detail
          const data = loadTasks();
          const task = data.tasks.find(t => t.id === parts[0]);
          if (!task) { renderer.banner(`Task not found: ${parts[0]}`); continue; }
          const lines = [`${task.id} — ${task.title}`, `Status: ${task.status}`, `Description: ${task.description || '(none)'}`, `Detail: ${task.detail_text || '(none)'}`, `Created: ${task.created_at}`, `Updated: ${task.updated_at}`];
          if (task.comments && task.comments.length > 0) {
            lines.push(`\nComments:`);
            for (const c of task.comments) lines.push(`  [${c.author || 'anon'}] ${c.text}`);
          }
          renderer.banner(lines.join('\n'));
          continue;
        }

        // ── Tests commands ────────────────────────────────────────

        if (command === '/tests') {
          const testsFile = path.join(cwd, '.qpanda', 'tests.json');
          let testsData;
          try { testsData = JSON.parse(fs.readFileSync(testsFile, 'utf8')); } catch { testsData = { tests: [] }; }
          if (!testsData.tests || testsData.tests.length === 0) { renderer.banner('No tests.'); continue; }
          const byStatus = {};
          for (const t of testsData.tests) { (byStatus[t.status] = byStatus[t.status] || []).push(t); }
          const lines = [];
          for (const [status, tests] of Object.entries(byStatus)) {
            lines.push(`\n  ${status.toUpperCase()}`);
            for (const t of tests) {
              const sp = (t.steps || []).filter(s => s.status === 'pass').length;
              const st = (t.steps || []).length;
              lines.push(`    ${t.id} — ${t.title} [${t.environment}] (${sp}/${st} steps passing)`);
            }
          }
          renderer.banner(lines.join('\n'));
          continue;
        }

        if (command === '/test') {
          if (!rest) { renderer.banner('Usage: /test <id> or /test create <title>'); continue; }
          const parts = rest.split(' ');
          if (parts[0] === 'create') {
            const title = parts.slice(1).join(' ');
            if (!title) { renderer.banner('Usage: /test create <title>'); continue; }
            const testsFile = path.join(cwd, '.qpanda', 'tests.json');
            let data;
            try { data = JSON.parse(fs.readFileSync(testsFile, 'utf8')); } catch { data = { nextId: 1, nextStepId: 1, nextRunId: 1, tests: [] }; }
            const id = 'test-' + data.nextId++;
            data.tests.push({ id, title, description: '', environment: 'browser', status: 'untested', steps: [], linkedTaskIds: [], tags: [], lastTestedAt: null, lastTestedBy: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), runs: [] });
            fs.mkdirSync(path.dirname(testsFile), { recursive: true });
            fs.writeFileSync(testsFile, JSON.stringify(data, null, 2), 'utf8');
            renderer.banner(`Created: ${id} — ${title}`);
            continue;
          }
          // Show test detail
          const testsFile = path.join(cwd, '.qpanda', 'tests.json');
          let data;
          try { data = JSON.parse(fs.readFileSync(testsFile, 'utf8')); } catch { data = { tests: [] }; }
          const test = data.tests.find(t => t.id === parts[0]);
          if (!test) { renderer.banner(`Test not found: ${parts[0]}`); continue; }
          const lines = [`${test.id} — ${test.title}`, `Environment: ${test.environment}`, `Status: ${test.status}`, `Description: ${test.description || '(none)'}`];
          if (test.steps && test.steps.length > 0) {
            lines.push('\nSteps:');
            for (const s of test.steps) {
              const icon = s.status === 'pass' ? '✅' : s.status === 'fail' ? '❌' : '⬜';
              lines.push(`  ${icon} ${s.description} — Expected: ${s.expectedResult}${s.status === 'fail' && s.actualResult ? ' — Actual: ' + s.actualResult : ''}`);
            }
          }
          if (test.linkedTaskIds && test.linkedTaskIds.length > 0) {
            lines.push(`\nLinked tasks: ${test.linkedTaskIds.join(', ')}`);
          }
          renderer.banner(lines.join('\n'));
          continue;
        }

        // ── Instances / MCP ──────────────────────────────────────

        if (command === '/instances') {
          if (!_flags.enableRemoteDesktop) { renderer.banner('Remote desktop feature is not enabled.'); continue; }
          try {
            const { listInstances } = require('./remote-desktop');
            const instances = await listInstances(null, cwd);
            if (instances.length === 0) { renderer.banner('No Docker instances running.'); continue; }
            const lines = ['Docker Instances:'];
            for (const inst of instances) {
              lines.push(`  ${inst.name.padEnd(30)} API:${inst.api_port} VNC:${inst.vnc_port} noVNC:${inst.novnc_port} ${inst.status}`);
            }
            renderer.banner(lines.join('\n'));
          } catch { renderer.banner('Could not list instances.'); }
          continue;
        }

        if (command === '/mcp') {
          const lines = ['MCP Servers:'];
          const all = { ...mcpData.global, ...mcpData.project };
          if (Object.keys(all).length === 0) { lines.push('  (none configured)'); }
          for (const [name, server] of Object.entries(all)) {
            const target = server.target || 'both';
            const type = server.url ? 'http' : 'stdio';
            lines.push(`  ${name.padEnd(25)} ${type.padEnd(6)} target: ${target}`);
          }
          lines.push('\nAuto-injected: detached-command, cc-tasks');
          renderer.banner(lines.join('\n'));
          continue;
        }

        // ── Wait command ─────────────────────────────────────────

        if (command === '/wait') {
          if (!rest) {
            const current = waitDelay || 'none';
            const opts = WAIT_OPTIONS.map(o => `  ${o.value || 'none'} — ${o.label}`).join('\n');
            renderer.banner(`Wait delay: ${current}\n\nAvailable:\n${opts}`);
            continue;
          }
          const val = rest === 'none' || rest === 'off' || rest === '0' ? '' : rest;
          const ms = parseWaitDelay(val);
          if (val && !ms) { renderer.banner(`Unknown delay: ${rest}. Use /wait for options.`); continue; }
          waitDelay = val;
          if (activeManifest) {
            activeManifest.waitDelay = val || null;
            if (val && activeManifest.status === 'running') scheduleNextPass();
            else clearWaitTimer();
          }
          renderer.banner(`Wait delay set to: ${val ? formatWaitDelay(ms) : 'none'}`);
          continue;
        }

        // ── Workflow command ─────────────────────────────────────

        if (command === '/workflow') {
          const workflows = loadWorkflows(cwd);
          if (!rest) {
            if (workflows.length === 0) {
              renderer.banner('No workflows found.\nPlace workflow directories in .qpanda/workflows/ or ~/.qpanda/workflows/');
            } else {
              const lines = ['Available workflows:'];
              for (const wf of workflows) lines.push(`  ${wf.name} — ${wf.description}`);
              renderer.banner(lines.join('\n'));
            }
            continue;
          }
          const wf = workflows.find(w => w.name === rest);
          if (!wf) { renderer.banner(`Workflow "${rest}" not found.`); continue; }
          let content;
          try { content = fs.readFileSync(wf.path, 'utf8').trim(); }
          catch (err) { renderer.banner(`Failed to read workflow: ${err.message}`); continue; }
          const message = `Run the workflow "${wf.name}". Read the full instructions at: ${wf.path}\n\nWorkflow summary: ${wf.description}\n\nFull workflow instructions:\n${content}`;
          await executeMessage(message);
          continue;
        }

        renderer.banner(`Unknown command: ${command}. Type /help for commands.`);
        continue;
      }

      // Plain text → execute as message
      await executeMessage(trimmed);
    }
  } finally {
    stopWaitTimer();
    // Cleanup Chrome if we started it
    if (chromePanelId) {
      try { require('../extension/chrome-manager').killChrome(chromePanelId); } catch {}
    }
    rl.close();
  }
}

module.exports = { runInteractiveShell, resolveInitialDirectAgent };
