const fs = require('node:fs');
const path = require('node:path');
const { runManagerLoop, runDirectWorkerTurn, printRunSummary, printEventTail } = require('./src/orchestrator');
const { closeInteractiveSessions } = require('./src/claude');
const { loadWorkflows, buildCopilotBasePrompt, buildContinueDirective } = require('./src/prompts');
const {
  WAIT_OPTIONS,
  defaultStateRoot,
  formatWaitDelay,
  listRunManifests,
  loadManifestFromDir,
  parseWaitDelay,
  prepareNewRun,
  resolveRunDir,
  saveManifest,
} = require('./src/state');
const { readText, summarizeError } = require('./src/utils');
const { controllerLabelFor, workerLabelFor } = require('./src/render');
const {
  appendTranscriptRecord,
  buildTranscriptDisplayMessages,
  createTranscriptRecord,
  readTranscriptEntries,
  transcriptBackend,
  workerSessionKey,
} = require('./src/transcript');

const ERROR_RETRY_DELAY_MS = 30 * 60_000; // 30 minutes

function isAbortError(error) {
  const msg = error && (error.message || String(error));
  return msg && (msg.includes('was interrupted') || msg.includes('external-abort'));
}

function formatRunError(error) {
  if (isAbortError(error)) return 'Run stopped by user.';
  // Show just the message, not the full stack trace
  if (error instanceof Error) return error.message;
  return summarizeError(error);
}

const CODEX_MODELS = [
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
];

const CLAUDE_MODELS = [
  { value: 'sonnet', label: 'Sonnet (latest)' },
  { value: 'opus', label: 'Opus (latest)' },
  { value: 'haiku', label: 'Haiku' },
];

const CODEX_THINKING = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

const CLAUDE_THINKING = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

class SessionManager {
  constructor(renderer, options = {}) {
    this._renderer = renderer;
    this._repoRoot = options.repoRoot || process.cwd();
    this._stateRoot = options.stateRoot || defaultStateRoot(this._repoRoot);
    this._panelId = options.panelId || require('node:crypto').randomUUID();
    this._runOptions = options.runOptions || {};
    this._activeManifest = null;
    this._abortController = null;
    this._running = false;
    this._postMessage = options.postMessage || (() => {});
    this._waitTimer = null;
    // Model/thinking overrides (load from persisted config if available)
    const init = options.initialConfig || {};
    this._controllerModel = init.controllerModel || null;
    this._workerModel = init.workerModel || null;
    this._controllerThinking = init.controllerThinking || null;
    this._workerThinking = init.workerThinking || null;
    this._apiProvider = init.apiProvider || 'openrouter';
    this._apiBaseURL = init.apiBaseURL || '';
    this._apiKey = '';
    this._waitDelay = init.waitDelay || '';
    this._chatTarget = init.chatTarget || 'controller';
    this._controllerCli = init.controllerCli || 'codex';
    this._codexMode = init.codexMode || 'app-server';
    this._renderer.controllerLabel = controllerLabelFor(this._controllerCli);
    this._workerCli = init.workerCli || 'codex';
    this._renderer.workerLabel = workerLabelFor(this._workerCli);
    this._extensionPath = options.extensionPath || '';
    this._chromePort = null;
    // Set the qa-desktop path so remote-desktop.js can find the bundled CLI/proxy
    try {
      const { setQaDesktopPath } = require('./src/remote-desktop');
      if (this._extensionPath) setQaDesktopPath(path.join(this._extensionPath, 'qa-desktop'));
    } catch {}
    this._mcpData = { global: {}, project: {} }; // Set via setMcpServers() from extension.js
    this._agentsData = { system: {}, global: {}, project: {} }; // Set via setAgents() from extension.js
    this._modesData = { system: {}, global: {}, project: {} }; // Set via setModes() from extension.js
    this._loopMode = false;
    try { this._selfTesting = !!require('./settings-store').getSetting('selfTesting'); } catch { this._selfTesting = false; }
    this._agentDelegateMcpServer = null;
    this._delegationDepth = 0;
  }

  /** Debug logger for screencast/session lifecycle — writes to same file as chrome-manager. */
  _sDbg(msg) {
    try {
      const fs = require('node:fs');
      const p = require('node:path').join(require('node:os').tmpdir(), 'cc-chrome-debug.log');
      fs.appendFileSync(p, `[${new Date().toISOString()}] [session] ${msg}\n`);
    } catch {}
  }

  /** Sync the chat log path to the renderer whenever the manifest changes. */
  _syncChatLogPath() {
    if (this._activeManifest && this._activeManifest.files && this._activeManifest.files.chatLog) {
      this._renderer.chatLogPath = this._activeManifest.files.chatLog;
    }
  }

  /** Update the MCP server data (both scopes). Called from extension.js. */
  setMcpServers(mcpData) {
    this._mcpData = mcpData || { global: {}, project: {} };
  }

  /** Update the agents data (system + global + project scopes). Called from extension.js. */
  setAgents(agentsData) {
    this._agentsData = agentsData || { system: {}, global: {}, project: {} };
  }

  /** Update the modes data (system + global + project scopes). Called from extension.js. */
  setModes(modesData) {
    this._modesData = modesData || { system: {}, global: {}, project: {} };
  }

  /** Return enabled modes merged from system + global + project (project wins). */
  _enabledModes() {
    const result = {};
    const all = { ...(this._modesData.system || {}), ...(this._modesData.global || {}), ...(this._modesData.project || {}) };
    for (const [id, mode] of Object.entries(all)) {
      if (mode && mode.enabled !== false) {
        result[id] = mode;
      }
    }
    return result;
  }

  /** Return enabled agents merged from system + global + project (project wins). */
  _enabledAgents() {
    const result = {};
    const all = { ...(this._agentsData.system || {}), ...(this._agentsData.global || {}), ...(this._agentsData.project || {}) };
    for (const [id, agent] of Object.entries(all)) {
      if (agent && agent.enabled !== false) {
        result[id] = agent;
      }
    }
    return result;
  }

  _anyAgentUsesApi() {
    return Object.values(this._enabledAgents()).some((agent) => agent && agent.cli === 'api');
  }

  _sharedApiConfig() {
    return {
      provider: this._apiProvider || 'openrouter',
      baseURL: this._apiBaseURL || '',
    };
  }

  _syncActiveManifestApiConfig() {
    if (!this._activeManifest) return;

    const shared = this._sharedApiConfig();
    const anyAgentUsesApi = this._anyAgentUsesApi();
    const needsSharedApiConfig = this._controllerCli === 'api' || this._workerCli === 'api' || anyAgentUsesApi;

    this._activeManifest.controller.model = this._controllerModel || null;
    this._activeManifest.worker.model = this._workerModel || null;
    this._activeManifest.apiConfig = needsSharedApiConfig ? shared : null;
    this._activeManifest.controller.apiConfig = this._controllerCli === 'api'
      ? { ...shared, model: this._controllerModel || '', thinking: this._controllerThinking || '' }
      : null;
    this._activeManifest.worker.apiConfig = (this._workerCli === 'api' || anyAgentUsesApi)
      ? { ...shared, model: this._workerModel || '', thinking: this._workerThinking || '' }
      : null;

    this._activeManifest.controller.config = (this._activeManifest.controller.config || [])
      .filter((entry) => !entry.startsWith('model_reasoning_effort='));
    if (this._controllerCli !== 'api' && this._controllerThinking) {
      this._activeManifest.controller.config.push(`model_reasoning_effort="${this._controllerThinking}"`);
    }
  }

