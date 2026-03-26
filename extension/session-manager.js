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
    this._waitDelay = init.waitDelay || '';
    this._chatTarget = init.chatTarget || 'controller';
    this._controllerCli = init.controllerCli || 'codex';
    this._renderer.controllerLabel = controllerLabelFor(this._controllerCli);
    this._workerCli = init.workerCli || 'claude';
    this._renderer.workerLabel = workerLabelFor(this._workerCli);
    this._extensionPath = options.extensionPath || '';
    // Set the qa-desktop path so remote-desktop.js can find the bundled CLI/proxy
    try {
      const { setQaDesktopPath } = require('./src/remote-desktop');
      if (this._extensionPath) setQaDesktopPath(path.join(this._extensionPath, 'qa-desktop'));
    } catch {}
    this._mcpData = { global: {}, project: {} }; // Set via setMcpServers() from extension.js
    this._agentsData = { system: {}, global: {}, project: {} }; // Set via setAgents() from extension.js
    this._modesData = { system: {}, global: {}, project: {} }; // Set via setModes() from extension.js
    this._currentMode = null;
    this._testEnv = null;
    this._loopMode = false;
    this._agentDelegateMcpServer = null;
    this._delegationDepth = 0;
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
        env: { TASKS_FILE: path.join(this._repoRoot, '.cc-manager', 'tasks.json') },
      };
    }
    if (this._testsMcpPort) {
      result['cc-tests'] = { type: 'http', url: `http://${mcpHost}:${this._testsMcpPort}/mcp` };
    } else if (this._extensionPath) {
      result['cc-tests'] = {
        command: 'node',
        args: [path.join(this._extensionPath, 'tests-mcp-server.js')],
        env: {
          TESTS_FILE: path.join(this._repoRoot, '.cc-manager', 'tests.json'),
          TASKS_FILE: path.join(this._repoRoot, '.cc-manager', 'tasks.json'),
        },
      };
    }
    if (this._qaDesktopMcpPort) {
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
        env: { DETACHED_BASH_MCP_DATA_DIR: '/workspace/.cc-manager/.detached-jobs' },
      };
    } else if (this._extensionPath) {
      // Local agents: use extension path
      result['detached-command'] = {
        command: 'node',
        args: [path.join(this._extensionPath, 'detached-command-mcp', 'dist', 'index.js')],
        env: { DETACHED_BASH_MCP_DATA_DIR: path.join(this._repoRoot, '.cc-manager', '.detached-jobs') },
      };
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
      console.error('[cc-manager] Failed to start agent-delegate MCP:', err.message);
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
    if (config.mode !== undefined) {
      this._currentMode = config.mode || null;
      this._testEnv = config.testEnv || null;
      // When a mode is selected, override chat target accordingly
      if (this._currentMode) {
        const modes = this._enabledModes();
        const mode = modes[this._currentMode];
        if (mode) {
          if (!mode.useController) {
            this._chatTarget = 'agent-' + (mode.defaultAgent || 'QA-Browser');
          } else {
            this._chatTarget = 'controller';
          }
        }
      }
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
    if (config.workerCli !== undefined) {
      const newWorkerCli = config.workerCli || 'claude';
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
   * Read the transcript file and send it to the webview for chat history rebuild.
   * Maps transcript roles to webview message types.
   */
  async sendTranscript() {
    if (!this._activeManifest || !this._activeManifest.files || !this._activeManifest.files.transcript) {
      return;
    }
    try {
      const raw = await readText(this._activeManifest.files.transcript, '');
      if (!raw.trim()) return;
      const entries = raw.trim().split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      if (entries.length === 0) return;

      // Map transcript entries to webview message types
      const messages = [];
      for (const entry of entries) {
        if (entry.role === 'user') {
          messages.push({ type: 'user', text: entry.text || '' });
        } else if (entry.role === 'controller') {
          const cli = entry.controllerCli
            || (this._activeManifest && this._activeManifest.controller && this._activeManifest.controller.cli)
            || 'codex';
          const label = controllerLabelFor(cli);
          if (entry.text === '[STOP]') {
            messages.push({ type: 'stop', label });
          } else {
            messages.push({ type: 'controller', text: entry.text || '', label });
          }
        } else if (entry.role === 'claude') {
          messages.push({ type: 'claude', text: (entry.text || '').trim(), label: this._renderer.workerLabel || 'Worker' });
        }
      }
      if (messages.length > 0) {
        this._postMessage({ type: 'transcriptHistory', messages });
      }
    } catch {
      // Transcript unreadable — not fatal
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
      this._activeManifest = null;
      this._postMessage({ type: 'clear' });
      this._postMessage({ type: 'clearRunId' });
      this._postMessage({ type: 'progressFull', text: '' });
      this._renderer.banner('Session cleared.');
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
        this._renderer.banner('Usage: /resume <run-id>');
        return;
      }
      this._clearWaitTimer();
      const runDir = await resolveRunDir(rest, this._stateRoot);
      this._activeManifest = await loadManifestFromDir(runDir);
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
          this._renderer.banner('No workflows found.\nPlace workflow directories in .cc-manager/workflows/ or ~/.cc-manager/workflows/\nEach must contain a WORKFLOW.md with YAML frontmatter (name, description).');
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
      const cfg = JSON.parse(fs.readFileSync(path.join(this._repoRoot, '.cc-manager', 'config.json'), 'utf8'));
      opts.useSnapshot = cfg.useSnapshot !== false;
    } catch {
      opts.useSnapshot = true;
    }
    if (this._controllerCli) opts.controllerCli = this._controllerCli;
    if (this._controllerModel && this._controllerCli !== 'claude') opts.controllerModel = this._controllerModel;
    if (this._workerCli) opts.workerCli = this._workerCli;
    if (this._workerModel) opts.workerModel = this._workerModel;
    // Split MCP servers by target role; workers using qa-remote-* backends need host.docker.internal URLs
    const workerIsRemote = typeof this._workerCli === 'string' && this._workerCli.startsWith('qa-remote');
    const controllerMcp = this._mcpServersForRole('controller', false);
    const workerMcp = this._mcpServersForRole('worker', workerIsRemote);
    if (Object.keys(controllerMcp).length > 0) opts.controllerMcpServers = controllerMcp;
    if (Object.keys(workerMcp).length > 0) opts.workerMcpServers = workerMcp;
    let agents = this._enabledAgents();
    // If current mode restricts available agents, filter to only those
    if (this._currentMode) {
      const modes = this._enabledModes();
      const mode = modes[this._currentMode];
      if (mode) {
        // Resolve environment-aware fields (can be string/array or { browser: X, computer: Y })
        const env = this._testEnv || 'browser';
        const resolveByEnv = (val) => {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            return val[env] || val['browser'] || Object.values(val)[0];
          }
          return val;
        };
        const prompt = resolveByEnv(mode.controllerPrompt);
        if (prompt) {
          opts.controllerSystemPrompt = prompt;
        }
        const agentList = resolveByEnv(mode.availableAgents);
        if (agentList && Array.isArray(agentList)) {
          const filtered = {};
          for (const agentId of agentList) {
            if (agents[agentId]) filtered[agentId] = agents[agentId];
          }
          agents = filtered;
        }
      }
    }
    if (Object.keys(agents).length > 0) opts.agents = agents;
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
      workerCli: this._workerCli || 'claude',
      mode: this._currentMode || null,
      testEnv: this._testEnv || null,
    };
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
    // Sync enabled agents (filtered by mode if applicable)
    let agents = this._enabledAgents();
    if (this._currentMode) {
      const modes = this._enabledModes();
      const mode = modes[this._currentMode];
      if (mode) {
        const env = this._testEnv || 'browser';
        const resolveByEnv = (val) => {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            return val[env] || val['browser'] || Object.values(val)[0];
          }
          return val;
        };
        const prompt = resolveByEnv(mode.controllerPrompt);
        if (prompt) {
          this._activeManifest.controllerSystemPrompt = prompt;
        }
        const agentList = resolveByEnv(mode.availableAgents);
        if (agentList && Array.isArray(agentList)) {
          const filtered = {};
          for (const agentId of agentList) {
            if (agents[agentId]) filtered[agentId] = agents[agentId];
          }
          agents = filtered;
        }
      }
    }
    this._activeManifest.agents = agents;
    if (!this._activeManifest.worker.agentSessions) this._activeManifest.worker.agentSessions = {};
  }

  /** Start headless Chrome if a local agent needs chrome-devtools MCP. */
  async _ensureChromeIfNeeded(agentId) {
    // Determine which CLI will run
    let cli = this._workerCli || 'claude';
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
        this._renderer.banner('Starting headless Chrome\u2026');
        const chrome = await ensureChrome(this._panelId);
        if (chrome) {
          this._chromePort = chrome.port;
          if (this._activeManifest) this._activeManifest.chromeDebugPort = chrome.port;
          this._postMessage({ type: 'chromeReady', chromePort: chrome.port });
          startScreencast(this._panelId, (frameData, metadata) => {
            this._postMessage({ type: 'chromeFrame', data: frameData, metadata });
          }, (url) => {
            this._postMessage({ type: 'chromeUrl', url });
          });
          // Port is stored on manifest.chromeDebugPort for buildClaudeArgs to use
        }
      } catch (err) {
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
    const { ensureChrome, startScreencast, _dbg } = require('./chrome-manager');
    _dbg(`[session-manager] _startChromeDirect called, panelId=${this._panelId}, existing chromePort=${this._chromePort}`);
    if (this._chromePort) {
      _dbg('[session-manager] Chrome already running, sending chromeReady');
      this._postMessage({ type: 'chromeReady', chromePort: this._chromePort });
      return;
    }
    try {
      const chrome = await ensureChrome(this._panelId);
      _dbg(`[session-manager] ensureChrome returned: ${JSON.stringify(chrome)}`);
      if (chrome) {
        this._chromePort = chrome.port;
        this._postMessage({ type: 'chromeReady', chromePort: chrome.port });
        _dbg('[session-manager] sent chromeReady, starting screencast...');
        startScreencast(this._panelId, (frameData, metadata) => {
          this._postMessage({ type: 'chromeFrame', data: frameData, metadata });
        }, (url) => {
          this._postMessage({ type: 'chromeUrl', url });
        });
        _dbg('[session-manager] screencast started');
      } else {
        _dbg('[session-manager] ensureChrome returned null');
        this._postMessage({ type: 'chromeGone' });
      }
    } catch (err) {
      _dbg(`[session-manager] _startChromeDirect EXCEPTION: ${err.message}\n${err.stack}`);
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
      });
      await saveManifest(this._activeManifest);
      // If loop mode is on and the run didn't stop, auto-continue
      if (this._loopMode && this._activeManifest && this._activeManifest.status === 'running') {
        this._scheduleLoopContinue();
      }
    } finally {
      // Restore original prompt and direct-mode controller session ID
      this._activeManifest.controllerSystemPrompt = originalPrompt;
      this._activeManifest.controller.sessionId = savedControllerSessionId;
      this._running = false;
      this._abortController = null;
      this._postMessage({ type: 'running', value: false });
    }
  }

  /** Base copilot prompt — delegates to shared builder in prompts.js */
  _buildCopilotBasePrompt() {
    return buildCopilotBasePrompt();
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
