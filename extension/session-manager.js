const fs = require('node:fs');
const path = require('node:path');
const { runManagerLoop, runDirectWorkerTurn, printRunSummary, printEventTail } = require('./src/orchestrator');
const { loadWorkflows } = require('./src/prompts');
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
    this._mcpData = { global: {}, project: {} }; // Set via setMcpServers() from extension.js
    this._agentsData = { global: {}, project: {} }; // Set via setAgents() from extension.js
  }

  /** Update the MCP server data (both scopes). Called from extension.js. */
  setMcpServers(mcpData) {
    this._mcpData = mcpData || { global: {}, project: {} };
  }

  /** Update the agents data (both scopes). Called from extension.js. */
  setAgents(agentsData) {
    this._agentsData = agentsData || { global: {}, project: {} };
  }

  /** Return enabled agents merged from global + project. */
  _enabledAgents() {
    const result = {};
    const all = { ...this._agentsData.global, ...this._agentsData.project };
    for (const [id, agent] of Object.entries(all)) {
      if (agent && agent.enabled !== false) {
        result[id] = agent;
      }
    }
    return result;
  }

  /** Return servers visible to a given role, stripped of the target field. */
  _mcpServersForRole(role) {
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
    // Auto-inject built-in cc-tasks MCP server
    if (this._extensionPath) {
      result['cc-tasks'] = {
        command: 'node',
        args: [path.join(this._extensionPath, 'tasks-mcp-server.js')],
        env: { TASKS_FILE: path.join(this._repoRoot, '.cc-manager', 'tasks.json') },
      };
    }
    return result;
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
      if (this._activeManifest.worker && this._activeManifest.worker.cli) {
        this._renderer.workerLabel = workerLabelFor(this._activeManifest.worker.cli);
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
          messages.push({ type: 'claude', text: entry.text || '' });
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

    if (msg.type === 'userInput') {
      await this._handleInput(String(msg.text || '').trim());
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
        // Direct-to-agent: skip controller, use agent's session and CLI
        const agentId = this._chatTarget.slice('agent-'.length);
        await this._runDirectAgent(text, agentId);
      } else {
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
      if (this._activeManifest.worker && this._activeManifest.worker.cli) {
        this._renderer.workerLabel = workerLabelFor(this._activeManifest.worker.cli);
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
    };
    if (this._controllerCli) opts.controllerCli = this._controllerCli;
    if (this._controllerModel && this._controllerCli !== 'claude') opts.controllerModel = this._controllerModel;
    if (this._workerCli) opts.workerCli = this._workerCli;
    if (this._workerModel) opts.workerModel = this._workerModel;
    // Split MCP servers by target role
    const controllerMcp = this._mcpServersForRole('controller');
    const workerMcp = this._mcpServersForRole('worker');
    if (Object.keys(controllerMcp).length > 0) opts.controllerMcpServers = controllerMcp;
    if (Object.keys(workerMcp).length > 0) opts.workerMcpServers = workerMcp;
    const agents = this._enabledAgents();
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
    };
  }

  _syncConfig() {
    this._postMessage({ type: 'syncConfig', config: this._getConfig() });
  }

  /** Sync current MCP server config and agents into the active manifest before each run. */
  _syncMcpToManifest() {
    if (!this._activeManifest) return;
    const controllerMcp = this._mcpServersForRole('controller');
    const workerMcp = this._mcpServersForRole('worker');
    this._activeManifest.controllerMcpServers = Object.keys(controllerMcp).length > 0 ? controllerMcp : null;
    this._activeManifest.workerMcpServers = Object.keys(workerMcp).length > 0 ? workerMcp : null;
    // Sync enabled agents
    this._activeManifest.agents = this._enabledAgents();
    if (!this._activeManifest.worker.agentSessions) this._activeManifest.worker.agentSessions = {};
  }

  async _runDirectWorker(userMessage) {
    this._syncMcpToManifest();
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
    this._syncMcpToManifest();
    this._running = true;
    this._abortController = new AbortController();
    this._postMessage({ type: 'running', value: true });

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

  async _runLoop(options) {
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
  }
}

module.exports = { SessionManager };