  /** Return servers visible to a given role, stripped of the target field. */
  _mcpServersForRole(role, isRemote = false) {
    const result = {};
    const all = { ...this._mcpData.global, ...this._mcpData.project };
    for (const [name, server] of Object.entries(all)) {
      if (!server) continue;
      const target = server.target || 'both';
      if (target === 'none') continue;
      if (target === 'both' || target === role) {
        const { target: _t, ...rest } = server;
        result[name] = rest;
      }
    }
    // Auto-inject built-in MCP servers as HTTP (reachable from containers via host.docker.internal)
    const mcpHost = isRemote ? 'host.docker.internal' : 'localhost';
    if (this._tasksMcpPort) {
      result['cc-tasks'] = { type: 'http', url: `http://${mcpHost}:${this._tasksMcpPort}/mcp` };
    } else if (this._extensionPath) {
      // Fallback to stdio for local-only use
      result['cc-tasks'] = {
        command: 'node',
        args: [path.join(this._extensionPath, 'tasks-mcp-server.js')],
        env: { TASKS_FILE: path.join(this._repoRoot, '.qpanda', 'tasks.json') },
      };
    }
    if (this._testsMcpPort) {
      result['cc-tests'] = { type: 'http', url: `http://${mcpHost}:${this._testsMcpPort}/mcp` };
    } else if (this._extensionPath) {
      result['cc-tests'] = {
        command: 'node',
        args: [path.join(this._extensionPath, 'tests-mcp-server.js')],
        env: {
          TESTS_FILE: path.join(this._repoRoot, '.qpanda', 'tests.json'),
          TASKS_FILE: path.join(this._repoRoot, '.qpanda', 'tasks.json'),
        },
      };
    }
    if (this._qaDesktopMcpPort && require('./src/feature-flags').getFlag('enableRemoteDesktop')) {
      result['qa-desktop'] = { type: 'http', url: `http://${mcpHost}:${this._qaDesktopMcpPort}/mcp` };
    }
    // Auto-inject agent delegation MCP
    if (this._agentDelegateMcpServer) {
      result['cc-agent-delegate'] = { type: 'http', url: `http://${mcpHost}:${this._agentDelegateMcpServer.port}/mcp` };
    }
    // Auto-inject detached-command MCP (for running shell commands without hanging)
    if (isRemote) {
      // Remote agents: use container-baked path
      result['detached-command'] = {
        command: 'node',
        args: ['/opt/detached-command-mcp/dist/index.js'],
        env: { DETACHED_BASH_MCP_DATA_DIR: '/workspace/.qpanda/.detached-jobs' },
      };
    } else if (this._extensionPath) {
      // Local agents: use extension path
      result['detached-command'] = {
        command: 'node',
        args: [path.join(this._extensionPath, 'detached-command-mcp', 'dist', 'index.js')],
        env: { DETACHED_BASH_MCP_DATA_DIR: path.join(this._repoRoot, '.qpanda', '.detached-jobs') },
      };
    }
    // Auto-inject built-in coding tools MCP ONLY for API mode
    // (codex/claude have their own built-in Read/Write/Edit/Bash tools)
    if (this._extensionPath) {
      const needsBuiltinTools = role === 'controller'
        ? this._controllerCli === 'api'
        : (this._workerCli === 'api' || this._anyAgentUsesApi());
      if (needsBuiltinTools) {
        result['builtin-tools'] = {
          command: 'node',
          args: [path.join(this._extensionPath, 'builtin-tools-mcp-server.js')],
          env: { CWD: this._repoRoot },
        };
      }
    }
    return result;
  }

  // ── Agent delegation MCP ──────────────────────────────────────

  /** Lazy-start the agent delegation MCP HTTP server. */
  async _startAgentDelegateMcp() {
    if (this._agentDelegateMcpServer) return;
    try {
      const { startAgentDelegateMcpServer } = require('./agent-delegate-mcp');
      this._agentDelegateMcpServer = await startAgentDelegateMcpServer({
        onDelegate: (agentId, message) => this._handleDelegation(agentId, message),
        onListAgents: () => this._handleListAgents(),
      });
    } catch (err) {
      console.error('[qapanda] Failed to start agent-delegate MCP:', err.message);
    }
  }

  /** Stop the agent delegation MCP server. */
  _stopAgentDelegateMcp() {
    if (this._agentDelegateMcpServer) {
      try { this._agentDelegateMcpServer.close(); } catch {}
      this._agentDelegateMcpServer = null;
    }
  }

  /**
   * Handle a delegate_to_agent tool call from an agent.
   * Runs the target agent to completion and returns its response text.
   */
  async _handleDelegation(agentId, message) {
    if (this._delegationDepth >= 3) {
      throw new Error('Delegation depth limit reached (max 3). Cannot delegate further to prevent infinite loops.');
    }
    if (!this._activeManifest) {
      throw new Error('No active run. Cannot delegate.');
    }
    const agents = this._enabledAgents();
    if (!agents[agentId]) {
      const available = Object.entries(agents).map(([id, a]) => `${id} (${a.name || id})`).join(', ');
      throw new Error(`Unknown agent "${agentId}". Available agents: ${available}`);
    }

    // Save manifest transient state — runDirectWorkerTurn overwrites these
    const savedStatus = this._activeManifest.status;
    const savedActiveRequestId = this._activeManifest.activeRequestId;
    const savedStopReason = this._activeManifest.stopReason;
    const savedWorkerMcpServers = this._activeManifest.workerMcpServers;

    this._delegationDepth++;
    try {
      // Setup for the delegated agent (same steps as _runDirectAgent)
      this._syncMcpToManifest(agentId);
      await this._ensureChromeIfNeeded(agentId);
      if (this._extensionPath && this._activeManifest) {
        this._activeManifest.extensionDir = this._extensionPath;
      }

      const { runDirectWorkerTurn } = require('./src/orchestrator');
      this._activeManifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
        userMessage: message,
        agentId,
        isDelegation: true,
        abortSignal: this._abortController ? this._abortController.signal : undefined,
      });

      // Extract the delegated agent's response
      const lastReq = this._activeManifest.requests[this._activeManifest.requests.length - 1];
      const resultText = (lastReq && lastReq.latestWorkerResult && lastReq.latestWorkerResult.resultText) || 'Agent completed but returned no text.';
      return resultText;
    } finally {
      this._delegationDepth--;
      // Restore manifest state so the calling agent's run isn't corrupted
      if (this._activeManifest) {
        this._activeManifest.status = savedStatus;
        this._activeManifest.activeRequestId = savedActiveRequestId;
        this._activeManifest.stopReason = savedStopReason;
        this._activeManifest.workerMcpServers = savedWorkerMcpServers;
      }
    }
  }

  /** Handle a list_agents tool call — return available agents as JSON. */
  _handleListAgents() {
    const agents = this._enabledAgents();
    const list = Object.entries(agents).map(([id, agent]) => ({
      id,
      name: agent.name || id,
      description: agent.description || '',
    }));
    return JSON.stringify(list, null, 2);
  }

  applyConfig(config) {
    if (!config) return;
    if (config.controllerModel !== undefined) this._controllerModel = config.controllerModel || null;
    if (config.workerModel !== undefined) this._workerModel = config.workerModel || null;
    if (config.controllerThinking !== undefined) this._controllerThinking = config.controllerThinking || null;
    if (config.workerThinking !== undefined) this._workerThinking = config.workerThinking || null;
    if (config.chatTarget !== undefined) {
      this._chatTarget = config.chatTarget || 'controller';
    }
    if (config.controllerCli !== undefined) {
      const newCli = config.controllerCli || 'codex';
      if (newCli !== this._controllerCli) {
        this._controllerCli = newCli;
        this._renderer.controllerLabel = controllerLabelFor(newCli);
        // Reset incompatible controller session state and model/thinking overrides
        this._controllerModel = null;
        this._controllerThinking = null;
        if (this._activeManifest) {
          this._activeManifest.controller.sessionId = null;
          this._activeManifest.controller.claudeSessionId = null;
          this._activeManifest.controller.cli = newCli;
          this._activeManifest.controller.bin = newCli === 'claude'
            ? (this._runOptions.claudeBin || 'claude')
            : (this._runOptions.codexBin || 'codex');
          this._activeManifest.controller.model = null;
          this._activeManifest.controller.config = [];
          saveManifest(this._activeManifest).catch(() => {});
          this._renderer.banner(`Controller CLI switched to ${newCli}. Controller session and model/thinking reset.`);
        }
        this._syncConfig();
      }
    }
    if (config.codexMode !== undefined) {
      const newMode = config.codexMode || 'cli';
      if (newMode !== this._codexMode) {
        this._codexMode = newMode;
        if (this._activeManifest) {
          // If switching away from app-server, close the persistent connection
          if (newMode !== 'app-server' && this._activeManifest.controller.codexMode === 'app-server') {
            try { require('./src/codex-app-server').closeConnection(this._activeManifest.runId); } catch {}
          }
          this._activeManifest.controller.codexMode = newMode;
          this._activeManifest.controller.appServerThreadId = null;
          saveManifest(this._activeManifest).catch(() => {});
          this._renderer.banner(`Codex mode switched to ${newMode}.`);
        }
        this._syncConfig();
      }
    }
    if (config.workerCli !== undefined) {
      const newWorkerCli = config.workerCli || 'codex';
      if (newWorkerCli !== this._workerCli) {
        this._workerCli = newWorkerCli;
        this._renderer.workerLabel = workerLabelFor(newWorkerCli);
        if (this._activeManifest) {
          this._activeManifest.worker.cli = newWorkerCli;
          this._activeManifest.worker.bin = newWorkerCli;
          saveManifest(this._activeManifest).catch(() => {});
          this._renderer.banner(`Worker CLI switched to ${newWorkerCli}.`);
        }
        this._syncConfig();
      }
    }
    // API config
    if (config.apiProvider !== undefined) this._apiProvider = config.apiProvider || 'openrouter';
    if (config.apiKey !== undefined) this._apiKey = config.apiKey || '';  // resolved from settings by provider
    if (config.apiBaseURL !== undefined) this._apiBaseURL = config.apiBaseURL || '';
    if (this._activeManifest && (
      config.controllerModel !== undefined ||
      config.workerModel !== undefined ||
      config.controllerThinking !== undefined ||
      config.workerThinking !== undefined ||
      config.controllerCli !== undefined ||
      config.workerCli !== undefined ||
      config.apiProvider !== undefined ||
      config.apiBaseURL !== undefined
    )) {
      this._syncActiveManifestApiConfig();
      saveManifest(this._activeManifest).catch(() => {});
    }
    if (config.loopMode !== undefined) {
      this._loopMode = !!config.loopMode;
    }
    if (config.waitDelay !== undefined) {
      this._waitDelay = config.waitDelay || '';
      // Persist to manifest if attached
      if (this._activeManifest) {
        this._activeManifest.waitDelay = this._waitDelay || null;
        // Reschedule or clear the active timer (persists nextWakeAt)
        if (this._waitDelay && this._activeManifest.status === 'running') {
          this._scheduleNextPass();
        } else {
          this._clearWaitTimer();
        }
      }
    }
  }

  get running() {
    return this._running;
  }

  get panelId() {
    return this._panelId;
  }

  get repoRoot() {
    return this._repoRoot;
  }

  /** Return the currently attached run ID, or null. */
  getRunId() {
    return this._activeManifest ? this._activeManifest.runId : null;
  }

  /**
   * Try to reattach to a previously saved run by ID.
   * Returns true if successful, false if the run no longer exists.
   */
  async reattachRun(runId) {
    if (!runId) return false;
    try {
      const runDir = await resolveRunDir(runId, this._stateRoot);
      this._activeManifest = await loadManifestFromDir(runDir);
      this._syncChatLogPath();
      if (this._activeManifest.controller && this._activeManifest.controller.cli) {
        this._renderer.controllerLabel = controllerLabelFor(this._activeManifest.controller.cli);
      }
      if (this._activeManifest.worker) {
        let agentName = null;
        const sessions = this._activeManifest.worker.agentSessions;
        if (sessions) {
          const agentId = Object.keys(sessions).find(id => sessions[id] && sessions[id].hasStarted);
          if (agentId && this._activeManifest.agents && this._activeManifest.agents[agentId]) {
            agentName = this._activeManifest.agents[agentId].name;
          }
        }
        if (this._activeManifest.worker.cli) {
          this._renderer.workerLabel = workerLabelFor(this._activeManifest.worker.cli, agentName);
        }
      }
      this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
      return true;
    } catch {
      // Run no longer exists or is unreadable
      this._postMessage({ type: 'clearRunId' });
      return false;
    }
  }

  /**
   * Read transcript history and send it to the webview for chat rebuild.
   * Supports both transcript v2 and legacy role/text transcript entries.
   */
  async sendTranscript() {
    if (!this._activeManifest || !this._activeManifest.files) return;
    try {
      const filePath = this._activeManifest.files.transcript;
      if (!filePath) return;
      const entries = await readTranscriptEntries(filePath);
      if (entries.length === 0) return;
      const messages = buildTranscriptDisplayMessages(entries, this._activeManifest, {
        fallbackWorkerLabel: this._renderer && this._renderer.workerLabel,
      });
      if (messages.length > 0) {
        this._postMessage({ type: 'transcriptHistory', messages });
      }
    } catch {
      // Chat log unreadable — not fatal
    }
  }

  /** Read the progress file for the attached run and send full contents to webview. */
  async sendProgress() {
    if (!this._activeManifest || !this._activeManifest.files || !this._activeManifest.files.progress) {
      this._postMessage({ type: 'progressFull', text: '' });
      return;
    }
    try {
      const text = await readText(this._activeManifest.files.progress, '');
      this._postMessage({ type: 'progressFull', text });
    } catch {
      this._postMessage({ type: 'progressFull', text: '' });
    }
  }

  /** Stop the in-memory timer without touching disk. Used for shutdown/dispose. */
  _stopWaitTimer() {
    if (this._waitTimer) {
      clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
    this._postMessage({ type: 'waitStatus', active: false });
  }

  /** Durably cancel the timer: null nextWakeAt and errorRetry in memory AND on disk. */
  _clearWaitTimer() {
    this._stopWaitTimer();
    if (this._activeManifest) {
      this._activeManifest.nextWakeAt = null;
      this._activeManifest.errorRetry = false;
      saveManifest(this._activeManifest).catch(() => {});
    }
  }

  _scheduleNextPass() {
    this._clearWaitTimer();
    if (!this._activeManifest || this._activeManifest.status !== 'running') return;
    if (this._running) return; // Don't schedule if already running
    const delayMs = parseWaitDelay(this._waitDelay);
    if (!delayMs) return;

    const wakeAt = new Date(Date.now() + delayMs).toISOString();
    this._activeManifest.nextWakeAt = wakeAt;
    saveManifest(this._activeManifest).catch(() => {});

    this._renderer.banner(`Next auto-pass in ${formatWaitDelay(delayMs)} (at ${wakeAt.slice(11, 19)})`);
    this._postMessage({ type: 'waitStatus', active: true, wakeAt });

    this._waitTimer = setTimeout(async () => {
      this._waitTimer = null;
      if (!this._activeManifest || this._activeManifest.status !== 'running') return;
      if (this._running) return;
      this._activeManifest.nextWakeAt = null;
      this._renderer.banner('Auto-pass starting...');
      try {
        await this._runLoop({ singlePass: true });
        this._scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          this._renderer.banner(`Run error: ${formatRunError(error)}`);
          this._scheduleErrorRetry();
        } else {
          this._renderer.banner('Run stopped by user.');
        }
      } finally {
        this._renderer.close();
      }
    }, delayMs);
  }

  _scheduleErrorRetry() {
    this._stopWaitTimer();
    if (!this._activeManifest) return;
    // Accept both 'running' and 'interrupted' (genuine errors leave status='interrupted')
    if (this._activeManifest.status !== 'running' && this._activeManifest.status !== 'interrupted') return;

    const wakeAt = new Date(Date.now() + ERROR_RETRY_DELAY_MS).toISOString();
    this._activeManifest.nextWakeAt = wakeAt;
    this._activeManifest.errorRetry = true;
    saveManifest(this._activeManifest).catch(() => {});

    this._renderer.banner(`Error backoff: retrying in 30 min (at ${wakeAt.slice(11, 19)})`);
    this._postMessage({ type: 'waitStatus', active: true, wakeAt });

    this._waitTimer = setTimeout(async () => {
      this._waitTimer = null;
      if (!this._activeManifest) return;
      if (this._running) return;
      // Reset status so runManagerLoop can proceed
      this._activeManifest.status = 'running';
      this._activeManifest.nextWakeAt = null;
      this._activeManifest.errorRetry = false;
      this._renderer.banner('Error-retry auto-pass starting...');
      try {
        await this._runLoop({ singlePass: true });
        this._scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          this._renderer.banner(`Run error: ${formatRunError(error)}`);
          this._scheduleErrorRetry();
        } else {
          this._renderer.banner('Run stopped by user.');
        }
      } finally {
        this._renderer.close();
      }
    }, ERROR_RETRY_DELAY_MS);
  }

  /**
   * Restore a pending wait timer from the manifest's nextWakeAt.
   * Called after reattach/resume.
   */
  _restoreWaitTimer() {
    if (!this._activeManifest) return;
    // Restore waitDelay from manifest
    if (this._activeManifest.waitDelay) {
      this._waitDelay = this._activeManifest.waitDelay;
    }
    if (!this._activeManifest.nextWakeAt) return;
    // Accept 'interrupted' status for error retries (genuine errors leave status='interrupted')
    const canRestore = this._activeManifest.status === 'running' ||
      (this._activeManifest.errorRetry && this._activeManifest.status === 'interrupted');
    if (!canRestore) return;
    // Don't restore a stale timer if wait is disabled AND this isn't an error retry
    if (!parseWaitDelay(this._waitDelay) && !this._activeManifest.errorRetry) return;
    const remaining = new Date(this._activeManifest.nextWakeAt).getTime() - Date.now();
    if (remaining > 0) {
      const label = this._activeManifest.errorRetry ? 'Pending error-retry' : 'Pending auto-pass';
      this._renderer.banner(`${label} at ${this._activeManifest.nextWakeAt.slice(11, 19)}`);
      this._postMessage({ type: 'waitStatus', active: true, wakeAt: this._activeManifest.nextWakeAt });
      this._waitTimer = setTimeout(async () => {
        this._waitTimer = null;
        if (!this._activeManifest) return;
        if (this._running) return;
        // Reset status so runManagerLoop can proceed
        this._activeManifest.status = 'running';
        this._activeManifest.nextWakeAt = null;
        this._activeManifest.errorRetry = false;
        this._renderer.banner('Auto-pass starting...');
        try {
          await this._runLoop({ singlePass: true });
          this._scheduleNextPass();
        } catch (error) {
          if (!isAbortError(error)) {
            this._renderer.banner(`Run error: ${formatRunError(error)}`);
            this._scheduleErrorRetry();
          } else {
            this._renderer.banner('Run stopped by user.');
          }
        } finally {
          this._renderer.close();
        }
      }, remaining);
    } else {
      // Wake time passed — run immediately
      this._activeManifest.status = 'running';
      this._activeManifest.nextWakeAt = null;
      this._activeManifest.errorRetry = false;
      this._renderer.banner('Pending auto-pass overdue, starting now...');
      (async () => {
        try {
          await this._runLoop({ singlePass: true });
          this._scheduleNextPass();
        } catch (error) {
          if (!isAbortError(error)) {
            this._renderer.banner(`Run error: ${formatRunError(error)}`);
            this._scheduleErrorRetry();
          } else {
            this._renderer.banner('Run stopped by user.');
          }
        } finally {
          this._renderer.close();
        }
      })();
    }
  }

  async handleMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'abort') {
      this.abort();
      return;
    }

    if (msg.type === 'continueInput') {
      // Continue button: send to controller with optional guidance
      const guidance = (msg.text || '').trim();
      this._handleContinue(guidance);
      return;
    }

    if (msg.type === 'orchestrateInput') {
      // Orchestrate button: full controller orchestration with persistent session
      const text = (msg.text || '').trim();
      await this._handleOrchestrate(text);
      return;
    }

    if (msg.type === 'userInput') {
      await this._handleInput(String(msg.text || '').trim());
      return;
    }

    if (msg.type === 'logChatEntry') {
      // Append an arbitrary entry to chat.jsonl (used for client-side events like screenshots)
      if (this._activeManifest && this._activeManifest.files && this._activeManifest.files.chatLog && msg.entry) {
        try {
          const entry = { ts: new Date().toISOString(), ...msg.entry };
          fs.appendFileSync(this._activeManifest.files.chatLog, JSON.stringify(entry) + '\n');
        } catch {}
      }
      if (this._activeManifest && msg.entry && msg.entry.type) {
        const agentId = this._chatTarget && this._chatTarget.startsWith('agent-')
          ? this._chatTarget.slice('agent-'.length)
          : null;
        const agents = this._enabledAgents();
        const agentConfig = agentId ? agents[agentId] : null;
        const workerCli = (agentConfig && agentConfig.cli) || this._workerCli || (this._activeManifest.worker && this._activeManifest.worker.cli) || 'codex';
        appendTranscriptRecord(this._activeManifest, createTranscriptRecord({
          kind: 'ui_message',
          sessionKey: workerSessionKey(agentId),
          backend: transcriptBackend('worker', workerCli),
          agentId,
          workerCli,
          payload: { ts: new Date().toISOString(), ...msg.entry },
          display: true,
        })).catch(() => {});
      }
      return;
    }

    if (msg.type === 'browserStart') {
      const _sdbg = require('./chrome-manager')._dbg || (() => {});
      _sdbg('[session-manager] browserStart received');
      await this._startChromeDirect();
      return;
    }

    if (msg.type === 'chromeInput') {
      const { sendInput } = require('./chrome-manager');
      sendInput(this._panelId, msg.cdpMethod, msg.cdpParams);
      return;
    }
  }

  abort() {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  _latestRequestMeta() {
    const requests = (this._activeManifest && this._activeManifest.requests) || [];
    const request = requests[requests.length - 1] || null;
    const loops = (request && request.loops) || [];
    const loop = loops[loops.length - 1] || null;
    return {
      requestId: request && request.id ? request.id : null,
      loopIndex: loop && loop.index != null ? loop.index : null,
    };
  }

  async _compactCurrentSession() {
    if (!this._activeManifest) {
      this._renderer.banner('No run is attached.');
      return;
    }
    this._syncActiveManifestApiConfig();

    const {
      compactApiSessionHistory,
      currentApiSessionTarget,
      describeCompactionResult,
    } = require('./src/api-compaction');

    let targetInfo = null;
    if (!this._chatTarget || this._chatTarget === 'controller') {
      targetInfo = currentApiSessionTarget({
        manifest: this._activeManifest,
        target: 'controller',
        controllerCli: this._controllerCli,
        workerCli: this._workerCli,
      });
    } else if (this._chatTarget === 'claude') {
      targetInfo = currentApiSessionTarget({
        manifest: this._activeManifest,
        target: 'worker-default',
        workerCli: this._workerCli,
      });
    } else if (this._chatTarget.startsWith('agent-')) {
      targetInfo = currentApiSessionTarget({
        manifest: this._activeManifest,
        target: 'worker-agent',
        directAgent: this._chatTarget.slice('agent-'.length),
        workerCli: this._workerCli,
      });
    }

    if (!targetInfo) {
      this._renderer.banner('The current target is not using API mode.');
      return;
    }

    const { requestId, loopIndex } = this._latestRequestMeta();
    const label = !this._chatTarget || this._chatTarget === 'controller'
      ? 'Controller session'
      : 'Current agent session';
    this._postMessage({ type: 'running', value: true, showStop: false });
    try {
      const result = await compactApiSessionHistory({
        manifest: this._activeManifest,
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
      this._renderer.banner(describeCompactionResult(result, label));
    } finally {
      this._postMessage({ type: 'running', value: false, showStop: false });
    }
  }

  async _handleInput(text) {
    if (!text) return;
    if (this._running) {
      this._renderer.banner('A request is already running. Use the stop button to abort.');
      return;
    }

    if (text.startsWith('/')) {
      await this._handleCommand(text);
      return;
    }

    // Plain text: start or continue a run — cancel any pending timer
    this._clearWaitTimer();
    try {

      if (!this._activeManifest) {
        this._activeManifest = await prepareNewRun(text, this._buildNewRunOpts());
        this._syncChatLogPath();
        this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
      }
      this._applyWorkerThinking();

      if (this._chatTarget === 'claude') {
        // Direct-to-default-worker: skip controller, no auto-pass scheduling
        await this._runDirectWorker(text);
      } else if (this._chatTarget && this._chatTarget.startsWith('agent-')) {
        const agentId = this._chatTarget.slice('agent-'.length);
        const agents = this._enabledAgents();
        const agent = agents[agentId];
        this._renderer.workerLabel = workerLabelFor(agent && agent.cli, agent && agent.name);
        // Direct-to-agent: Send goes to agent, Loop auto-continues via controller after response
        await this._runDirectAgent(text, agentId);
        // If loop mode is on, auto-fire controller continue after agent responds
        if (this._loopMode && this._activeManifest && this._activeManifest.status === 'idle') {
          this._scheduleLoopContinue();
        }
      } else {
        // Controller mode (traditional)
        await this._runLoop({ userMessage: text });
        this._scheduleNextPass();
      }
    } catch (error) {
      if (!isAbortError(error)) {
        this._renderer.banner(`Run error: ${formatRunError(error)}`);
        // Only schedule error retry for controller path
        const isDirectMode = this._chatTarget === 'claude' || (this._chatTarget && this._chatTarget.startsWith('agent-'));
        if (!isDirectMode) {
          this._scheduleErrorRetry();
        }
      } else {
        this._renderer.banner('Run stopped by user.');
      }
    } finally {
      this._renderer.close();
    }
  }

  async _handleCommand(text) {
    const space = text.indexOf(' ');
    const command = space === -1 ? text : text.slice(0, space);
    const rest = space === -1 ? '' : text.slice(space + 1).trim();

    if (command === '/help') {
      this._renderer.banner(
        'Commands:\n' +
        '  /help                          Show this help\n' +
        '  /new <message>                 Start a new run\n' +
        '  /resume <run-id>               Attach to an existing run\n' +
        '  /run                           Continue an interrupted request\n' +
        '  /status                        Show status for the attached run\n' +
        '  /list                          List saved runs\n' +
        '  /logs [n]                      Show the last n event lines\n' +
        '  /clear                         Clear chat and start fresh\n' +
        '  /compact                       Compact the current API session now\n' +
        '  /detach                        Detach from the current run\n' +
        '  /controller-model [name]       Set/show Codex model\n' +
        '  /worker-model [name]           Set/show Claude model\n' +
        '  /controller-thinking [level]   Set/show Codex thinking tier\n' +
        '  /worker-thinking [level]       Set/show Claude thinking level\n' +
        '  /wait [delay]                  Set auto-pass delay (e.g. 5m, 1h, none)\n' +
        '  /config                        Show current model/thinking config\n' +
        '  /workflow [name]               List or run a workflow\n' +
        '\nPlain text starts a new run or continues the current one.'
      );
      return;
    }

    if (command === '/clear') {
      this._clearWaitTimer();
      // Close the old app-server connection (if any) and re-prestart for the next run
      if (this._activeManifest && this._activeManifest.controller.codexMode === 'app-server') {
        const { closeConnection } = require('./src/codex-app-server');
        closeConnection(this._activeManifest.runId).catch(() => {});
      }
      this._activeManifest = null;
      this._postMessage({ type: 'clear' });
      this._postMessage({ type: 'clearRunId' });
      this._postMessage({ type: 'progressFull', text: '' });
      this._renderer.banner('Session cleared.');
      // Re-prestart app-server so next message is fast
      this.prestart();
      return;
    }

    if (command === '/compact') {
      await this._compactCurrentSession();
      return;
    }

    if (command === '/detach') {
      this._clearWaitTimer();
      this._activeManifest = null;
      this._postMessage({ type: 'clearRunId' });
      this._postMessage({ type: 'progressFull', text: '' });
      this._renderer.banner('Detached from the current run.');
      return;
    }

    if (command === '/list') {
      const manifests = await listRunManifests(this._stateRoot);
      if (manifests.length === 0) {
        this._renderer.banner('No runs found.');
      } else {
        for (const manifest of manifests) {
          this._renderer.banner(`${manifest.runId} | ${manifest.status} | ${manifest.transcriptSummary || ''}`);
        }
      }
      return;
    }

    if (command === '/resume' || command === '/use') {
      if (!rest) {
        // No run ID — show history picker
        try {
          const manifests = await listRunManifests(this._stateRoot);
          const runs = manifests.map(m => ({
            runId: m.runId,
            title: m.transcriptSummary || m.runId,
            status: m.status || 'idle',
            updatedAt: m.updatedAt || m.createdAt,
          }));
          this._postMessage({ type: 'runHistory', runs });
        } catch {
          this._renderer.banner('No previous sessions found.');
        }
        return;
      }
      this._clearWaitTimer();
      const runDir = await resolveRunDir(rest, this._stateRoot);
      this._activeManifest = await loadManifestFromDir(runDir);
      this._syncChatLogPath();
      if (this._activeManifest.controller && this._activeManifest.controller.cli) {
        this._renderer.controllerLabel = controllerLabelFor(this._activeManifest.controller.cli);
      }
      if (this._activeManifest.worker) {
        let agentName = null;
        const sessions = this._activeManifest.worker.agentSessions;
        if (sessions) {
          const agentId = Object.keys(sessions).find(id => sessions[id] && sessions[id].hasStarted);
          if (agentId && this._activeManifest.agents && this._activeManifest.agents[agentId]) {
            agentName = this._activeManifest.agents[agentId].name;
          }
        }
        if (this._activeManifest.worker.cli) {
          this._renderer.workerLabel = workerLabelFor(this._activeManifest.worker.cli, agentName);
        }
      }
      this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
      await this.sendTranscript();
      this._renderer.requestStarted(this._activeManifest.runId);
      await this.sendProgress();
      this._restoreWaitTimer();
      return;
    }

    if (command === '/status') {
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      // Collect output into a string and send as banner
      const lines = [];
      const fakeOut = { write: (t) => lines.push(t) };
      await printRunSummary(this._activeManifest, fakeOut);
      this._renderer.banner(lines.join(''));
      return;
    }

    if (command === '/logs') {
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      const tail = rest ? Number.parseInt(rest, 10) || 40 : 40;
      const lines = [];
      const fakeOut = { write: (t) => lines.push(t) };
      await printEventTail(this._activeManifest, tail, fakeOut);
      this._renderer.banner(lines.join(''));
      return;
    }

    if (command === '/run') {
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      this._clearWaitTimer();
      try {
        await this._runLoop({});
        this._scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          this._renderer.banner(`Run error: ${formatRunError(error)}`);
          this._scheduleErrorRetry();
        } else {
          this._renderer.banner('Run stopped by user.');
        }
      } finally {
        this._renderer.close();
      }
      return;
    }

    if (command === '/new') {
      if (!rest) {
        this._renderer.banner('Usage: /new <message>');
        return;
      }
      this._clearWaitTimer();

      this._activeManifest = await prepareNewRun(rest, this._buildNewRunOpts());
      this._syncChatLogPath();
      this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
      this._renderer.requestStarted(this._activeManifest.runId);
      this._applyWorkerThinking();
      try {
        await this._runLoop({ userMessage: rest });
        this._scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          this._renderer.banner(`Run error: ${formatRunError(error)}`);
          this._scheduleErrorRetry();
        } else {
          this._renderer.banner('Run stopped by user.');
        }
      } finally {
        this._renderer.close();
      }
      return;
    }

    if (command === '/controller-model') {
      if (!rest) {
        const current = this._controllerModel || (this._activeManifest && this._activeManifest.controller.model) || '(default)';
        const options = CODEX_MODELS.map(m => `  ${m.value} - ${m.label}`).join('\n');
        this._renderer.banner(`Controller model: ${current}\n\nAvailable:\n${options}\n  <custom> - Any model name`);
        return;
      }
      this._controllerModel = rest;
      if (this._activeManifest) {
        this._activeManifest.controller.model = rest;
      }
      this._renderer.banner(`Controller model set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/worker-model') {
      if (!rest) {
        const current = this._workerModel || (this._activeManifest && this._activeManifest.worker.model) || '(default)';
        const options = CLAUDE_MODELS.map(m => `  ${m.value} - ${m.label}`).join('\n');
        this._renderer.banner(`Worker model: ${current}\n\nAvailable:\n${options}\n  <custom> - Any model name`);
        return;
      }
      this._workerModel = rest;
      if (this._activeManifest) {
        this._activeManifest.worker.model = rest;
      }
      this._renderer.banner(`Worker model set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/controller-thinking') {
      if (!rest) {
        const current = this._controllerThinking || '(default)';
        const options = CODEX_THINKING.map(t => `  ${t.value} - ${t.label}`).join('\n');
        this._renderer.banner(`Controller thinking: ${current}\n\nAvailable:\n${options}`);
        return;
      }
      this._controllerThinking = rest;
      if (this._activeManifest) {
        // Remove any existing reasoning effort config entries
        this._activeManifest.controller.config = (this._activeManifest.controller.config || [])
          .filter(c => !c.startsWith('model_reasoning_effort='));
        this._activeManifest.controller.config.push(`model_reasoning_effort="${rest}"`);
      }
      this._renderer.banner(`Controller thinking set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/worker-thinking') {
      if (!rest) {
        const current = this._workerThinking || '(default)';
        const options = CLAUDE_THINKING.map(t => `  ${t.value} - ${t.label}`).join('\n');
        this._renderer.banner(`Worker thinking: ${current}\n\nAvailable:\n${options}`);
        return;
      }
      this._workerThinking = rest;
      this._renderer.banner(`Worker thinking set to: ${rest}`);
      this._syncConfig();
      return;
    }

    if (command === '/wait') {
      if (!rest) {
        const current = this._waitDelay || 'none';
        const opts = WAIT_OPTIONS.map(o => `  ${o.value || 'none'} — ${o.label}`).join('\n');
        this._renderer.banner(`Wait delay: ${current}\n\nAvailable:\n${opts}`);
        return;
      }
      const val = rest === 'none' || rest === 'off' || rest === '0' ? '' : rest;
      const ms = parseWaitDelay(val);
      if (val && !ms) {
        this._renderer.banner(`Unknown delay: ${rest}. Use /wait for options.`);
        return;
      }
      this._waitDelay = val;
      if (this._activeManifest) {
        this._activeManifest.waitDelay = val || null;
        // Reschedule or clear timer (persists nextWakeAt)
        if (val && this._activeManifest.status === 'running') {
          this._scheduleNextPass();
        } else {
          this._clearWaitTimer();
        }
      }
      this._renderer.banner(`Wait delay set to: ${val ? formatWaitDelay(ms) : 'none'}`);
      this._syncConfig();
      return;
    }

    if (command === '/config') {
      const cm = this._controllerModel || (this._activeManifest && this._activeManifest.controller.model) || '(default)';
      const wm = this._workerModel || (this._activeManifest && this._activeManifest.worker.model) || '(default)';
      const ct = this._controllerThinking || '(default)';
      const wt = this._workerThinking || '(default)';
      this._renderer.banner(
        `Current config:\n` +
        `  Controller model:    ${cm}\n` +
        `  Controller thinking: ${ct}\n` +
        `  Worker model:        ${wm}\n` +
        `  Worker thinking:     ${wt}`
      );
      return;
    }

    if (command === '/workflow') {
      const workflows = loadWorkflows(this._repoRoot);
      if (!rest) {
        // List available workflows
        if (workflows.length === 0) {
          this._renderer.banner('No workflows found.\nPlace workflow directories in .qpanda/workflows/ or ~/.qpanda/workflows/\nEach must contain a WORKFLOW.md with YAML frontmatter (name, description).');
        } else {
          const lines = ['Available workflows:'];
          for (const wf of workflows) {
            lines.push(`  ${wf.name} — ${wf.description}`);
          }
          this._renderer.banner(lines.join('\n'));
        }
        return;
      }
      // Find and run a workflow by name
      const wf = workflows.find(w => w.name === rest);
      if (!wf) {
        this._renderer.banner(`Workflow "${rest}" not found. Use /workflow to list available workflows.`);
        return;
      }
      // Read the full WORKFLOW.md and use it as the user message
      let content;
      try {
        content = fs.readFileSync(wf.path, 'utf8').trim();
      } catch (err) {
        this._renderer.banner(`Failed to read workflow file: ${err.message}`);
        return;
      }
      const message = `Run the workflow "${wf.name}". Read the full instructions at: ${wf.path}\n\nWorkflow summary: ${wf.description}\n\nFull workflow instructions:\n${content}`;
      this._clearWaitTimer();
      try {
  
        if (!this._activeManifest) {
          this._activeManifest = await prepareNewRun(message, this._buildNewRunOpts());
          this._syncChatLogPath();
          this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
        }
        this._applyWorkerThinking();
        await this._runLoop({ userMessage: message });
        this._scheduleNextPass();
      } catch (error) {
        if (!isAbortError(error)) {
          this._renderer.banner(`Run error: ${formatRunError(error)}`);
          this._scheduleErrorRetry();
        } else {
          this._renderer.banner('Run stopped by user.');
        }
      } finally {
        this._renderer.close();
      }
      return;
    }

    this._renderer.banner(`Unknown command: ${command}`);
  }

  /** Build the options object for prepareNewRun, applying current config. */
  _buildNewRunOpts() {
    const opts = {
      ...this._runOptions,
      repoRoot: this._repoRoot,
      stateRoot: this._stateRoot,
      panelId: this._panelId,
      extensionDir: this._extensionPath,
    };
    // Read useSnapshot from per-workspace config so remote agents respect the checkbox
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this._repoRoot, '.qpanda', 'config.json'), 'utf8'));
      opts.useSnapshot = cfg.useSnapshot !== false;
    } catch {
      opts.useSnapshot = true;
    }
    if (this._controllerCli) opts.controllerCli = this._controllerCli;
    if (this._codexMode) opts.controllerCodexMode = this._codexMode;
    if (this._controllerModel && this._controllerCli !== 'claude') opts.controllerModel = this._controllerModel;
    if (this._workerCli) opts.workerCli = this._workerCli;
    if (this._workerModel) opts.workerModel = this._workerModel;
    // Split MCP servers by target role; workers using qa-remote-* backends need host.docker.internal URLs
    const workerIsRemote = typeof this._workerCli === 'string' && this._workerCli.startsWith('qa-remote');
    const controllerMcp = this._mcpServersForRole('controller', false);
    const workerMcp = this._mcpServersForRole('worker', workerIsRemote);
    if (Object.keys(controllerMcp).length > 0) opts.controllerMcpServers = controllerMcp;
    if (Object.keys(workerMcp).length > 0) opts.workerMcpServers = workerMcp;
    const agents = this._enabledAgents();
    if (Object.keys(agents).length > 0) opts.agents = agents;
    // API config (for BYOK mode) — always include if any agent or config uses API
    const anyAgentUsesApi = Object.values(agents).some(a => a && a.cli === 'api');
    if (this._controllerCli === 'api' || this._workerCli === 'api' || anyAgentUsesApi) {
      opts.apiConfig = {
        provider: this._apiProvider || 'openrouter',
        baseURL: this._apiBaseURL || '',
      };
      if (this._controllerCli === 'api') {
        opts.controllerApiConfig = { ...opts.apiConfig, model: this._controllerModel || '', thinking: this._controllerThinking || '' };
      }
      if (this._workerCli === 'api' || anyAgentUsesApi) {
        opts.workerApiConfig = { ...opts.apiConfig, model: this._workerModel || '', thinking: this._workerThinking || '' };
      }
    }
    if (this._selfTesting) {
      opts.selfTesting = true;
      // Load custom prompts from settings
      const settings = require('./settings-store').loadSettings();
      const customPrompts = {};
      if (settings.selfTestPromptController) customPrompts.controller = settings.selfTestPromptController;
      if (settings.selfTestPromptQaBrowser) customPrompts['qa-browser'] = settings.selfTestPromptQaBrowser;
      if (settings.selfTestPromptAgent) customPrompts.agent = settings.selfTestPromptAgent;
      if (Object.keys(customPrompts).length > 0) opts.selfTestPrompts = customPrompts;
    }
    if (this._controllerThinking) {
      // Only pass reasoning effort config for Codex; Claude uses env var or ignores it
      if (this._controllerCli !== 'claude') {
        opts.controllerConfig = [
          ...(opts.controllerConfig || []),
          `model_reasoning_effort="${this._controllerThinking}"`,
        ];
      }
    }
    return opts;
  }

  /** Set or clear CLAUDE_CODE_EFFORT_LEVEL based on worker thinking config. */
  _applyWorkerThinking() {
    if (this._workerThinking) {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = this._workerThinking;
    } else {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    }
  }

  _getConfig() {
    return {
      controllerModel: this._controllerModel || '',
      workerModel: this._workerModel || '',
      controllerThinking: this._controllerThinking || '',
      workerThinking: this._workerThinking || '',
      waitDelay: this._waitDelay || '',
      chatTarget: this._chatTarget || 'controller',
      controllerCli: this._controllerCli || 'codex',
      codexMode: this._codexMode || 'app-server',
      workerCli: this._workerCli || 'codex',
      apiProvider: this._apiProvider || 'openrouter',
      apiBaseURL: this._apiBaseURL || '',
    };
  }

  /**
   * Pre-start Chrome and Codex app-server in the background.
   * Called right after panel creation to speed up the first message.
   * Chrome starts first (so we have the debug port), then Codex app-server.
   */
  prestart() {
    // Run the async sequence in the background (fire-and-forget)
    this._prestartAsync().catch(() => {});
  }

  async _prestartAsync() {
    const agents = this._enabledAgents();

    // Determine what needs pre-starting
    const needsChrome = !this._chromePort && Object.values(agents).some(a =>
      a && a.mcps && Object.keys(a.mcps).some(n =>
        n.includes('chrome-devtools') || n.includes('chrome_devtools')
      )
    );

    this._sDbg(`_prestartAsync: panelId=${this._panelId} needsChrome=${needsChrome}`);

    // Step 1: Start Chrome (if needed) — must complete before Codex so we have the port
    // NOTE: prestart() is only called after the webview 'ready' message restores panelId,
    // so this._panelId is stable here.
    if (needsChrome) {
      try {
        const { ensureChrome, startScreencast } = require('./chrome-manager');
        this._sDbg(`prestart: calling ensureChrome panelId=${this._panelId}`);
        const chrome = await ensureChrome(this._panelId);
        if (chrome) {
          this._chromePort = chrome.port;
          this._sDbg(`prestart: Chrome on port ${chrome.port}, calling startScreencast panelId=${this._panelId}`);
          await startScreencast(this._panelId, (frameData, metadata) => {
            this._postMessage({ type: 'chromeFrame', data: frameData, metadata });
          }, (url) => {
            this._postMessage({ type: 'chromeUrl', url });
          });
          this._sDbg('prestart: startScreencast returned, posting chromeReady');
          this._postMessage({ type: 'chromeReady', chromePort: chrome.port });
        }
      } catch (e) {
        this._sDbg(`prestart: Chrome error: ${e.message}`);
      }
    }

    // Step 2: Start agent-delegate MCP so it's included in the fingerprint
    await this._startAgentDelegateMcp();

    // Step 3: Pre-start Codex app-server (now chromeDebugPort and agent-delegate are set)
    const { prestartConnection } = require('./src/codex-app-server');
    const controllerMcps = this._mcpServersForRole('controller', false);
    const workerMcps = this._mcpServersForRole('worker', false);
    // Merge default agent MCPs (pick first enabled agent with MCPs)
    let defaultAgentMcps = {};
    for (const a of Object.values(agents)) {
      if (a && a.mcps && Object.keys(a.mcps).length > 0) {
        defaultAgentMcps = a.mcps;
        break;
      }
    }
    const fullWorkerMcps = { ...workerMcps, ...defaultAgentMcps };
    const baseManifest = {
      repoRoot: this._repoRoot,
      extensionDir: this._extensionPath,
      chromeDebugPort: this._chromePort || null,
    };

    // Pre-start controller and worker connections in parallel
    await Promise.all([
      prestartConnection({
        key: 'prestart',
        bin: 'codex',
        cwd: this._repoRoot,
        mcpServers: controllerMcps,
        manifest: baseManifest,
      }).catch(() => {}),
      prestartConnection({
        key: 'prestart-worker',
        bin: 'codex',
        cwd: this._repoRoot,
        mcpServers: fullWorkerMcps,
        manifest: baseManifest,
      }).catch(() => {}),
    ]);

    // Prestart complete — store flag so first message doesn't show "Waiting..."
    this._prestartDone = true;
  }

  _syncConfig() {
    this._postMessage({ type: 'syncConfig', config: this._getConfig() });
  }

  /** Sync current MCP server config and agents into the active manifest before each run. */
  _syncMcpToManifest(agentId) {
    if (!this._activeManifest) return;
    // Check if the active agent uses a remote CLI
    let workerIsRemote = typeof this._workerCli === 'string' && this._workerCli.startsWith('qa-remote');
    if (!workerIsRemote && agentId) {
      const agents = this._enabledAgents();
      const agent = agents[agentId];
      if (agent && typeof agent.cli === 'string' && agent.cli.startsWith('qa-remote')) {
        workerIsRemote = true;
      }
    }
    // Also check the current chat target if it's an agent
    if (!workerIsRemote && this._chatTarget && this._chatTarget.startsWith('agent-')) {
      const targetAgentId = this._chatTarget.slice('agent-'.length);
      const agents = this._enabledAgents();
      const agent = agents[targetAgentId];
      if (agent && typeof agent.cli === 'string' && agent.cli.startsWith('qa-remote')) {
        workerIsRemote = true;
      }
    }
    const controllerMcp = this._mcpServersForRole('controller', false);
    const workerMcp = this._mcpServersForRole('worker', workerIsRemote);
    this._activeManifest.controllerMcpServers = Object.keys(controllerMcp).length > 0 ? controllerMcp : null;
    this._activeManifest.workerMcpServers = Object.keys(workerMcp).length > 0 ? workerMcp : null;
    // Sync enabled agents
    this._activeManifest.agents = this._enabledAgents();
    if (!this._activeManifest.worker.agentSessions) this._activeManifest.worker.agentSessions = {};
  }

  /** Start headless Chrome if a local agent needs chrome-devtools MCP. */
  async _ensureChromeIfNeeded(agentId) {
    // Determine which CLI will run
    let cli = this._workerCli || 'codex';
    if (agentId) {
      const agents = this._enabledAgents();
      const agent = agents[agentId];
      if (agent && agent.cli) cli = agent.cli;
    }
    // Remote agents have their own Chrome inside the container
    if (typeof cli === 'string' && cli.startsWith('qa-remote')) return;

    // Check if any MCP server looks like chrome-devtools
    const mcpServers = this._activeManifest
      ? (this._activeManifest.workerMcpServers || {})
      : {};
    const agentMcps = agentId ? ((this._enabledAgents()[agentId] || {}).mcps || {}) : {};
    const allMcps = { ...mcpServers, ...agentMcps };
    const hasChromeDevtools = Object.keys(allMcps).some(n =>
      n.includes('chrome-devtools') || n.includes('chrome_devtools')
    );
    if (!hasChromeDevtools) return;

    if (!this._chromePort) {
      try {
        const { ensureChrome, startScreencast } = require('./chrome-manager');
        this._sDbg(`_ensureChromeIfNeeded: starting Chrome panelId=${this._panelId}`);
        this._renderer.banner('Waiting for headless Chrome\u2026');
        const chrome = await ensureChrome(this._panelId);
        if (chrome) {
          this._chromePort = chrome.port;
          if (this._activeManifest) this._activeManifest.chromeDebugPort = chrome.port;
          this._sDbg(`_ensureChromeIfNeeded: Chrome on port ${chrome.port}, calling startScreencast`);
          await startScreencast(this._panelId, (frameData, metadata) => {
            this._postMessage({ type: 'chromeFrame', data: frameData, metadata });
          }, (url) => {
            this._postMessage({ type: 'chromeUrl', url });
          });
          this._sDbg('_ensureChromeIfNeeded: startScreencast returned, posting chromeReady');
          this._postMessage({ type: 'chromeReady', chromePort: chrome.port });
        }
      } catch (err) {
        this._sDbg(`_ensureChromeIfNeeded: error: ${err.message}`);
        console.error('[session-manager] Failed to start Chrome:', err.message);
      }
    }

    // Always ensure the port is on the manifest for buildClaudeArgs to use
    if (this._chromePort && this._activeManifest) {
      this._activeManifest.chromeDebugPort = this._chromePort;
    }
    // Always ensure extensionDir is on the manifest for placeholder replacement
    if (this._extensionPath && this._activeManifest) {
      this._activeManifest.extensionDir = this._extensionPath;
    }
  }

  /** Start headless Chrome directly (e.g. from Browser tab click). */
  async _startChromeDirect() {
    const { ensureChrome, startScreencast } = require('./chrome-manager');
    this._sDbg(`_startChromeDirect called, panelId=${this._panelId}, existing chromePort=${this._chromePort}`);
    if (this._chromePort) {
      this._sDbg('_startChromeDirect: Chrome already running, sending chromeReady');
      this._postMessage({ type: 'chromeReady', chromePort: this._chromePort });
      return;
    }
    try {
      const chrome = await ensureChrome(this._panelId);
      this._sDbg(`_startChromeDirect: ensureChrome returned: ${JSON.stringify(chrome)}`);
      if (chrome) {
        this._chromePort = chrome.port;
        this._sDbg(`_startChromeDirect: Chrome on port ${chrome.port}, calling startScreencast`);
        await startScreencast(this._panelId, (frameData, metadata) => {
          this._postMessage({ type: 'chromeFrame', data: frameData, metadata });
        }, (url) => {
          this._postMessage({ type: 'chromeUrl', url });
        });
        this._sDbg('_startChromeDirect: startScreencast returned, posting chromeReady');
        this._postMessage({ type: 'chromeReady', chromePort: chrome.port });
      } else {
        this._sDbg('_startChromeDirect: ensureChrome returned null');
        this._postMessage({ type: 'chromeGone' });
      }
    } catch (err) {
      this._sDbg(`_startChromeDirect: EXCEPTION: ${err.message}\n${err.stack}`);
      this._postMessage({ type: 'chromeGone' });
    }
  }

  async _runDirectWorker(userMessage) {
    await this._startAgentDelegateMcp();
    this._syncMcpToManifest();
    await this._ensureChromeIfNeeded();
    // Ensure extensionDir is always on the manifest for MCP placeholder replacement
    if (this._extensionPath && this._activeManifest) {
      this._activeManifest.extensionDir = this._extensionPath;
    }
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });

    try {
      this._activeManifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
        userMessage,
        abortSignal: this._abortController.signal,
      });
      if (this._activeManifest.waitDelay !== (this._waitDelay || null)) {
        this._activeManifest.waitDelay = this._waitDelay || null;
      }
      await saveManifest(this._activeManifest);
    } finally {
      this._running = false;
      this._abortController = null;
      this._postMessage({ type: 'running', value: false });
    }
  }

  async _runDirectAgent(userMessage, agentId) {
    await this._startAgentDelegateMcp();
    this._syncMcpToManifest(agentId);
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });
    await this._ensureChromeIfNeeded(agentId);
    // Ensure extensionDir is always on the manifest for MCP placeholder replacement
    if (this._extensionPath && this._activeManifest) {
      this._activeManifest.extensionDir = this._extensionPath;
    }

    try {
      this._activeManifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
        userMessage,
        agentId,
        abortSignal: this._abortController.signal,
      });
      if (this._activeManifest.waitDelay !== (this._waitDelay || null)) {
        this._activeManifest.waitDelay = this._waitDelay || null;
      }
      await saveManifest(this._activeManifest);
    } finally {
      this._running = false;
      this._abortController = null;
      this._postMessage({ type: 'running', value: false });
    }
  }

  /**
   * Copilot mode: user → agent directly, then controller watches and auto-continues.
   */
  /**
   * Handle Continue button: run one controller→agent cycle with optional guidance.
   */
  async _handleContinue(guidance) {
    if (this._running) return;
    try {
      await this._runControllerContinue(guidance);
    } catch (error) {
      if (!isAbortError(error)) {
        this._renderer.banner(`Run error: ${formatRunError(error)}`);
      } else {
        this._renderer.banner('Run stopped by user.');
      }
    }
  }

  /**
   * Run one controller turn (reads transcript, decides what to tell the agent).
   * The controller uses singlePass=true so it runs one controller→agent cycle then returns.
   */
  async _runControllerContinue(guidance) {
    // Ensure we have an active manifest
    if (!this._activeManifest) {
      this._renderer.banner('No active run. Send a message first, then use Continue.');
      return;
    }

    // Determine the current target agent for the directive
    let currentAgentId = null;
    if (this._chatTarget && this._chatTarget.startsWith('agent-')) {
      currentAgentId = this._chatTarget.slice('agent-'.length);
    }

    // Save original prompt, temporarily append continue directive
    const originalPrompt = this._activeManifest.controllerSystemPrompt;
    const basePrompt = originalPrompt || this._buildCopilotBasePrompt();
    const continueDirective = this._buildContinueDirective(guidance, currentAgentId);
    this._activeManifest.controllerSystemPrompt = basePrompt + '\n\n' + continueDirective;

    // Copilot mode: fresh one-shot controller — don't resume any existing session.
    // Save the direct-mode session ID so it's not lost.
    const savedControllerSessionId = this._activeManifest.controller.sessionId;
    this._activeManifest.controller.sessionId = null;

    await this._startAgentDelegateMcp();
    this._syncMcpToManifest();
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });
    try {
      const { runManagerLoop } = require('./src/orchestrator');
      // The user message for the controller is always a neutral "decide next step" instruction.
      // User guidance is already in the system prompt via the continue directive.
      const userMessage = guidance
        ? `[CONTROLLER GUIDANCE] ${guidance}`
        : '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.';
      this._activeManifest = await runManagerLoop(this._activeManifest, this._renderer, {
        userMessage,
        abortSignal: this._abortController.signal,
        singlePass: true,
        controllerLabel: 'Continue',
      });
      await saveManifest(this._activeManifest);
      // If loop mode is on and the run didn't stop, auto-continue
      if (this._loopMode && this._activeManifest && this._activeManifest.status === 'running') {
        this._scheduleLoopContinue();
      }
    } finally {
      // Restore original prompt and controller session ID
      this._activeManifest.controllerSystemPrompt = originalPrompt;
      this._activeManifest.controller.sessionId = savedControllerSessionId;
      this._running = false;
      this._abortController = null;
      this._postMessage({ type: 'running', value: false });
    }
  }

  /** Base copilot prompt — delegates to shared builder in prompts.js */
  _buildCopilotBasePrompt() {
    return buildCopilotBasePrompt({ selfTesting: this._selfTesting });
  }

  /** Continue directive — delegates to shared builder in prompts.js */
  _buildContinueDirective(guidance, currentAgentId) {
    return buildContinueDirective(guidance, currentAgentId);
  }

  /**
   * Schedule the next loop iteration (auto-continue via controller).
   */
  _scheduleLoopContinue() {
    if (!this._loopMode) return;
    // Small delay to let UI update before next cycle
    setTimeout(() => {
      if (!this._loopMode || this._running) return;
      this._handleContinue('');
    }, 500);
  }

  /**
   * Handle Orchestrate button — full controller orchestration with persistent session.
   * Loop OFF = one controller→agent cycle, Loop ON = keeps going until controller says STOP.
   */
  async _handleOrchestrate(text) {
    if (this._running) return;
    this._clearWaitTimer();
    try {
      if (!this._activeManifest) {
        this._activeManifest = await prepareNewRun(text || '[ORCHESTRATE]', this._buildNewRunOpts());
        this._syncChatLogPath();
        this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
      }
      this._applyWorkerThinking();

      // Run the direct controller (persistent session, full prompt)
      // Always loop until the controller says STOP — that's the point of Orchestrate
      await this._runLoop({
        userMessage: text || '[ORCHESTRATE] Decide the next step based on the conversation transcript.',
      });
    } catch (error) {
      if (!isAbortError(error)) {
        this._renderer.banner(`Orchestrate error: ${formatRunError(error)}`);
      } else {
        this._renderer.banner('Orchestrate stopped by user.');
      }
    } finally {
      this._renderer.close();
    }
  }

  async _runLoop(options) {
    await this._startAgentDelegateMcp();
    this._syncMcpToManifest();
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });

    const delayMs = parseWaitDelay(this._waitDelay);
    const useSinglePass = Boolean(delayMs && options.singlePass !== false);

    try {
      this._activeManifest = await runManagerLoop(this._activeManifest, this._renderer, {
        ...options,
        singlePass: useSinglePass || options.singlePass,
        abortSignal: this._abortController.signal,
      });
      if (this._activeManifest.waitDelay !== (this._waitDelay || null)) {
        this._activeManifest.waitDelay = this._waitDelay || null;
      }
      await saveManifest(this._activeManifest);
    } finally {
      this._running = false;
      this._abortController = null;
      this._postMessage({ type: 'running', value: false });
    }
  }

  dispose() {
    this._stopWaitTimer();
    this.abort();
    this._stopAgentDelegateMcp();
    // Close any persistent interactive Claude sessions
    if (this._activeManifest) {
      try { closeInteractiveSessions(this._activeManifest); } catch {}
    }
  }
}

module.exports = { SessionManager };
