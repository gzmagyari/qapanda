const fs = require('node:fs');
const path = require('node:path');
const { runManagerLoop, runDirectWorkerTurn, printRunSummary, printEventTail } = require('./src/orchestrator');
const { closeInteractiveSessions } = require('./src/claude');
const {
  loadWorkflows,
  buildCopilotBasePrompt,
  buildContinueDirective,
  sanitizePersistedControllerSystemPrompt,
} = require('./src/prompts');
const { appendWizardDebug, summarizeForDebug } = require('./src/debug-log');
const { searchExternalChatSessions } = require('./src/external-chat-search');
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
const { readTextTail, summarizeError } = require('./src/utils');
const { discoverExternalChatSessions } = require('./src/external-chat-discovery');
const {
  getImportedCodexSessionId,
  importExternalChatSession,
  isCodexCliBackend,
} = require('./src/external-chat-import');
const { controllerLabelFor, workerLabelFor } = require('./src/render');
const {
  bindResumeAlias,
  listResumeAliases,
  removeResumeAlias,
  removeResumeAliasTarget,
  resolveResumeToken,
} = require('./src/named-workspaces');
const {
  appendTranscriptRecord,
  buildTranscriptDisplayTail,
  createTranscriptRecord,
  screenshotMessagesFromResult,
  transcriptBackend,
  workerSessionKey,
} = require('./src/transcript');
const { backfillUsageSummaryFromRun, usageSummaryMessage, usageSummaryNeedsBackfill } = require('./src/usage-summary');
const { parseChromeCurrentPageToolResult, parseChromePagesToolResult } = require('./chrome-page-binding');

const ERROR_RETRY_DELAY_MS = 30 * 60_000; // 30 minutes
const PROGRESS_TAIL_MAX_BYTES = 512 * 1024;
const PROGRESS_TAIL_TRUNCATION_BANNER = 'Showing only the latest progress tail for this run.';

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
    this._workspaceName = options.workspaceName || null;
    this._rootKind = options.rootKind || (this._workspaceName ? 'named-workspace' : 'repo');
    this._rootIdentity = options.rootIdentity
      || (this._rootKind === 'named-workspace' && this._workspaceName
        ? `workspace:${this._workspaceName}`
        : `repo:${path.resolve(this._repoRoot)}`);
    this._panelId = options.panelId || require('node:crypto').randomUUID();
    this._runOptions = options.runOptions || {};
    this._resumeToken = options.resumeToken || null;
    this._pendingResumeAlias = options.pendingResumeAlias || null;
    this._saveResumeAs = options.saveResumeAs || null;
    this._preserveResumeAliasOnClear = options.preserveResumeAliasOnClear === true;
    this._activeManifest = null;
    this._abortController = null;
    this._running = false;
    this._activityCounts = { foreground: 0, utility: 0 };
    this._runningUiState = { value: false, showStop: false };
    this._compactionStates = new Map();
    this._nextCompactionToken = 1;
    this._executingAgentStack = [];
    this._postMessage = options.postMessage || (() => {});
    this._waitTimer = null;
    this._loopContinueTimer = null;
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
    this._loopMode = !!init.loopMode;
    this._loopObjective = init.loopObjective || '';
    this._chatTarget = init.chatTarget || 'controller';
    this._controllerCli = init.controllerCli || 'codex';
    this._codexMode = init.codexMode || 'app-server';
    this._renderer.controllerLabel = controllerLabelFor(this._controllerCli);
    this._workerCli = init.workerCli || 'codex';
    this._renderer.workerLabel = workerLabelFor(this._workerCli);
    this._extensionPath = options.extensionPath || '';
    this._chromePort = null;
    this._chromePortReservation = null;
    this._webviewVisible = options.webviewVisible !== false;
    this._screencastActive = false;
    this._screencastPort = null;
    this._screencastStartToken = 0;
    this._screencastWanted = false;
    this._restoreBrowserPromise = null;
    this._prestartPromise = null;
    this._prestartDone = false;
    this._lastBrowserBannerKey = null;
    this._lastReviewStateKey = null;
    this._memoryMcpPort = null;
    // Set the qa-desktop path so remote-desktop.js can find the bundled CLI/proxy
    try {
      const { setQaDesktopPath } = require('./src/remote-desktop');
      if (this._extensionPath) setQaDesktopPath(path.join(this._extensionPath, 'qa-desktop'));
    } catch {}
    this._mcpData = { global: {}, project: {} }; // Set via setMcpServers() from extension.js
    this._agentsData = { system: {}, global: {}, project: {} }; // Set via setAgents() from extension.js
    this._modesData = { system: {}, global: {}, project: {} }; // Set via setModes() from extension.js
    this._agentRuntimeOverrides = {};
    try {
      const settingsStore = require('./settings-store');
      this._selfTesting = !!settingsStore.getSetting('selfTesting');
      this._lazyMcpToolsEnabled = !!settingsStore.getSetting('lazyMcpToolsEnabled');
      this._learnedApiToolsEnabled = !!settingsStore.getSetting('learnedApiToolsEnabled');
    } catch {
      this._selfTesting = false;
      this._lazyMcpToolsEnabled = false;
      this._learnedApiToolsEnabled = false;
    }
    if (this._renderer && typeof this._renderer === 'object') {
      this._renderer.handleMcpToolCompletion = async (payload) => {
        await this._handleMcpToolCompletion(payload);
      };
      this._renderer.handleChromeDevtoolsDetected = async () => {
        if (!this._chromePort) return;
        await this._requestChromeScreencast('chrome-devtools-detected');
      };
      this._renderer.handleCompactionActivity = async (payload) => {
        this._handleCompactionActivity(payload);
      };
    }
    this._agentDelegateMcpServer = null;
    this._delegationDepth = 0;
    this._pendingTurnBrowserScreenshotTokens = new Set();
  }

  /** Debug logger for screencast/session lifecycle — writes to same file as chrome-manager. */
  _sDbg(msg) {
    try {
      const fs = require('node:fs');
      const p = require('node:path').join(require('node:os').tmpdir(), 'cc-chrome-debug.log');
      fs.appendFileSync(p, `[${new Date().toISOString()}] [session] ${msg}\n`);
    } catch {}
  }

  _resumeDbg(msg) {
    try {
      const fs = require('node:fs');
      const os = require('node:os');
      const files = [];
      if (this._repoRoot) files.push(path.join(this._repoRoot, '.qpanda', 'wizard-debug.log'));
      files.push(path.join(os.homedir(), '.qpanda', 'wizard-debug.log'));
      for (const logPath of files) {
        try {
          fs.mkdirSync(path.dirname(logPath), { recursive: true });
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] [session-resume] ${msg}\n`);
        } catch {}
      }
    } catch {}
  }

  _continueDbg(msg, extra = null) {
    const payload = extra == null ? msg : `${msg} ${summarizeForDebug(extra)}`;
    appendWizardDebug('session-continue', payload, {
      repoRoot: this._repoRoot,
      stateRoot: this._stateRoot,
    });
  }

  _traceBrowser(where, extra = null) {
    try {
      const { getChromeDebugState } = require('./chrome-manager');
      const snapshot = {
        where,
        panelId: this._panelId,
        runId: this._activeManifest && this._activeManifest.runId || null,
        chatTarget: this._chatTarget || null,
        sessionChromePort: this._chromePort || null,
        reservedChromePort: this._currentReservedChromePort(),
        manifestChromePort: this._activeManifest && this._activeManifest.chromeDebugPort || null,
        browser: getChromeDebugState(this._panelId),
        extra: extra || null,
      };
      this._sDbg(`browser-trace ${JSON.stringify(snapshot)}`);
    } catch (err) {
      this._sDbg(`browser-trace ${where} failed: ${err && err.message ? err.message : err}`);
    }
  }

  /** Sync the chat log path to the renderer whenever the manifest changes. */
  _syncChatLogPath() {
    if (this._activeManifest && this._activeManifest.files && this._activeManifest.files.chatLog) {
      this._renderer.chatLogPath = this._activeManifest.files.chatLog;
    }
  }

  _computeRunningUiState() {
    const compaction = this._currentCompactionState();
    if ((this._activityCounts.foreground || 0) > 0) {
      return compaction
        ? { value: true, showStop: true, statusKind: 'compaction', statusText: compaction.statusText || 'Compacting chat context...' }
        : { value: true, showStop: true };
    }
    if ((this._activityCounts.utility || 0) > 0) {
      return compaction
        ? { value: true, showStop: false, statusKind: 'compaction', statusText: compaction.statusText || 'Compacting chat context...' }
        : { value: true, showStop: false };
    }
    if (compaction) {
      return { value: true, showStop: false, statusKind: 'compaction', statusText: compaction.statusText || 'Compacting chat context...' };
    }
    return { value: false, showStop: false };
  }

  _syncRunningState(force = false) {
    const next = this._computeRunningUiState();
    this._running = next.value;
    if (!force &&
        this._runningUiState.value === next.value &&
        this._runningUiState.showStop === next.showStop &&
        this._runningUiState.statusKind === next.statusKind &&
        this._runningUiState.statusText === next.statusText) {
      return;
    }
    this._runningUiState = next;
    const message = { type: 'running', value: next.value, showStop: next.showStop };
    if (next.statusKind) message.statusKind = next.statusKind;
    if (next.statusText) message.statusText = next.statusText;
    this._postMessage(message);
  }

  _beginActivity(kind = 'foreground') {
    const key = kind === 'utility' ? 'utility' : 'foreground';
    this._activityCounts[key] = (this._activityCounts[key] || 0) + 1;
    this._syncRunningState();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this._activityCounts[key] = Math.max(0, (this._activityCounts[key] || 0) - 1);
      if (key === 'foreground' && this._activityCounts[key] === 0) {
        this._clearCompactionStatesByKind('live');
      }
      if (key === 'utility' && this._activityCounts[key] === 0) {
        this._clearCompactionStatesByKind('manual');
      }
      this._syncRunningState();
    };
  }

  _currentCompactionState() {
    const iterator = this._compactionStates.values();
    const first = iterator.next();
    return first && !first.done ? first.value : null;
  }

  _setCompactionState(key, state) {
    if (!key) return;
    if (state) this._compactionStates.set(String(key), state);
    else this._compactionStates.delete(String(key));
    this._syncRunningState();
  }

  _clearCompactionStatesByKind(kind) {
    for (const [key, value] of this._compactionStates.entries()) {
      if (!value || value.kind !== kind) continue;
      this._compactionStates.delete(key);
    }
  }

  _beginCompactionState(kind = 'live', options = {}) {
    const token = options.key || `${kind}:${this._nextCompactionToken++}`;
    this._setCompactionState(token, {
      kind,
      statusText: options.statusText || 'Compacting chat context...',
    });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this._setCompactionState(token, null);
    };
  }

  _handleCompactionActivity(payload = {}) {
    const key = payload.key || `compaction:${payload.source || 'unknown'}`;
    if (payload.active === false) {
      this._setCompactionState(key, null);
      return;
    }
    this._setCompactionState(key, {
      kind: 'live',
      statusText: payload.statusText || 'Compacting chat context...',
    });
  }

  _pushExecutingAgent(agentId) {
    this._executingAgentStack.push(agentId || null);
  }

  _popExecutingAgent() {
    if (this._executingAgentStack.length === 0) return;
    this._executingAgentStack.pop();
  }

  _currentExecutingAgentId() {
    return this._executingAgentStack.length > 0
      ? this._executingAgentStack[this._executingAgentStack.length - 1]
      : null;
  }

  _workerRunHooks() {
    return {
      onWorkerStart: (agentId) => this._pushExecutingAgent(agentId),
      onWorkerEnd: () => this._popExecutingAgent(),
    };
  }

  _normalizeChatTarget(target, agentsOverride = null) {
    if (target == null) return null;
    const value = String(target).trim();
    if (!value) return null;
    if (value === 'controller' || value === 'claude') return value;
    if (!value.startsWith('agent-')) return null;
    const agentId = value.slice('agent-'.length);
    const agents = agentsOverride || this._enabledAgents();
    return agents && agents[agentId] ? value : null;
  }

  _cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  _isRemoteAgent(agent) {
    return !!(agent && typeof agent.cli === 'string' && agent.cli.startsWith('qa-remote'));
  }

  _isChromeDevtoolsMcpName(name) {
    return String(name || '').includes('chrome-devtools') || String(name || '').includes('chrome_devtools');
  }

  _normalizeCompletedToolName(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    const parts = value.split('__');
    return parts.length >= 2 ? parts[parts.length - 1] : value;
  }

  _isChromePageManagementTool(serverName, toolName) {
    const normalizedTool = this._normalizeCompletedToolName(toolName);
    const normalizedServer = String(serverName || '');
    if (!(this._isChromeDevtoolsMcpName(normalizedServer) || this._isChromeDevtoolsMcpName(toolName))) {
      return false;
    }
    return normalizedTool === 'list_pages'
      || normalizedTool === 'select_page'
      || normalizedTool === 'new_page'
      || normalizedTool === 'close_page';
  }

  async _handleMcpToolCompletion(payload = {}) {
    if (!this._activeManifest) return;
    const serverName = payload.serverName || payload.server || '';
    const toolName = payload.toolName || payload.tool || '';
    const normalizedTool = this._normalizeCompletedToolName(toolName);
    const screenshots = screenshotMessagesFromResult(payload.output, {
      serverName,
      toolName,
      input: payload.input || payload.arguments || payload.args || {},
      repoRoot: this._repoRoot,
    });
    if (screenshots.length > 0) {
      const seenScreenshotData = new Set();
      for (const screenshot of screenshots) {
        const data = screenshot && screenshot.data ? String(screenshot.data) : '';
        if (data && seenScreenshotData.has(data)) continue;
        if (data) seenScreenshotData.add(data);
        await this._persistChatScreenshotEntry(screenshot, {
          text: normalizedTool ? `Tool screenshot returned by ${normalizedTool}` : null,
        });
        this._postMessage({ ...screenshot });
      }
    }
    if (!(this._isChromeDevtoolsMcpName(serverName) || this._isChromeDevtoolsMcpName(toolName))) return;

    const isPageManagementTool = this._isChromePageManagementTool(serverName, toolName);
    const parsedPages = isPageManagementTool ? parseChromePagesToolResult(payload.output) : null;
    const currentPage = parseChromeCurrentPageToolResult(payload.output);

    let selection = null;
    let syncSource = null;
    if (parsedPages && parsedPages.selectedPageUrl) {
      selection = {
        pageNumber: parsedPages.selectedPageNumber,
        expectedUrl: parsedPages.selectedPageUrl,
        reason: `mcp:${normalizedTool}`,
      };
      syncSource = 'page-list';
    } else if (currentPage && currentPage.currentPageUrl) {
      selection = {
        pageNumber: currentPage.pageNumber || null,
        expectedUrl: currentPage.currentPageUrl,
        reason: `mcp:${normalizedTool}`,
      };
      syncSource = currentPage.source || 'current-page';
    }

    if (!selection || !selection.expectedUrl) {
      this._traceBrowser('_handleMcpToolCompletion:ignored', {
        toolName: normalizedTool,
        reason: 'no-current-page',
      });
      return;
    }

    const { syncPanelPageTarget } = require('./chrome-manager');
    const syncResult = await syncPanelPageTarget(this._panelId, {
      pageNumber: selection.pageNumber,
      expectedUrl: selection.expectedUrl,
      reason: selection.reason,
    }).catch((error) => ({ status: 'error', error: error && error.message ? error.message : String(error) }));
    this._traceBrowser('_handleMcpToolCompletion:sync', {
      toolName: normalizedTool,
      syncSource,
      selectedPageNumber: selection.pageNumber,
      selectedPageUrl: selection.expectedUrl,
      syncResult,
    });
    let collapseResult = null;
    const shouldCollapseToSyncedPage = (
      syncResult &&
      syncResult.targetId &&
      (
        normalizedTool === 'new_page' ||
        (currentPage && currentPage.currentPageUrl && currentPage.source !== 'page-list')
      )
    );
    if (shouldCollapseToSyncedPage) {
      collapseResult = await this._collapseChromeToSinglePage(
        normalizedTool === 'new_page' ? 'mcp:new_page' : `mcp:${normalizedTool}:current-page`,
        {
        keepTargetId: syncResult.targetId,
        reconnect: true,
        save: false,
      });
      this._traceBrowser('_handleMcpToolCompletion:collapse', {
        toolName: normalizedTool,
        collapseResult,
      });
    }
    if ((syncResult && syncResult.targetId) || (collapseResult && collapseResult.targetId)) {
      await this._syncBrowserBindingToManifest(true);
    }
  }

  async _collapseChromeToSinglePage(reason, options = {}) {
    const { collapsePanelToSinglePage } = require('./chrome-manager');
    const collapseResult = await collapsePanelToSinglePage(this._panelId, {
      keepTargetId: options.keepTargetId || null,
      reason,
      reconnect: options.reconnect === true,
    }).catch((error) => ({
      status: 'error',
      error: error && error.message ? error.message : String(error),
    }));
    this._traceBrowser('_collapseChromeToSinglePage', {
      reason,
      keepTargetId: options.keepTargetId || null,
      reconnect: options.reconnect === true,
      collapseResult,
    });
    if (options.save && collapseResult && collapseResult.targetId) {
      await this._syncBrowserBindingToManifest(true);
    }
    return collapseResult;
  }

  _normalizeAgentRuntimeOverrides(overrides) {
    const result = {};
    if (!overrides || typeof overrides !== 'object') return result;
    for (const [agentId, override] of Object.entries(overrides)) {
      if (!override || typeof override !== 'object') continue;
      if (typeof override.enableChromeDevtools !== 'boolean') continue;
      result[String(agentId)] = { enableChromeDevtools: override.enableChromeDevtools };
    }
    return result;
  }

  _currentAgentTargetId(target = this._chatTarget) {
    return typeof target === 'string' && target.startsWith('agent-')
      ? target.slice('agent-'.length)
      : null;
  }

  _agentHasChromeDevtools(agent) {
    const mcps = agent && agent.mcps && typeof agent.mcps === 'object' ? agent.mcps : {};
    return Object.keys(mcps).some((name) => this._isChromeDevtoolsMcpName(name));
  }

  _agentDefaultBrowserEnabled(agentId, agents = null) {
    const source = agents || this._enabledAgents();
    return !!this._agentHasChromeDevtools(source && source[agentId]);
  }

  _agentSupportsSharedBrowser(agentId, agents = null) {
    const source = agents || this._enabledAgents();
    const agent = source && source[agentId];
    return !!agent && !this._isRemoteAgent(agent);
  }

  _agentBrowserOverride(agentId) {
    const override = this._agentRuntimeOverrides && this._agentRuntimeOverrides[agentId];
    return override && typeof override.enableChromeDevtools === 'boolean'
      ? override.enableChromeDevtools
      : null;
  }

  _effectiveAgentBrowserEnabled(agentId, agents = null) {
    const override = this._agentBrowserOverride(agentId);
    if (typeof override === 'boolean') return override;
    return this._agentDefaultBrowserEnabled(agentId, agents);
  }

  _setAgentBrowserOverride(agentId, enabled, agents = null) {
    if (!agentId) return false;
    const defaultEnabled = this._agentDefaultBrowserEnabled(agentId, agents);
    const normalized = !!enabled;
    const previous = this._agentBrowserOverride(agentId);
    if (normalized === defaultEnabled) {
      if (this._agentRuntimeOverrides && this._agentRuntimeOverrides[agentId]) {
        delete this._agentRuntimeOverrides[agentId];
        return previous !== null;
      }
      return false;
    }
    if (!this._agentRuntimeOverrides) this._agentRuntimeOverrides = {};
    this._agentRuntimeOverrides[agentId] = { enableChromeDevtools: normalized };
    return previous !== normalized;
  }

  _canonicalChromeDevtoolsMcp() {
    const agents = this._enabledAgents();
    const preferred = agents['QA-Browser'];
    const candidates = preferred
      ? [['QA-Browser', preferred], ...Object.entries(agents).filter(([id]) => id !== 'QA-Browser')]
      : Object.entries(agents);
    for (const [, agent] of candidates) {
      const mcps = agent && agent.mcps && typeof agent.mcps === 'object' ? agent.mcps : {};
      for (const [name, server] of Object.entries(mcps)) {
        if (!this._isChromeDevtoolsMcpName(name) || !server) continue;
        return { name, server: this._cloneJson(server) };
      }
    }
    return {
      name: 'chrome-devtools',
      server: {
        type: 'stdio',
        command: 'npx',
        args: [
          '-y',
          'chrome-devtools-mcp@latest',
          '--browser-url=http://127.0.0.1:{CHROME_DEBUG_PORT}',
          '--viewport=1280x720',
        ],
      },
    };
  }

  _effectiveAgents() {
    const baseAgents = this._enabledAgents();
    const result = {};
    const canonicalBrowserMcp = this._canonicalChromeDevtoolsMcp();
    for (const [agentId, agent] of Object.entries(baseAgents)) {
      const cloned = this._cloneJson(agent) || {};
      const mcps = cloned.mcps && typeof cloned.mcps === 'object' ? { ...cloned.mcps } : {};
      const browserEnabled = this._effectiveAgentBrowserEnabled(agentId, baseAgents);
      const hasBrowser = Object.keys(mcps).some((name) => this._isChromeDevtoolsMcpName(name));
      if (browserEnabled) {
        if (!hasBrowser && this._agentSupportsSharedBrowser(agentId, baseAgents) && canonicalBrowserMcp && canonicalBrowserMcp.server) {
          mcps[canonicalBrowserMcp.name] = this._cloneJson(canonicalBrowserMcp.server);
        }
      } else if (hasBrowser) {
        for (const name of Object.keys(mcps)) {
          if (this._isChromeDevtoolsMcpName(name)) delete mcps[name];
        }
      }
      cloned.mcps = mcps;
      result[agentId] = cloned;
    }
    return result;
  }

  _labelForChatTarget(target) {
    if (!target || target === 'controller') return 'QA Panda';
    if (target === 'claude') return 'Worker (Default)';
    if (!target.startsWith('agent-')) return 'QA Panda';
    const agentId = target.slice('agent-'.length);
    const manifestAgents = (this._activeManifest && this._activeManifest.agents) || {};
    const agent = manifestAgents[agentId] || this._enabledAgents()[agentId];
    return (agent && agent.name) || agentId;
  }

  _effectiveCliForChatTarget(target, agentsOverride = null) {
    const manifest = this._activeManifest;
    if (!target || target === 'controller') {
      return (manifest && manifest.controller && manifest.controller.cli) || this._controllerCli || 'codex';
    }
    if (target === 'claude') {
      return (manifest && manifest.worker && manifest.worker.cli) || this._workerCli || 'codex';
    }
    if (!target.startsWith('agent-')) return null;
    const agentId = target.slice('agent-'.length);
    const agents = agentsOverride || this._enabledAgents();
    const agent = agents && agents[agentId];
    return (agent && agent.cli) || (manifest && manifest.worker && manifest.worker.cli) || this._workerCli || 'codex';
  }

  _targetCanContinueImportedCodexSession(target, agentsOverride = null) {
    return !!getImportedCodexSessionId(this._activeManifest) && isCodexCliBackend(this._effectiveCliForChatTarget(target, agentsOverride));
  }

  _hasExistingSessionForTarget(target) {
    if (!this._activeManifest) return false;
    if (!target || target === 'controller') {
      return !!(
        (this._activeManifest.controller && this._activeManifest.controller.sessionId) ||
        (this._activeManifest.controller && this._activeManifest.controller.appServerThreadId) ||
        this._targetCanContinueImportedCodexSession(target)
      );
    }
    if (target === 'claude') {
      const defaultSession = (((this._activeManifest.worker || {}).agentSessions || {}).default) || null;
      return !!(
        (this._activeManifest.worker && this._activeManifest.worker.hasStarted) ||
        (defaultSession && (defaultSession.hasStarted || defaultSession.appServerThreadId)) ||
        this._targetCanContinueImportedCodexSession(target)
      );
    }
    if (!target.startsWith('agent-')) return false;
    const agentId = target.slice('agent-'.length);
    const agentSession = (((this._activeManifest.worker || {}).agentSessions || {})[agentId]) || null;
    return !!(
      (agentSession && (agentSession.hasStarted || agentSession.appServerThreadId)) ||
      this._targetCanContinueImportedCodexSession(target)
    );
  }

  _bannerChatTargetState(target, reason = 'switch') {
    if (!this._activeManifest) return;
    const label = this._labelForChatTarget(target);
    const hasSession = this._hasExistingSessionForTarget(target);
    const message = reason === 'reattach'
      ? (hasSession
        ? `Restored target ${label} and reattached to its existing session for this run.`
        : `Restored target ${label}. The next message will start a new session for this target in the current run.`)
      : (hasSession
        ? `Switched to ${label}. Reattached to the existing session for this run.`
        : `Switched to ${label}. The next message will start a new session for this target in the current run.`);
    this._renderer.banner(message);
  }

  _syncLoopConfigToManifest() {
    if (!this._activeManifest) return;
    this._activeManifest.loopMode = !!this._loopMode;
    this._activeManifest.loopObjective = (this._loopObjective || '').trim() || null;
    this._activeManifest.chatTarget = this._chatTarget || null;
  }

  _browserBanner(key, text) {
    if (!text) return;
    if (this._lastBrowserBannerKey === key) return;
    this._lastBrowserBannerKey = key;
    this._traceBrowser('_browserBanner', { key, text });
    this._renderer.banner(text);
  }

  _currentReservedChromePort() {
    if (Number.isFinite(this._chromePortReservation) && this._chromePortReservation > 0) {
      return this._chromePortReservation;
    }
    if (this._activeManifest && Number.isFinite(Number(this._activeManifest.chromeDebugPort)) && Number(this._activeManifest.chromeDebugPort) > 0) {
      return Number(this._activeManifest.chromeDebugPort);
    }
    if (Number.isFinite(this._chromePort) && this._chromePort > 0) {
      return this._chromePort;
    }
    return null;
  }

  _controllerPrestartKey(port = this._currentReservedChromePort()) {
    return `panel:${this._panelId}:controller:${port || 'no-browser'}`;
  }

  _workerPrestartKey(port = this._currentReservedChromePort()) {
    return `panel:${this._panelId}:worker:${port || 'no-browser'}`;
  }

  _syncBrowserBindingToManifest(save = false) {
    if (!this._activeManifest) return Promise.resolve();
    const { getChromeDebugState } = require('./chrome-manager');
    const reservedPort = this._currentReservedChromePort();
    const chromeDebugState = getChromeDebugState(this._panelId);
    const chromeBinding = chromeDebugState && chromeDebugState.instance && (
      chromeDebugState.instance.boundTargetId || chromeDebugState.instance.boundTargetUrl
    ) ? {
      targetId: chromeDebugState.instance.boundTargetId || null,
      url: chromeDebugState.instance.boundTargetUrl || null,
      pageNumber: Number.isFinite(Number(chromeDebugState.instance.boundPageNumber))
        ? Number(chromeDebugState.instance.boundPageNumber)
        : null,
      boundBy: chromeDebugState.instance.boundBy || null,
    } : null;
    this._activeManifest.panelId = this._panelId || this._activeManifest.panelId || null;
    this._activeManifest.chromeDebugPort = reservedPort || null;
    this._activeManifest.chromePageBinding = chromeBinding;
    this._activeManifest.controllerPrestartKey = this._controllerPrestartKey(reservedPort);
    this._activeManifest.workerPrestartKey = this._workerPrestartKey(reservedPort);
    if (this._activeManifest.worker) {
      this._activeManifest.worker.boundBrowserPort = reservedPort || null;
    }
    if (save) {
      this._traceBrowser('_syncBrowserBindingToManifest', { save, reservedPort, chromeBinding });
      return saveManifest(this._activeManifest).catch(() => {});
    }
    this._traceBrowser('_syncBrowserBindingToManifest', { save, reservedPort, chromeBinding });
    return Promise.resolve();
  }

  async _reserveChromePort(preferredPort = null) {
    const current = this._currentReservedChromePort();
    if (Number.isFinite(current) && current > 0) {
      this._chromePortReservation = current;
      this._traceBrowser('_reserveChromePort:reuse-current', { preferredPort });
      return current;
    }
    const { reserveChromePort } = require('./chrome-manager');
    this._traceBrowser('_reserveChromePort:request', { preferredPort });
    const reserved = await reserveChromePort(this._panelId, preferredPort);
    this._chromePortReservation = reserved;
    this._browserBanner(`browser-port:${this._panelId}:${reserved}`, `Browser debug port ${reserved} claimed for this panel.`);
    await this._syncBrowserBindingToManifest(true);
    this._traceBrowser('_reserveChromePort:claimed', { preferredPort, reserved });
    return reserved;
  }

  async _closePanelScopedAppServerConnections() {
    const { closeConnectionsWhere } = require('./src/codex-app-server');
    const runId = this._activeManifest && this._activeManifest.runId;
    const panelPrefix = `panel:${this._panelId}:`;
    await closeConnectionsWhere((key) => {
      if (typeof key !== 'string') return false;
      if (key.startsWith(panelPrefix)) return true;
      if (runId && (key === runId || key.startsWith(`${runId}-worker-`))) return true;
      return false;
    }).catch(() => {});
  }

  async _ensurePanelChrome(source, options = {}) {
    const { ensureChrome, setPanelPageBinding } = require('./chrome-manager');
    const preferredPort = options.port != null ? options.port : this._currentReservedChromePort();
    this._traceBrowser('_ensurePanelChrome:entry', { source, preferredPort, options });
    const reservedPort = await this._reserveChromePort(preferredPort);
    const hasKnownBrowser = !!this._chromePort;
    const caller = source || 'browser';

    try {
      const chrome = await ensureChrome(this._panelId, { port: reservedPort });
      if (!chrome) {
        this._browserBanner(`browser-failed:${caller}:${reservedPort}`, `Failed to start Chrome on port ${reservedPort}.`);
        this._postMessage({ type: 'chromeGone' });
        this._traceBrowser('_ensurePanelChrome:no-chrome', { source, reservedPort });
        return null;
      }
      this._chromePort = chrome.port;
      this._chromePortReservation = chrome.port;
      setPanelPageBinding(
        this._panelId,
        this._activeManifest && this._activeManifest.chromePageBinding
          ? this._activeManifest.chromePageBinding
          : null
      );
      const collapseResult = await this._collapseChromeToSinglePage(`startup:${source}`, {
        reconnect: false,
        save: false,
      });
      this._traceBrowser('_ensurePanelChrome:collapse', { source, reservedPort, collapseResult });
      this._traceBrowser('_ensurePanelChrome:ensured', { source, reservedPort, result: chrome });
      if (options.emitLifecycleBanner !== false) {
        if (chrome.status === 'started') {
          const action = options.lifecycle === 'prestart'
            ? 'Prestarting Chrome'
            : (hasKnownBrowser || options.expectRestart ? 'Restarted Chrome' : 'Started Chrome');
          this._browserBanner(`browser-started:${caller}:${chrome.port}:${action}`, `${action} on port ${chrome.port}.`);
        } else {
          this._browserBanner(`browser-reused:${caller}:${chrome.port}`, `Reusing Chrome on port ${chrome.port}.`);
        }
      }
      await this._syncBrowserBindingToManifest(true);
      if (options.startScreencast !== false) {
        await this._startChromeScreencast(chrome.port, source);
      } else {
        this._postMessage({ type: 'chromeReady', chromePort: chrome.port });
      }
      this._traceBrowser('_ensurePanelChrome:done', { source, reservedPort, result: chrome });
      return chrome;
    } catch (err) {
      this._sDbg(`${source}: Chrome ensure failed: ${err.message}`);
      this._browserBanner(`browser-error:${caller}:${reservedPort}`, `Chrome failed on port ${reservedPort}: ${err.message}`);
      this._postMessage({ type: 'chromeGone' });
      this._traceBrowser('_ensurePanelChrome:error', { source, reservedPort, error: err.message });
      return null;
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
    const { isMemoryEnabled } = require('./src/project-context');
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
    if (isMemoryEnabled(this._repoRoot)) {
      if (this._memoryMcpPort) {
        result['cc-memory'] = { type: 'http', url: `http://${mcpHost}:${this._memoryMcpPort}/mcp` };
      } else if (this._extensionPath) {
        result['cc-memory'] = {
          command: 'node',
          args: [path.join(this._extensionPath, 'memory-mcp-server.js')],
          env: { MEMORY_FILE: path.join(this._repoRoot, '.qpanda', 'MEMORY.md') },
        };
      }
    }
    if (this._qaDesktopMcpPort && require('./src/feature-flags').getFlag('enableRemoteDesktop', this._extensionPath || null, this._repoRoot)) {
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
        onDelegate: (agentId, message, options) => this._handleDelegation(agentId, message, options),
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
  async _handleDelegation(agentId, message, options = {}) {
    if (this._delegationDepth >= 3) {
      throw new Error('Delegation depth limit reached (max 3). Cannot delegate further to prevent infinite loops.');
    }
    if (!this._activeManifest) {
      if (options.allowCreateRun) {
        await this._createRun(String(message || '').trim() || '[delegation]');
      } else {
        throw new Error('No active run. Cannot delegate.');
      }
    }
    const agents = this._enabledAgents();
    if (!agents[agentId]) {
      const available = Object.entries(agents).map(([id, a]) => `${id} (${a.name || id})`).join(', ');
      throw new Error(`Unknown agent "${agentId}". Available agents: ${available}`);
    }
    const currentAgentId = this._currentExecutingAgentId();
    if (currentAgentId && agentId === currentAgentId) {
      throw new Error(`Agent "${agentId}" cannot delegate to itself.`);
    }

    // Save manifest transient state — runDirectWorkerTurn overwrites these
    const savedStatus = this._activeManifest.status;
    const savedActiveRequestId = this._activeManifest.activeRequestId;
    const savedStopReason = this._activeManifest.stopReason;
    const savedWorkerMcpServers = this._activeManifest.workerMcpServers;

    this._delegationDepth++;
    const endActivity = this._beginActivity('foreground');
    try {
      // Setup for the delegated agent (same steps as _runDirectAgent)
      await this._startAgentDelegateMcp();
      this._syncMcpToManifest(agentId);
      await this._ensureChromeIfNeeded(agentId);
      if (this._extensionPath && this._activeManifest) {
        this._activeManifest.extensionDir = this._extensionPath;
      }

      const { runDirectWorkerTurn } = require('./src/orchestrator');
      this._activeManifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
        userMessage: String(message || '').trim(),
        agentId,
        isDelegation: true,
        includeChatTail: options.includeChatTail === true,
        chatTailMaxChars: options.chatTailMaxChars,
        workerPromptBase: options.workerPromptBase,
        launchLabelHint: options.launchLabelHint,
        launchSource: options.launchSource,
        abortSignal: this._abortController ? this._abortController.signal : undefined,
        ...this._workerRunHooks(),
      });

      // Extract the delegated agent's response
      const lastReq = this._activeManifest.requests[this._activeManifest.requests.length - 1];
      const resultText = (lastReq && lastReq.latestWorkerResult && lastReq.latestWorkerResult.resultText) || 'Agent completed but returned no text.';
      return resultText;
    } finally {
      this._delegationDepth--;
      endActivity();
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
    const currentAgentId = this._currentExecutingAgentId();
    const list = Object.entries(agents).map(([id, agent]) => ({
      id,
      name: agent.name || id,
      description: agent.description || '',
    })).filter((agent) => agent.id !== currentAgentId);
    return JSON.stringify(list, null, 2);
  }

  _buildVisibleReviewRequest(scope, guidance) {
    const normalizedScope = scope === 'staged' || scope === 'both' ? scope : 'unstaged';
    const base = `Review ${normalizedScope} git changes in this repository.`;
    const extra = String(guidance || '').replace(/\s+/g, ' ').trim();
    return extra ? `${base} Additional guidance: ${extra}` : base;
  }

  _buildReviewWorkerPrompt(scope, reviewState, guidance) {
    const { buildReviewScopeSummaryLines } = require('./src/git-review');
    const normalizedScope = scope === 'staged' || scope === 'both' ? scope : 'unstaged';
    const summaryLines = buildReviewScopeSummaryLines(reviewState, normalizedScope, { maxFiles: 12 });
    const sections = [
      `Review ${normalizedScope} git changes in this repository.`,
      `Repository root: ${this._repoRoot}`,
      summaryLines.length > 0 ? ['Git status summary:', ...summaryLines].join('\n') : 'Git status summary: No matching files were detected for this review scope.',
      'Inspect the git state directly with commands and file reads. Do not assume the full diff is included in this prompt.',
    ];
    const extra = String(guidance || '').trim();
    if (extra) {
      sections.push(`Additional user guidance:\n${extra}`);
    }
    return sections.join('\n\n');
  }

  async _handleReviewRequest(scope, guidance = '') {
    if (this._running) return;
    const reviewState = await this.sendReviewState(true);
    if (!reviewState || !reviewState.visible) {
      this._renderer.banner('No git changes are available to review in this repository.');
      return;
    }

    const normalizedScope = scope === 'staged' || scope === 'both' ? scope : 'unstaged';
    const scopeAllowed = (
      (normalizedScope === 'unstaged' && reviewState.hasUnstaged) ||
      (normalizedScope === 'staged' && reviewState.hasStaged) ||
      (normalizedScope === 'both' && reviewState.hasUnstaged && reviewState.hasStaged)
    );
    if (!scopeAllowed) {
      this._renderer.banner(`Review scope "${normalizedScope}" is not available for the current git state.`);
      return;
    }

    const visibleMessage = this._buildVisibleReviewRequest(normalizedScope, guidance);
    if (!this._activeManifest) {
      await this._createRun(visibleMessage);
      this._renderer.requestStarted(this._activeManifest.runId);
    }

    this._applyWorkerThinking();
    try {
      await this._handleDelegation('reviewer', visibleMessage, {
        allowCreateRun: false,
        includeChatTail: true,
        chatTailMaxChars: 50_000,
        workerPromptBase: this._buildReviewWorkerPrompt(normalizedScope, reviewState, guidance),
        launchLabelHint: 'Code review',
        launchSource: 'review',
      });
    } catch (error) {
      if (!isAbortError(error)) {
        this._renderer.banner(`Run error: ${formatRunError(error)}`);
      } else {
        this._renderer.banner('Run stopped by user.');
      }
    } finally {
      this._renderer.close();
      await this.sendReviewState(true);
    }
  }

  applyConfig(config) {
    if (!config) return;
    let shouldSyncConfig = false;
    if (config.controllerModel !== undefined) this._controllerModel = config.controllerModel || null;
    if (config.workerModel !== undefined) this._workerModel = config.workerModel || null;
    if (config.controllerThinking !== undefined) this._controllerThinking = config.controllerThinking || null;
    if (config.workerThinking !== undefined) this._workerThinking = config.workerThinking || null;
    if (config.chatTarget !== undefined) {
      const previousTarget = this._chatTarget || 'controller';
      this._chatTarget = this._normalizeChatTarget(config.chatTarget) || 'controller';
      if (this._chatTarget === 'claude') {
        this._renderer.workerLabel = workerLabelFor(this._workerCli);
      } else if (this._chatTarget.startsWith('agent-')) {
        const agentId = this._chatTarget.slice('agent-'.length);
        const agent = this._enabledAgents()[agentId];
        this._renderer.workerLabel = workerLabelFor(agent && agent.cli, agent && agent.name);
      }
      if (this._activeManifest) {
        this._syncLoopConfigToManifest();
        saveManifest(this._activeManifest).catch(() => {});
        if (this._chatTarget !== previousTarget) {
          this._bannerChatTargetState(this._chatTarget, 'switch');
          this._backfillResumeAliasForCurrentTarget().catch(() => {});
        }
      }
      shouldSyncConfig = true;
    }
    if (config.agentBrowserEnabled !== undefined) {
      const agentId = this._currentAgentTargetId(this._chatTarget);
      const agents = this._enabledAgents();
      if (agentId && this._agentSupportsSharedBrowser(agentId, agents)) {
        const changed = this._setAgentBrowserOverride(agentId, !!config.agentBrowserEnabled, agents);
        if (changed && this._activeManifest) {
          this._activeManifest.agentRuntimeOverrides = this._cloneJson(this._agentRuntimeOverrides);
          this._syncMcpToManifest(agentId);
          saveManifest(this._activeManifest).catch(() => {});
          const label = this._labelForChatTarget(`agent-${agentId}`);
          const cli = this._effectiveCliForChatTarget(`agent-${agentId}`, this._effectiveAgents());
          if (cli === 'codex') {
            this._renderer.banner(`Browser access changed for ${label}. The next message will reconnect its worker session if needed.`);
          } else {
            this._renderer.banner(`Browser access changed for ${label}. The next message will use the updated browser tools.`);
          }
        }
      }
      shouldSyncConfig = true;
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
    if (config.loopObjective !== undefined) {
      this._loopObjective = config.loopObjective || '';
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
    if (this._activeManifest && (
      config.loopMode !== undefined ||
      config.loopObjective !== undefined
    )) {
      this._syncLoopConfigToManifest();
      saveManifest(this._activeManifest).catch(() => {});
    }
    if (shouldSyncConfig) {
      this._syncConfig();
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

  get workspaceName() {
    return this._workspaceName;
  }

  get rootIdentity() {
    return this._rootIdentity;
  }

  /** Return the currently attached run ID, or null. */
  getRunId() {
    return this._activeManifest ? this._activeManifest.runId : null;
  }

  getConfig() {
    return this._getConfig();
  }

  getPanelContext() {
    return {
      workspace: this._workspaceName || null,
      rootKind: this._rootKind || 'repo',
      rootIdentity: this._rootIdentity || null,
      resume: this._resumeToken || null,
      saveResumeAs: this._saveResumeAs || null,
    };
  }

  applyLaunchContext(context = {}) {
    if (context.workspace !== undefined) this._workspaceName = context.workspace || null;
    if (context.rootKind !== undefined) this._rootKind = context.rootKind || (this._workspaceName ? 'named-workspace' : 'repo');
    if (context.rootIdentity !== undefined) this._rootIdentity = context.rootIdentity || this._rootIdentity;
    if (context.resume !== undefined) this._resumeToken = context.resume || null;
    if (context.pendingResumeAlias !== undefined) this._pendingResumeAlias = context.pendingResumeAlias || null;
    if (context.saveResumeAs !== undefined) this._saveResumeAs = context.saveResumeAs || null;
  }

  _syncPanelContext() {
    this._postMessage({ type: 'panelContext', context: this.getPanelContext() });
  }

  syncAttachedRunState() {
    if (!this._activeManifest) return;
    this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
    this.sendUsageSummary();
    this._syncPanelContext();
    this._syncConfig();
    if (this._activeManifest.chatTarget !== undefined && this._activeManifest.chatTarget !== null) {
      this._bannerChatTargetState(this._chatTarget, 'reattach');
    }
  }

  async sendReviewState(force = false) {
    let state;
    try {
      const { probeGitReviewState } = require('./src/git-review');
      state = await probeGitReviewState(this._repoRoot);
    } catch {
      state = {
        isGitRepo: false,
        hasChanges: false,
        hasUnstaged: false,
        hasStaged: false,
        unstagedCount: 0,
        stagedCount: 0,
        unstagedFiles: [],
        stagedFiles: [],
        defaultScope: null,
      };
    }

    const payload = {
      ...state,
      visible: !!(state && state.isGitRepo && state.hasChanges),
    };
    const nextKey = JSON.stringify(payload);
    if (!force && this._lastReviewStateKey === nextKey) return payload;
    this._lastReviewStateKey = nextKey;
    this._postMessage({ type: 'reviewState', reviewState: payload });
    return payload;
  }

  async _resolveResumeSpecifier(token, options = {}) {
    const resolved = await resolveResumeToken(token, this._repoRoot, this._stateRoot, {
      chatTarget: options.chatTarget || this._chatTarget || null,
      ...options,
    });
    if (!resolved || resolved.kind === 'alias' || resolved.kind === 'run' || resolved.kind === 'none') {
      return resolved;
    }
    const rawToken = String(token || '').trim();
    if (!rawToken) return resolved;
    try {
      const runDir = await resolveRunDir(rawToken, this._stateRoot);
      const manifest = await loadManifestFromDir(runDir);
      return {
        kind: 'run',
        token: rawToken,
        runId: manifest && manifest.runId ? String(manifest.runId) : rawToken,
      };
    } catch {
      return resolved;
    }
  }

  async _bindConfiguredResumeAliases() {
    if (!this._activeManifest) return [];
    const aliases = [];
    if (this._pendingResumeAlias) aliases.push(this._pendingResumeAlias);
    if (this._saveResumeAs) aliases.push(this._saveResumeAs);
    const uniqueAliases = Array.from(new Set(aliases.filter(Boolean)));
    if (!uniqueAliases.length) {
      if (!this._resumeToken) {
        this._resumeToken = this._activeManifest.runId;
        this._syncPanelContext();
      }
      return [];
    }

    const results = [];
    for (const alias of uniqueAliases) {
      const result = await bindResumeAlias(this._repoRoot, alias, this._activeManifest.runId, {
        chatTarget: this._chatTarget || this._activeManifest.chatTarget || null,
      });
      results.push(result);
      if (result.overwritten) {
        this._renderer.banner(`Resume alias "${result.alias}" now points to ${this._activeManifest.runId}.`);
      } else {
        this._renderer.banner(`Saved resume alias "${result.alias}" for ${this._activeManifest.runId}.`);
      }
    }

    const preferredAlias = uniqueAliases[uniqueAliases.length - 1];
    this._resumeToken = preferredAlias || this._resumeToken || this._activeManifest.runId;
    this._pendingResumeAlias = null;
    this._saveResumeAs = null;
    if (this._activeManifest) {
      this._activeManifest.resumeToken = this._resumeToken;
      await saveManifest(this._activeManifest);
    }
    this._syncPanelContext();
    return results;
  }

  async _backfillResumeAliasForCurrentTarget() {
    if (!this._activeManifest || !this._activeManifest.runId) return null;

    const runId = String(this._activeManifest.runId || '').trim();
    if (!runId) return null;

    const explicitAlias = this._pendingResumeAlias || this._saveResumeAs || null;
    const resumeToken = String(this._resumeToken || this._activeManifest.resumeToken || '').trim();
    const alias = explicitAlias || (resumeToken && resumeToken !== runId ? resumeToken : '');
    if (!alias) return null;

    const result = await bindResumeAlias(this._repoRoot, alias, runId, {
      chatTarget: this._chatTarget || this._activeManifest.chatTarget || null,
    });

    this._resumeToken = result.alias;
    this._activeManifest.resumeToken = result.alias;
    this._pendingResumeAlias = null;
    this._saveResumeAs = null;
    await saveManifest(this._activeManifest);
    this._syncPanelContext();
    return result;
  }

  _resumeAliasForFreshStart() {
    const runId = this._activeManifest && this._activeManifest.runId
      ? String(this._activeManifest.runId).trim()
      : '';
    const candidate = String(
      this._pendingResumeAlias
      || this._saveResumeAs
      || this._resumeToken
      || (this._activeManifest && this._activeManifest.resumeToken)
      || ''
    ).trim();
    if (!candidate) return null;
    if (runId && candidate === runId) return null;
    return candidate;
  }

  async _resetAttachedRunForLaunch() {
    this._clearWaitTimer();
    await this._closePanelScopedAppServerConnections();
    this._prestartDone = false;
    this._agentRuntimeOverrides = {};
    this._activeManifest = null;
  }

  async _createRun(initialMessage) {
    this._activeManifest = await prepareNewRun(initialMessage, this._buildNewRunOpts());
    this._syncChatLogPath();
    this._postMessage({ type: 'setRunId', runId: this._activeManifest.runId });
    this.sendUsageSummary();
    await this._bindConfiguredResumeAliases();
    if (!this._resumeToken) {
      this._resumeToken = this._activeManifest.runId;
      this._activeManifest.resumeToken = this._resumeToken;
      await saveManifest(this._activeManifest);
      this._syncPanelContext();
    }
    return this._activeManifest;
  }

  _buildImportRunOpts(provider) {
    const opts = this._buildNewRunOpts();
    if (provider === 'codex') {
      opts.controllerCli = 'codex';
      opts.chatTarget = isCodexCliBackend(this._effectiveCliForChatTarget(this._chatTarget))
        ? this._chatTarget
        : 'controller';
      return opts;
    }
    if (provider === 'claude') {
      opts.workerCli = 'claude';
      opts.chatTarget = 'claude';
    }
    return opts;
  }

  async _showImportableChats(provider = null) {
    const sessions = await discoverExternalChatSessions({
      repoRoot: this._repoRoot,
      provider: provider || null,
      limit: 20,
    });
    if (!sessions.length) {
      this._renderer.banner('No matching external chats found for this repository.');
      return;
    }
    this._postMessage({ type: 'importChatHistory', sessions, provider: provider || null, query: '' });
  }

  async _searchImportableChats(provider = null, query = '', requestId = null) {
    const sessions = query
      ? await searchExternalChatSessions({
          repoRoot: this._repoRoot,
          provider: provider || null,
          query,
          limit: 20,
        })
      : await discoverExternalChatSessions({
          repoRoot: this._repoRoot,
          provider: provider || null,
          limit: 20,
        });
    this._postMessage({
      type: 'importChatHistory',
      sessions,
      provider: provider || null,
      query: query || '',
      requestId: requestId == null ? null : requestId,
    });
  }

  async _importChatSession(provider, sessionId) {
    await this._resetAttachedRunForLaunch();
    const imported = await importExternalChatSession({
      repoRoot: this._repoRoot,
      stateRoot: this._stateRoot,
      provider,
      sessionId,
      runOptions: this._buildImportRunOpts(provider),
    });
    const ok = await this.reattachRun(imported.manifest.runId, { suppressUi: true });
    if (!ok) {
      throw new Error(`Imported run ${imported.manifest.runId} could not be reattached.`);
    }
    await this._bindConfiguredResumeAliases();
    this.syncAttachedRunState();
    await this.sendTranscript();
    await this.sendProgress();
    await this.sendReviewState(true);
    this._renderer.banner(`Imported ${provider === 'codex' ? 'Codex' : 'Claude'} session ${sessionId} into ${imported.manifest.runId}.`);
  }

  /**
   * Try to reattach to a previously saved run by ID.
   * Returns true if successful, false if the run no longer exists.
   */
  async reattachRun(runId, options = {}) {
    if (!runId) return false;
    const suppressUi = !!options.suppressUi;
    try {
      const runDir = await resolveRunDir(runId, this._stateRoot);
      this._activeManifest = await loadManifestFromDir(runDir);
      this._syncChatLogPath();
      let manifestChanged = false;
        if (
          !Object.prototype.hasOwnProperty.call(this._activeManifest, 'usageSummary') ||
          usageSummaryNeedsBackfill(this._activeManifest.usageSummary)
        ) {
          const backfillResult = await backfillUsageSummaryFromRun(this._activeManifest);
          manifestChanged = manifestChanged || !!backfillResult.changed;
        }
      if (this._activeManifest.workspaceName !== undefined && this._activeManifest.workspaceName !== null) {
        this._workspaceName = this._activeManifest.workspaceName || null;
      }
      if (this._activeManifest.rootKind) {
        this._rootKind = this._activeManifest.rootKind;
      }
      if (this._activeManifest.rootIdentity) {
        this._rootIdentity = this._activeManifest.rootIdentity;
      }
      if (this._activeManifest.panelId) {
        this._panelId = this._activeManifest.panelId;
      } else if (this._panelId) {
        this._activeManifest.panelId = this._panelId;
        manifestChanged = true;
      }
      if (Number.isFinite(Number(this._activeManifest.chromeDebugPort)) && Number(this._activeManifest.chromeDebugPort) > 0) {
        this._chromePortReservation = Number(this._activeManifest.chromeDebugPort);
      }
      if (this._activeManifest.resumeToken) {
        this._resumeToken = this._activeManifest.resumeToken;
      } else if (!this._resumeToken) {
        this._resumeToken = this._activeManifest.runId;
        this._activeManifest.resumeToken = this._resumeToken;
        manifestChanged = true;
      }
      this._agentRuntimeOverrides = this._normalizeAgentRuntimeOverrides(this._activeManifest.agentRuntimeOverrides);
      const localAgents = this._enabledAgents();
      if (Object.keys(localAgents).length > 0) {
        const effectiveAgents = this._effectiveAgents();
        if (JSON.stringify(this._activeManifest.agents || {}) !== JSON.stringify(effectiveAgents)) {
          this._activeManifest.agents = effectiveAgents;
          manifestChanged = true;
        }
      }
      const restoredTarget = this._normalizeChatTarget(
        this._activeManifest.chatTarget,
        this._enabledAgents(),
      ) || this._normalizeChatTarget(this._chatTarget, this._enabledAgents());
      this._chatTarget = restoredTarget || 'controller';
      if (this._activeManifest.controller && this._activeManifest.controller.cli) {
        this._renderer.controllerLabel = controllerLabelFor(this._activeManifest.controller.cli);
      }
      if (this._activeManifest.loopMode !== undefined) {
        this._loopMode = !!this._activeManifest.loopMode;
      }
      if (this._activeManifest.loopObjective !== undefined) {
        this._loopObjective = this._activeManifest.loopObjective || '';
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
      this._activeManifest.controllerPrestartKey = this._controllerPrestartKey();
      this._activeManifest.workerPrestartKey = this._workerPrestartKey();
      await this._restoreBrowserForAttachedRun();
      if (manifestChanged) {
        await saveManifest(this._activeManifest);
      }
      await this._backfillResumeAliasForCurrentTarget().catch(() => {});
      if (!suppressUi) this.syncAttachedRunState();
      return true;
    } catch {
      // Run no longer exists or is unreadable
      this._postMessage({ type: 'clearRunId' });
      this._postMessage({ type: 'usageStats', summary: null });
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
      const { messages } = await buildTranscriptDisplayTail(filePath, this._activeManifest, {
        maxChars: 50_000,
        initialBytes: 256 * 1024,
        maxBytes: 16 * 1024 * 1024,
        displayOptions: {
          fallbackWorkerLabel: this._renderer && this._renderer.workerLabel,
        },
      });
      if (messages.length > 0) {
        this._postMessage({ type: 'transcriptHistory', messages });
      }
    } catch {
      // Chat log unreadable — not fatal
    }
  }

  /** Read the latest progress tail for the attached run and send it to webview. */
  async sendProgress() {
    if (!this._activeManifest || !this._activeManifest.files || !this._activeManifest.files.progress) {
      this._postMessage({ type: 'progressFull', text: '' });
      return;
    }
    try {
      const { text } = await readTextTail(this._activeManifest.files.progress, {
        fallback: '',
        bytes: PROGRESS_TAIL_MAX_BYTES,
        truncationBannerText: PROGRESS_TAIL_TRUNCATION_BANNER,
      });
      this._postMessage({ type: 'progressFull', text: typeof text === 'string' ? text : '' });
    } catch {
      this._postMessage({ type: 'progressFull', text: '' });
    }
  }

  sendUsageSummary() {
    const summary = this._activeManifest ? usageSummaryMessage(this._activeManifest.usageSummary) : null;
    this._postMessage({ type: 'usageStats', summary });
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

  _clearLoopContinueTimer() {
    if (this._loopContinueTimer) {
      clearTimeout(this._loopContinueTimer);
      this._loopContinueTimer = null;
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
      this._continueDbg('handleMessage:abort', {
        runId: this._activeManifest && this._activeManifest.runId || null,
        hasAbortController: !!this._abortController,
      });
      this.abort();
      return;
    }

    if (msg.type === 'continueInput') {
      // Continue button: send to controller with optional guidance
      const guidance = (msg.text || '').trim();
      this._continueDbg('handleMessage:continueInput', {
        runId: this._activeManifest && this._activeManifest.runId || null,
        guidance,
        chatTarget: this._chatTarget,
        loopMode: this._loopMode,
        running: this._running,
      });
      this._clearLoopContinueTimer();
      this._handleContinue(guidance);
      return;
    }

    if (msg.type === 'orchestrateInput') {
      // Orchestrate button: full controller orchestration with persistent session
      const text = (msg.text || '').trim();
      this._clearLoopContinueTimer();
      await this._handleOrchestrate(text);
      return;
    }

    if (msg.type === 'reviewRequest') {
      const scope = String(msg.scope || '').trim();
      const guidance = (msg.guidance || '').trim();
      this._clearLoopContinueTimer();
      await this._handleReviewRequest(scope, guidance);
      return;
    }

    if (msg.type === 'userInput') {
      this._clearLoopContinueTimer();
      await this._handleInput(String(msg.text || '').trim());
      return;
    }

    if (msg.type === 'searchImportChats') {
      const provider = msg.provider ? String(msg.provider).trim().toLowerCase() : '';
      const query = String(msg.query || '').trim();
      if (provider && provider !== 'codex' && provider !== 'claude') {
        return;
      }
      await this._searchImportableChats(provider || null, query, msg.requestId);
      return;
    }

    if (msg.type === 'reviewStateRequest') {
      await this.sendReviewState(true);
      return;
    }

    if (msg.type === 'captureTurnBrowserScreenshot') {
      await this._handleCaptureTurnBrowserScreenshot(msg);
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
      this._traceBrowser('handleIncomingMessage:browserStart', { tab: 'browser' });
      await this._startChromeDirect();
      return;
    }

    if (msg.type === 'browserStartScreencast') {
      this._traceBrowser('handleIncomingMessage:browserStartScreencast', { reason: msg.reason || null });
      await this._requestChromeScreencast(msg.reason || 'browser-start-screencast');
      return;
    }

    if (msg.type === 'browserStopScreencast') {
      this._traceBrowser('handleIncomingMessage:browserStopScreencast', { reason: msg.reason || null });
      this._stopChromeScreencast(msg.reason || 'browser-stop-screencast');
      return;
    }

    if (msg.type === 'chromeInput') {
      const { sendInput } = require('./chrome-manager');
      this._traceBrowser('handleIncomingMessage:chromeInput', { method: msg.cdpMethod });
      sendInput(this._panelId, msg.cdpMethod, msg.cdpParams);
      return;
    }
  }

  abort() {
    this._clearLoopContinueTimer();
    this._continueDbg('abort:requested', {
      runId: this._activeManifest && this._activeManifest.runId || null,
      hasAbortController: !!this._abortController,
      running: this._running,
    });
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

  _browserScreenshotAgentContext() {
    const agents = this._enabledAgents();
    let agentId = this._currentExecutingAgentId();
    if (!agentId && this._chatTarget && this._chatTarget.startsWith('agent-')) {
      agentId = this._chatTarget.slice('agent-'.length);
    }
    const agentConfig = agentId ? agents[agentId] : null;
    const workerCli = (agentConfig && agentConfig.cli)
      || this._workerCli
      || (this._activeManifest && this._activeManifest.worker && this._activeManifest.worker.cli)
      || 'codex';
    return {
      agentId: agentId || null,
      workerCli,
    };
  }

  async _persistChatScreenshotEntry(entry, options = {}) {
    if (!this._activeManifest || !entry || entry.type !== 'chatScreenshot') return;
    const safeEntry = {
      ts: new Date().toISOString(),
      type: 'chatScreenshot',
      data: entry.data,
      alt: entry.alt || 'Screenshot',
      closeAfter: !!entry.closeAfter,
    };
    if (this._activeManifest.files && this._activeManifest.files.chatLog) {
      try {
        fs.appendFileSync(this._activeManifest.files.chatLog, JSON.stringify(safeEntry) + '\n');
      } catch {}
    }
    const { requestId, loopIndex } = this._latestRequestMeta();
    const context = this._browserScreenshotAgentContext();
    await appendTranscriptRecord(this._activeManifest, createTranscriptRecord({
      kind: 'ui_message',
      sessionKey: workerSessionKey(context.agentId),
      backend: transcriptBackend('worker', context.workerCli),
      requestId,
      loopIndex,
      agentId: context.agentId,
      workerCli: context.workerCli,
      payload: safeEntry,
      display: true,
      text: options.text || null,
    })).catch(() => {});
  }

  async _handleCaptureTurnBrowserScreenshot(msg) {
    const token = String(msg && msg.token || '').trim();
    if (!token || this._pendingTurnBrowserScreenshotTokens.has(token)) {
      return;
    }
    this._pendingTurnBrowserScreenshotTokens.add(token);
    try {
      if (!this._activeManifest || !this._chromePort) {
        this._postMessage({ type: 'chatScreenshotCaptureSkipped', _anchorToken: token });
        return;
      }
      const { capturePanelScreenshot } = require('./chrome-manager');
      const capture = await capturePanelScreenshot(this._panelId, { format: 'jpeg', quality: 70 });
      const message = {
        type: 'chatScreenshot',
        data: capture.dataUrl,
        alt: 'Browser screenshot',
        closeAfter: true,
      };
      await this._persistChatScreenshotEntry(message, {
        text: capture && capture.targetUrl ? `Browser screenshot captured from ${capture.targetUrl}` : null,
      });
      this._postMessage({ ...message, _anchorToken: token });
    } catch (error) {
      this._sDbg(`captureTurnBrowserScreenshot failed: ${error && error.message ? error.message : error}`);
      this._postMessage({ type: 'chatScreenshotCaptureSkipped', _anchorToken: token });
    } finally {
      this._pendingTurnBrowserScreenshotTokens.delete(token);
    }
  }

  async _compactCurrentSession() {
    if (!this._activeManifest) {
      this._renderer.banner('No run is attached.');
      return;
    }
    this._syncActiveManifestApiConfig();
    const { compactCurrentSession } = require('./src/session-compaction');

    const { requestId, loopIndex } = this._latestRequestMeta();
    const endActivity = this._beginActivity('utility');
    const endCompaction = this._beginCompactionState('manual', {
      key: 'manual:/compact',
      statusText: 'Compacting chat context...',
    });
    try {
      appendWizardDebug('session-compaction', '_compactCurrentSession:start', {
        repoRoot: this._repoRoot,
        runId: this._activeManifest.runId,
        chatTarget: this._chatTarget,
        requestId,
        loopIndex,
      });
      const result = await compactCurrentSession({
        manifest: this._activeManifest,
        chatTarget: this._chatTarget,
        controllerCli: this._controllerCli,
        workerCli: this._workerCli,
        requestId,
        loopIndex,
        renderer: this._renderer,
      });
      await saveManifest(this._activeManifest);
      this._renderer.banner((result && result.message) || 'Compaction finished.');
      appendWizardDebug('session-compaction', '_compactCurrentSession:done', {
        repoRoot: this._repoRoot,
        runId: this._activeManifest.runId,
        chatTarget: this._chatTarget,
        performed: !!(result && result.performed),
        message: result && result.message || null,
      });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      appendWizardDebug('session-compaction', '_compactCurrentSession:failed', {
        repoRoot: this._repoRoot,
        runId: this._activeManifest.runId,
        chatTarget: this._chatTarget,
        message,
      });
      this._renderer.banner(`Compaction failed: ${message}`);
    } finally {
      endCompaction();
      endActivity();
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
        await this._createRun(text);
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
        '  /resume [run-id-or-alias]      Attach to an existing run or alias\n' +
        '  /import-chat [provider]        Import a Codex or Claude chat into a new run\n' +
        '  /alias <name>                  Save the current run under an alias\n' +
        '  /unalias <name>                Remove a saved resume alias\n' +
        '  /aliases                       List saved resume aliases\n' +
        '  /run                           Continue an interrupted request\n' +
        '  /status                        Show status for the attached run\n' +
        '  /list                          List saved runs\n' +
        '  /logs [n]                      Show the last n event lines\n' +
        '  /clear                         Clear chat and start fresh\n' +
        '  /compact                       Compact the current session now\n' +
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
      const preservedAlias = this._preserveResumeAliasOnClear ? this._resumeAliasForFreshStart() : null;
      const preservedTargetLabel = this._labelForChatTarget(this._chatTarget || 'controller');
      this._resumeDbg(`clear:start preserve=${this._preserveResumeAliasOnClear} alias=${preservedAlias || ''} runId=${this._activeManifest && this._activeManifest.runId || ''} chatTarget=${this._chatTarget || ''} resumeToken=${this._resumeToken || ''}`);
      if (preservedAlias) {
        if (this._activeManifest) {
          try { closeInteractiveSessions(this._activeManifest); } catch {}
        }
        try {
          const removed = await removeResumeAliasTarget(this._repoRoot, preservedAlias, this._chatTarget || this._activeManifest?.chatTarget || null);
          this._resumeDbg(`clear:removeResumeAliasTarget alias=${preservedAlias} chatTarget=${this._chatTarget || this._activeManifest?.chatTarget || ''} removed=${removed ? 'yes' : 'no'}`);
        } catch (error) {
          this._resumeDbg(`clear:removeResumeAliasTarget error=${error && error.message ? error.message : String(error)}`);
        }
      }
      await this._closePanelScopedAppServerConnections();
      this._prestartDone = false;
      this._agentRuntimeOverrides = {};
      this._activeManifest = null;
      if (preservedAlias) {
        this._pendingResumeAlias = preservedAlias;
        this._saveResumeAs = null;
        this._resumeToken = preservedAlias;
      } else {
        this._pendingResumeAlias = null;
        this._saveResumeAs = null;
        this._resumeToken = null;
      }
      try {
        const aliases = await listResumeAliases(this._repoRoot);
        this._resumeDbg(`clear:after alias=${preservedAlias || ''} runId=<cleared> aliases=${JSON.stringify(aliases)}`);
      } catch (error) {
        this._resumeDbg(`clear:after alias-list-error=${error && error.message ? error.message : String(error)}`);
      }
      this._postMessage({ type: 'clear' });
      this._postMessage({ type: 'clearRunId' });
      this._postMessage({ type: 'usageStats', summary: null });
      this._postMessage({ type: 'progressFull', text: '' });
      this._syncConfig();
      if (preservedAlias) {
        this._syncPanelContext();
        this._renderer.banner(`Session cleared. The next message will start a fresh ${preservedTargetLabel} session and rebind alias "${preservedAlias}".`);
      } else {
        this._syncPanelContext();
        this._renderer.banner('Session cleared. The next message will start a fresh session.');
      }
      // Re-prestart app-server so next message is fast
      this.prestart();
      await this.sendReviewState(true);
      return;
    }

    if (command === '/compact') {
      await this._compactCurrentSession();
      return;
    }

    if (command === '/detach') {
      this._clearWaitTimer();
      await this._closePanelScopedAppServerConnections();
      this._prestartDone = false;
      this._agentRuntimeOverrides = {};
      this._activeManifest = null;
      this._postMessage({ type: 'clearRunId' });
      this._postMessage({ type: 'usageStats', summary: null });
      this._postMessage({ type: 'progressFull', text: '' });
      this._syncConfig();
      this._renderer.banner('Detached from the current run.');
      this.prestart();
      await this.sendReviewState(true);
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
      const resolved = await this._resolveResumeSpecifier(rest, { allowPendingAlias: true });
      this._resumeDbg(`resume:requested token=${rest} resolved=${JSON.stringify(resolved)}`);
      if (resolved.kind === 'pending-alias' || resolved.kind === 'stale-alias') {
        this._pendingResumeAlias = resolved.alias;
        this._resumeToken = resolved.alias;
        this._syncPanelContext();
        this._renderer.banner(`Resume alias "${resolved.alias}" will be bound to the next new run in this workspace.`);
        return;
      }
      if (resolved.kind === 'missing' || resolved.kind === 'none') {
        this._renderer.banner(`Previous run or alias ${rest} no longer exists.`);
        return;
      }
      this._resumeToken = resolved.kind === 'alias' ? resolved.alias : resolved.runId;
      this._syncPanelContext();
      const ok = await this.reattachRun(resolved.runId);
      this._resumeDbg(`resume:reattach token=${rest} runId=${resolved.runId} ok=${ok}`);
      if (!ok) {
        this._renderer.banner(`Previous run ${rest} no longer exists.`);
        return;
      }
      await this.sendTranscript();
      this._renderer.requestStarted(this._activeManifest.runId);
      await this.sendProgress();
      this._restoreWaitTimer();
      return;
    }

    if (command === '/import-chat') {
      const parts = rest ? rest.split(/\s+/).filter(Boolean) : [];
      const provider = parts[0] ? String(parts[0]).trim().toLowerCase() : '';
      const sessionId = parts[1] ? String(parts[1]).trim() : '';
      if (parts.length > 2 || (provider && provider !== 'codex' && provider !== 'claude')) {
        this._renderer.banner('Usage: /import-chat [codex|claude] [session-id]');
        return;
      }
      if (!sessionId) {
        await this._showImportableChats(provider || null);
        return;
      }
      await this._importChatSession(provider, sessionId);
      return;
    }

    if (command === '/aliases') {
      const aliases = await listResumeAliases(this._repoRoot);
      if (!aliases.length) {
        this._renderer.banner('No resume aliases saved for this workspace.');
        return;
      }
      this._renderer.banner(
        ['Resume aliases:', ...aliases.map((alias) => `  ${alias.name} -> ${alias.runId}${alias.chatTarget ? ` (${alias.chatTarget})` : ''}`)].join('\n')
      );
      return;
    }

    if (command === '/alias') {
      if (!rest) {
        this._renderer.banner('Usage: /alias <name>');
        return;
      }
      if (!this._activeManifest) {
        this._renderer.banner('No run is attached.');
        return;
      }
      const result = await bindResumeAlias(this._repoRoot, rest, this._activeManifest.runId, {
        chatTarget: this._chatTarget || this._activeManifest.chatTarget || null,
      });
      this._resumeToken = result.alias;
      this._pendingResumeAlias = null;
      this._saveResumeAs = null;
      this._activeManifest.resumeToken = this._resumeToken;
      await saveManifest(this._activeManifest);
      this._syncPanelContext();
      this._renderer.banner(
        result.overwritten
          ? `Resume alias "${result.alias}" now points to ${this._activeManifest.runId}.`
          : `Saved resume alias "${result.alias}" for ${this._activeManifest.runId}.`
      );
      return;
    }

    if (command === '/unalias') {
      if (!rest) {
        this._renderer.banner('Usage: /unalias <name>');
        return;
      }
      const removed = await removeResumeAlias(this._repoRoot, rest);
      if (!removed) {
        this._renderer.banner(`Resume alias "${rest}" was not found.`);
        return;
      }
      if (this._resumeToken && String(this._resumeToken).toLowerCase() === String(rest).trim().toLowerCase()) {
        this._resumeToken = this._activeManifest ? this._activeManifest.runId : null;
        this._syncPanelContext();
      }
      this._renderer.banner(`Removed resume alias "${rest}".`);
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

      await this._createRun(rest);
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
          await this._createRun(message);
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
      rootKind: this._rootKind || 'repo',
      rootIdentity: this._rootIdentity || null,
      workspaceName: this._workspaceName || null,
      resumeToken: this._resumeToken || this._pendingResumeAlias || this._saveResumeAs || null,
    };
    const reservedChromePort = this._currentReservedChromePort();
    if (reservedChromePort) {
      opts.chromeDebugPort = reservedChromePort;
      opts.workerBoundBrowserPort = reservedChromePort;
      opts.controllerPrestartKey = this._controllerPrestartKey(reservedChromePort);
      opts.workerPrestartKey = this._workerPrestartKey(reservedChromePort);
    }
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
    opts.loopMode = !!this._loopMode;
    opts.loopObjective = (this._loopObjective || '').trim() || null;
    opts.chatTarget = this._chatTarget || 'controller';
    // Split MCP servers by target role; workers using qa-remote-* backends need host.docker.internal URLs
    const workerIsRemote = typeof this._workerCli === 'string' && this._workerCli.startsWith('qa-remote');
    const controllerMcp = this._mcpServersForRole('controller', false);
    const workerMcp = this._mcpServersForRole('worker', workerIsRemote);
    if (Object.keys(controllerMcp).length > 0) opts.controllerMcpServers = controllerMcp;
    if (Object.keys(workerMcp).length > 0) opts.workerMcpServers = workerMcp;
    const agents = this._effectiveAgents();
    if (Object.keys(agents).length > 0) opts.agents = agents;
    if (Object.keys(this._agentRuntimeOverrides || {}).length > 0) {
      opts.agentRuntimeOverrides = this._cloneJson(this._agentRuntimeOverrides);
    }
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
    opts.lazyMcpToolsEnabled = !!this._lazyMcpToolsEnabled;
    opts.learnedApiToolsEnabled = !!this._learnedApiToolsEnabled;
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
      loopMode: !!this._loopMode,
      loopObjective: this._loopObjective || '',
      chatTarget: this._chatTarget || 'controller',
      agentBrowserEnabled: (() => {
        const agentId = this._currentAgentTargetId(this._chatTarget);
        if (!agentId || !this._agentSupportsSharedBrowser(agentId)) return null;
        return this._effectiveAgentBrowserEnabled(agentId);
      })(),
      controllerCli: this._controllerCli || 'codex',
      codexMode: this._codexMode || 'app-server',
      workerCli: this._workerCli || 'codex',
      apiProvider: this._apiProvider || 'openrouter',
      apiBaseURL: this._apiBaseURL || '',
    };
  }

  _runNeedsChromeDevtools() {
    const agents = (this._activeManifest && this._activeManifest.agents) || this._effectiveAgents();
    const activeAgentId = this._currentAgentTargetId(this._chatTarget);
    if (activeAgentId) {
      return this._agentHasChromeDevtools(agents && agents[activeAgentId]);
    }
    return Object.values(agents).some((agent) =>
      agent && agent.mcps && Object.keys(agent.mcps).some((name) =>
        name.includes('chrome-devtools') || name.includes('chrome_devtools')
      )
    );
  }

  _canPrestartChrome() {
    // A fresh unattached panel should not eagerly claim/start Chrome just
    // because browser-capable agents exist in the dropdown. Only attached
    // runs have authoritative browser identity to prestart against.
    return !!this._activeManifest && this._runNeedsChromeDevtools();
  }

  _stripChromeDevtoolsMcps(servers = {}) {
    return Object.fromEntries(
      Object.entries(servers || {}).filter(([name]) =>
        !(name.includes('chrome-devtools') || name.includes('chrome_devtools'))
      )
    );
  }

  async setWebviewVisible(visible) {
    const nextVisible = visible !== false;
    if (this._webviewVisible === nextVisible) return;
    this._webviewVisible = nextVisible;
    this._traceBrowser('setWebviewVisible', {
      visible: nextVisible,
      chromePort: this._chromePort || null,
      screencastActive: this._screencastActive,
      screencastPort: this._screencastPort || null,
    });
    if (!nextVisible) {
      this._pauseChromeScreencast('webview-hidden');
      return;
    }
    if (this._chromePort && this._screencastWanted) {
      await this._startChromeScreencast(this._chromePort, 'view-state-visible');
    }
  }

  _pauseChromeScreencast(source) {
    this._screencastStartToken += 1;
    try { require('./chrome-manager').stopScreencast(this._panelId); } catch {}
    this._screencastActive = false;
    this._screencastPort = null;
    this._traceBrowser('_pauseChromeScreencast', { source, wanted: this._screencastWanted });
  }

  _stopChromeScreencast(source) {
    this._screencastWanted = false;
    this._pauseChromeScreencast(source);
  }

  async _requestChromeScreencast(source) {
    this._screencastWanted = true;
    if (!this._chromePort) {
      await this._ensurePanelChrome(source, {
        lifecycle: 'screencast',
        startScreencast: true,
        emitLifecycleBanner: false,
      });
      return;
    }
    await this._startChromeScreencast(this._chromePort, source);
  }

  async _startChromeScreencast(port, source) {
    const { startScreencast } = require('./chrome-manager');
    this._screencastWanted = true;
    if (!this._webviewVisible) {
      this._sDbg(`${source}: Chrome on port ${port}, skipping screencast because webview is hidden panelId=${this._panelId}`);
      this._traceBrowser('_startChromeScreencast:skipped-hidden', { source, port });
      return;
    }
    if (this._screencastActive && this._screencastPort === port) {
      this._sDbg(`${source}: Chrome screencast already active on port ${port}, posting chromeReady panelId=${this._panelId}`);
      this._postMessage({ type: 'chromeReady', chromePort: port });
      this._traceBrowser('_startChromeScreencast:already-active', { source, port });
      return;
    }
    const startToken = ++this._screencastStartToken;
    this._sDbg(`${source}: Chrome on port ${port}, calling startScreencast panelId=${this._panelId}`);
    this._traceBrowser('_startChromeScreencast:before', { source, port });
    const startResult = await startScreencast(this._panelId, (frameData, metadata) => {
      this._postMessage({ type: 'chromeFrame', data: frameData, metadata });
    }, (url) => {
      this._traceBrowser('_startChromeScreencast:navigation', { source, port, url });
      this._postMessage({ type: 'chromeUrl', url });
    });
    if (!startResult || startResult.started !== true) {
      if (this._screencastStartToken === startToken) {
        this._screencastActive = false;
        this._screencastPort = null;
      }
      this._traceBrowser('_startChromeScreencast:not-started', { source, port, result: startResult || null });
      return startResult || null;
    }
    if (!this._webviewVisible || this._screencastStartToken !== startToken) {
      if (!this._webviewVisible) {
        try { require('./chrome-manager').stopScreencast(this._panelId); } catch {}
        this._screencastActive = false;
        this._screencastPort = null;
      }
      this._traceBrowser('_startChromeScreencast:aborted-after-start', {
        source,
        port,
        visible: this._webviewVisible,
        startToken,
        currentToken: this._screencastStartToken,
        result: startResult,
      });
      return startResult;
    }
    this._sDbg(`${source}: startScreencast returned, posting chromeReady`);
    this._screencastActive = true;
    this._screencastPort = port;
    this._postMessage({ type: 'chromeReady', chromePort: port });
    this._traceBrowser('_startChromeScreencast:after', { source, port, result: startResult });
    return startResult;
  }

  async _restoreBrowserForAttachedRun() {
    if (!this._activeManifest || !this._runNeedsChromeDevtools()) return;
    if (this._restoreBrowserPromise) {
      await this._restoreBrowserPromise;
      return;
    }
    const restorePromise = (async () => {
      this._chromePort = null;
      this._traceBrowser('_restoreBrowserForAttachedRun:entry');
      try {
        const manifest = this._activeManifest;
        const savedPort = Number(manifest.chromeDebugPort);
        const chrome = await this._ensurePanelChrome('_restoreBrowserForAttachedRun', {
          port: Number.isFinite(savedPort) && savedPort > 0 ? savedPort : null,
          lifecycle: 'restore',
          expectRestart: Number.isFinite(savedPort) && savedPort > 0,
          emitLifecycleBanner: false,
          startScreencast: false,
        });
        if (!chrome) return;
        if (chrome.status === 'started' && Number.isFinite(savedPort) && savedPort > 0) {
          this._renderer.banner(`Previous browser session was unavailable; restarted Chrome on port ${chrome.port} for this run.`);
        } else {
          this._renderer.banner(`Reattached browser session for this run on port ${chrome.port}.`);
        }
        this._traceBrowser('_restoreBrowserForAttachedRun:done', { savedPort, result: chrome });
      } catch (err) {
        this._sDbg(`_restoreBrowserForAttachedRun: error: ${err.message}`);
        this._postMessage({ type: 'chromeGone' });
        this._traceBrowser('_restoreBrowserForAttachedRun:error', { error: err.message });
      }
    })();
    this._restoreBrowserPromise = restorePromise;
    try {
      await restorePromise;
    } finally {
      if (this._restoreBrowserPromise === restorePromise) {
        this._restoreBrowserPromise = null;
      }
    }
  }

  /**
   * Pre-start Chrome and Codex app-server in the background.
   * Called right after panel creation to speed up the first message.
   * Chrome starts first (so we have the debug port), then Codex app-server.
   */
  prestart() {
    if (this._prestartPromise || this._prestartDone) return;
    const prestartPromise = this._prestartAsync();
    this._prestartPromise = prestartPromise;
    prestartPromise.catch(() => {}).finally(() => {
      if (this._prestartPromise === prestartPromise) {
        this._prestartPromise = null;
      }
    });
  }

  async _prestartAsync() {
    if (this._restoreBrowserPromise) {
      try { await this._restoreBrowserPromise; } catch {}
    }
    const agents = this._enabledAgents();

    // Determine what needs pre-starting
    const canPrestartChrome = this._canPrestartChrome();
    const needsChrome = !this._chromePort && canPrestartChrome;

    this._sDbg(`_prestartAsync: panelId=${this._panelId} needsChrome=${needsChrome} canPrestartChrome=${canPrestartChrome}`);
    this._traceBrowser('_prestartAsync:entry', { needsChrome, canPrestartChrome });

    // Step 1: Start Chrome (if needed) — must complete before Codex so we have the port
    // NOTE: prestart() is only called after the webview 'ready' message restores panelId,
    // so this._panelId is stable here.
    if (needsChrome) {
      const reservedPort = await this._reserveChromePort();
      this._browserBanner(`browser-prestart:${this._panelId}:${reservedPort}`, `Prestarting Chrome on port ${reservedPort}.`);
      await this._ensurePanelChrome('prestart', { port: reservedPort, lifecycle: 'prestart', emitLifecycleBanner: false, startScreencast: false });
      this._traceBrowser('_prestartAsync:chrome-ready', { reservedPort });
    }
    const chromeReady = !!this._chromePort;

    // Step 2: Start agent-delegate MCP so it's included in the fingerprint
    await this._startAgentDelegateMcp();

    // Step 3: Pre-start Codex app-server (now chromeDebugPort and agent-delegate are set)
    const { prestartConnection } = require('./src/codex-app-server');
    const controllerMcps = this._mcpServersForRole('controller', false);
    const workerMcps = this._mcpServersForRole('worker', false);
    const mcpNeedsChrome = (servers) => Object.keys(servers || {}).some((name) => name.includes('chrome-devtools') || name.includes('chrome_devtools'));
    // Prefer the currently selected agent's MCPs, then fall back to the first enabled agent with MCPs.
    let defaultAgentMcps = {};
    const currentAgentId = this._currentAgentTargetId(this._chatTarget);
    if (currentAgentId && agents[currentAgentId] && agents[currentAgentId].mcps) {
      defaultAgentMcps = agents[currentAgentId].mcps;
    } else {
      for (const a of Object.values(agents)) {
        if (a && a.mcps && Object.keys(a.mcps).length > 0) {
          defaultAgentMcps = a.mcps;
          break;
        }
      }
    }
    const fullWorkerMcps = { ...workerMcps, ...defaultAgentMcps };
    const prestartControllerMcps = chromeReady ? controllerMcps : this._stripChromeDevtoolsMcps(controllerMcps);
    const prestartWorkerMcps = chromeReady ? fullWorkerMcps : this._stripChromeDevtoolsMcps(fullWorkerMcps);
    const controllerCanPrestart = !mcpNeedsChrome(prestartControllerMcps) || chromeReady;
    const workerCanPrestart = !mcpNeedsChrome(prestartWorkerMcps) || chromeReady;
    const baseManifest = {
      panelId: this._panelId,
      repoRoot: this._repoRoot,
      extensionDir: this._extensionPath,
      chromeDebugPort: this._currentReservedChromePort(),
    };
    const controllerPrestartKey = this._controllerPrestartKey(baseManifest.chromeDebugPort);
    const workerPrestartKey = this._workerPrestartKey(baseManifest.chromeDebugPort);

    // Pre-start controller and worker connections in parallel
    await Promise.all([
      controllerCanPrestart
        ? prestartConnection({
            key: controllerPrestartKey,
            bin: 'codex',
            cwd: this._repoRoot,
            mcpServers: prestartControllerMcps,
            manifest: baseManifest,
          }).catch(() => {})
        : Promise.resolve(),
      workerCanPrestart
        ? prestartConnection({
            key: workerPrestartKey,
            bin: 'codex',
            cwd: this._repoRoot,
            mcpServers: prestartWorkerMcps,
            manifest: baseManifest,
          }).catch(() => {})
        : Promise.resolve(),
    ]);
    this._traceBrowser('_prestartAsync:appserver-prestarted', {
      controllerPrestartKey,
      workerPrestartKey,
      chromeReady,
      chromeDebugPort: baseManifest.chromeDebugPort,
      controllerCanPrestart,
      workerCanPrestart,
      controllerMcpKeys: Object.keys(prestartControllerMcps),
      workerMcpKeys: Object.keys(prestartWorkerMcps),
    });

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
    this._activeManifest.agents = this._effectiveAgents();
    this._activeManifest.agentRuntimeOverrides = this._cloneJson(this._agentRuntimeOverrides);
    if (!this._activeManifest.worker.agentSessions) this._activeManifest.worker.agentSessions = {};
    this._activeManifest.controllerPrestartKey = this._controllerPrestartKey();
    this._activeManifest.workerPrestartKey = this._workerPrestartKey();
    if (this._currentReservedChromePort()) {
      this._activeManifest.chromeDebugPort = this._currentReservedChromePort();
    }
    this._traceBrowser('_syncMcpToManifest', {
      agentId: agentId || null,
      controllerMcpKeys: Object.keys(controllerMcp),
      workerMcpKeys: Object.keys(workerMcp),
      chromeDebugPort: this._activeManifest.chromeDebugPort || null,
    });
  }

  /** Start headless Chrome if a local agent needs chrome-devtools MCP. */
  async _ensureChromeIfNeeded(agentId) {
    // Determine which CLI will run
    let cli = this._workerCli || 'codex';
    if (agentId) {
      const agents = (this._activeManifest && this._activeManifest.agents) || this._effectiveAgents();
      const agent = agents[agentId];
      if (agent && agent.cli) cli = agent.cli;
    }
    // Remote agents have their own Chrome inside the container
    if (typeof cli === 'string' && cli.startsWith('qa-remote')) return;

    // Check if any MCP server looks like chrome-devtools
    const mcpServers = this._activeManifest
      ? (this._activeManifest.workerMcpServers || {})
      : {};
    const agents = (this._activeManifest && this._activeManifest.agents) || this._effectiveAgents();
    const agentMcps = agentId ? ((agents[agentId] || {}).mcps || {}) : {};
    const allMcps = { ...mcpServers, ...agentMcps };
    const hasChromeDevtools = Object.keys(allMcps).some(n =>
      n.includes('chrome-devtools') || n.includes('chrome_devtools')
    );
    if (!hasChromeDevtools) return;
    this._traceBrowser('_ensureChromeIfNeeded:entry', { agentId, cli, mcpKeys: Object.keys(allMcps) });

    if (this._restoreBrowserPromise) {
      try { await this._restoreBrowserPromise; } catch {}
    }
    if (this._prestartPromise) {
      try { await this._prestartPromise; } catch {}
    }

    this._renderer.banner('Waiting for headless Chrome\u2026');
    await this._ensurePanelChrome('_ensureChromeIfNeeded', {
      lifecycle: this._chromePort ? 'reuse' : 'worker',
      startScreencast: false,
    });

    // Always ensure the port is on the manifest for buildClaudeArgs to use
    if (this._activeManifest) {
      this._activeManifest.chromeDebugPort = this._currentReservedChromePort();
      this._activeManifest.controllerPrestartKey = this._controllerPrestartKey();
      this._activeManifest.workerPrestartKey = this._workerPrestartKey();
    }
    // Always ensure extensionDir is on the manifest for placeholder replacement
    if (this._extensionPath && this._activeManifest) {
      this._activeManifest.extensionDir = this._extensionPath;
    }
    this._traceBrowser('_ensureChromeIfNeeded:done', { agentId, cli, activeChromePort: this._chromePort });
  }

  /** Start headless Chrome directly (e.g. from Browser tab click). */
  async _startChromeDirect() {
    this._sDbg(`_startChromeDirect called, panelId=${this._panelId}, existing chromePort=${this._chromePort}`);
    this._traceBrowser('_startChromeDirect:entry');
    if (this._restoreBrowserPromise) {
      try { await this._restoreBrowserPromise; } catch {}
    }
    if (this._prestartPromise) {
      try { await this._prestartPromise; } catch {}
    }
    const chrome = await this._ensurePanelChrome('_startChromeDirect', {
      lifecycle: this._chromePort ? 'reuse' : 'direct',
      startScreencast: true,
    });
    this._sDbg(`_startChromeDirect: ensure returned ${chrome ? JSON.stringify(chrome) : 'null'}`);
    this._traceBrowser('_startChromeDirect:done', { result: chrome });
  }

  async _runDirectWorker(userMessage) {
    await this._startAgentDelegateMcp();
    this._syncMcpToManifest();
    await this._ensureChromeIfNeeded();
    // Ensure extensionDir is always on the manifest for MCP placeholder replacement
    if (this._extensionPath && this._activeManifest) {
      this._activeManifest.extensionDir = this._extensionPath;
    }
    const endActivity = this._beginActivity('foreground');
    this._abortController = new AbortController();

    try {
      this._activeManifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
        userMessage,
        enableWorkerHandoff: true,
        abortSignal: this._abortController.signal,
        ...this._workerRunHooks(),
      });
      this._syncLoopConfigToManifest();
      if (this._activeManifest.waitDelay !== (this._waitDelay || null)) {
        this._activeManifest.waitDelay = this._waitDelay || null;
      }
      await saveManifest(this._activeManifest);
    } finally {
      this._abortController = null;
      endActivity();
      await this.sendReviewState(true);
    }
  }

  async _runDirectAgent(userMessage, agentId) {
    await this._startAgentDelegateMcp();
    this._syncMcpToManifest(agentId);
    const endActivity = this._beginActivity('foreground');
    this._abortController = new AbortController();
    await this._ensureChromeIfNeeded(agentId);
    // Ensure extensionDir is always on the manifest for MCP placeholder replacement
    if (this._extensionPath && this._activeManifest) {
      this._activeManifest.extensionDir = this._extensionPath;
    }

    try {
      this._activeManifest = await runDirectWorkerTurn(this._activeManifest, this._renderer, {
        userMessage,
        agentId,
        enableWorkerHandoff: true,
        abortSignal: this._abortController.signal,
        ...this._workerRunHooks(),
      });
      this._syncLoopConfigToManifest();
      if (this._activeManifest.waitDelay !== (this._waitDelay || null)) {
        this._activeManifest.waitDelay = this._waitDelay || null;
      }
      await saveManifest(this._activeManifest);
    } finally {
      this._abortController = null;
      endActivity();
      await this.sendReviewState(true);
    }
  }

  /**
   * Copilot mode: user → agent directly, then controller watches and auto-continues.
   */
  /**
   * Handle Continue button: run one controller→agent cycle with optional guidance.
   */
  async _handleContinue(guidance) {
    if (this._running) {
      this._continueDbg('_handleContinue:skipped-already-running', {
        runId: this._activeManifest && this._activeManifest.runId || null,
        guidance,
      });
      return;
    }
    this._continueDbg('_handleContinue:enter', {
      runId: this._activeManifest && this._activeManifest.runId || null,
      guidance,
      chatTarget: this._chatTarget,
      loopMode: this._loopMode,
    });
    try {
      await this._runControllerContinue(guidance);
      this._continueDbg('_handleContinue:completed', {
        runId: this._activeManifest && this._activeManifest.runId || null,
        status: this._activeManifest && this._activeManifest.status || null,
      });
    } catch (error) {
      this._continueDbg('_handleContinue:error', {
        runId: this._activeManifest && this._activeManifest.runId || null,
        error: error && error.stack ? error.stack : formatRunError(error),
      });
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
    this._continueDbg('_runControllerContinue:start', {
      runId: this._activeManifest.runId,
      guidance,
      chatTarget: this._chatTarget,
      loopMode: this._loopMode,
      controllerCli: this._activeManifest.controller && this._activeManifest.controller.cli || null,
      codexMode: this._activeManifest.controller && this._activeManifest.controller.codexMode || null,
      controllerSessionId: this._activeManifest.controller && this._activeManifest.controller.sessionId || null,
      controllerAppServerThreadId: this._activeManifest.controller && this._activeManifest.controller.appServerThreadId || null,
      lastSeenTranscriptLine: this._activeManifest.controller && this._activeManifest.controller.lastSeenTranscriptLine || null,
      lastSeenChatLine: this._activeManifest.controller && this._activeManifest.controller.lastSeenChatLine || null,
    });

    let lockedAgentId = null;
    let directiveAgentId = null;
    if (this._chatTarget === 'claude') {
      lockedAgentId = null;
      directiveAgentId = 'default';
    } else if (this._chatTarget && this._chatTarget.startsWith('agent-')) {
      lockedAgentId = this._chatTarget.slice('agent-'.length);
      directiveAgentId = lockedAgentId;
    }

    const sanitizedPrompt = sanitizePersistedControllerSystemPrompt(this._activeManifest.controllerSystemPrompt);
    const promptWasSanitized = sanitizedPrompt !== this._activeManifest.controllerSystemPrompt;
    if (promptWasSanitized) {
      this._activeManifest.controllerSystemPrompt = sanitizedPrompt;
      if (this._activeManifest.controller) {
        this._activeManifest.controller.apiSystemPromptSnapshot = null;
      }
      await saveManifest(this._activeManifest);
    }

    const basePrompt = sanitizedPrompt || this._buildCopilotBasePrompt();
    const continueDirective = this._buildContinueDirective(guidance, directiveAgentId);
    const controllerPromptOverride = basePrompt + '\n\n' + continueDirective;
    this._continueDbg('_runControllerContinue:directive-applied', {
      runId: this._activeManifest.runId,
      lockedAgentId,
      directiveAgentId,
      promptChars: controllerPromptOverride.length,
      promptWasSanitized,
    });

    // Copilot mode: fresh one-shot controller — don't resume any existing session.
    // Save the direct-mode controller session/thread state so it's not lost.
    const savedControllerSessionId = this._activeManifest.controller.sessionId;
    const savedControllerAppServerThreadId = this._activeManifest.controller.appServerThreadId || null;
    const savedControllerThreadSandbox = this._activeManifest.controller.threadSandbox || null;
    const savedControllerApprovalPolicy = this._activeManifest.controller.approvalPolicy || null;
    this._activeManifest.controller.sessionId = null;
    this._activeManifest.controller.appServerThreadId = null;
    this._activeManifest.controller.threadSandbox = null;
    this._activeManifest.controller.approvalPolicy = null;
    this._continueDbg('_runControllerContinue:controller-reset', {
      runId: this._activeManifest.runId,
      savedControllerSessionId,
      savedControllerAppServerThreadId,
      savedControllerThreadSandbox,
      savedControllerApprovalPolicy,
    });

    await this._startAgentDelegateMcp();
    this._syncMcpToManifest();
    this._continueDbg('_runControllerContinue:mcp-ready', {
      runId: this._activeManifest.runId,
      controllerMcpKeys: Object.keys(this._activeManifest.controllerMcpServers || {}),
      workerMcpKeys: Object.keys(this._activeManifest.workerMcpServers || {}),
    });
    const endActivity = this._beginActivity('foreground');
    this._abortController = new AbortController();
    let shouldScheduleLoopContinue = false;
    try {
      const { runManagerLoop } = require('./src/orchestrator');
      // The user message for the controller is always a neutral "decide next step" instruction.
      // User guidance is already in the system prompt via the continue directive.
      const userMessage = guidance
        ? `[CONTROLLER GUIDANCE] ${guidance}`
        : '[AUTO-CONTINUE] Decide the next step based on the conversation transcript.';
      this._continueDbg('_runControllerContinue:runManagerLoop:before', {
        runId: this._activeManifest.runId,
        userMessage,
        singlePass: true,
        lockedAgentId,
      });
      this._activeManifest = await runManagerLoop(this._activeManifest, this._renderer, {
        userMessage,
        abortSignal: this._abortController.signal,
        singlePass: true,
        controllerLabel: 'Continue',
        controllerPromptOverride,
        continueLock: directiveAgentId != null
          ? { agentId: lockedAgentId, chatTarget: this._chatTarget || null }
          : null,
        ...this._workerRunHooks(),
      });
      this._continueDbg('_runControllerContinue:runManagerLoop:after', {
        runId: this._activeManifest && this._activeManifest.runId || null,
        status: this._activeManifest && this._activeManifest.status || null,
        stopReason: this._activeManifest && this._activeManifest.stopReason || null,
        controllerSessionId: this._activeManifest && this._activeManifest.controller && this._activeManifest.controller.sessionId || null,
        controllerAppServerThreadId: this._activeManifest && this._activeManifest.controller && this._activeManifest.controller.appServerThreadId || null,
      });
      this._syncLoopConfigToManifest();
      shouldScheduleLoopContinue = !!(
        this._loopMode &&
        this._activeManifest &&
        this._activeManifest.status === 'running'
      );
    } finally {
      // Restore controller session/thread state after the temporary Continue turn
      if (this._activeManifest && this._activeManifest.controller) {
        this._activeManifest.controller.sessionId = savedControllerSessionId;
        this._activeManifest.controller.appServerThreadId = savedControllerAppServerThreadId;
        this._activeManifest.controller.threadSandbox = savedControllerThreadSandbox;
        this._activeManifest.controller.approvalPolicy = savedControllerApprovalPolicy;
        this._continueDbg('_runControllerContinue:restore-state', {
          runId: this._activeManifest.runId,
          restoredControllerSessionId: savedControllerSessionId,
          restoredControllerAppServerThreadId: savedControllerAppServerThreadId,
          restoredControllerThreadSandbox: savedControllerThreadSandbox,
          restoredControllerApprovalPolicy: savedControllerApprovalPolicy,
        });
      }
      this._abortController = null;
      endActivity();
    }

    await saveManifest(this._activeManifest);
    this._continueDbg('_runControllerContinue:saved', {
      runId: this._activeManifest && this._activeManifest.runId || null,
      status: this._activeManifest && this._activeManifest.status || null,
      shouldScheduleLoopContinue,
    });
    if (shouldScheduleLoopContinue) {
      this._scheduleLoopContinue();
    }
  }

  /** Base copilot prompt — delegates to shared builder in prompts.js */
  _buildCopilotBasePrompt() {
    return buildCopilotBasePrompt({ selfTesting: this._selfTesting, repoRoot: this._repoRoot });
  }

  /** Continue directive — delegates to shared builder in prompts.js */
  _buildContinueDirective(guidance, currentAgentId) {
    return buildContinueDirective(guidance, currentAgentId, {
      loopMode: !!this._loopMode && !guidance,
      loopObjective: this._loopObjective || '',
    });
  }

  /**
   * Schedule the next loop iteration (auto-continue via controller).
   */
  _scheduleLoopContinue() {
    if (!this._loopMode) return;
    this._clearLoopContinueTimer();
    // Small delay to let UI update before next cycle
    this._loopContinueTimer = setTimeout(() => {
      this._loopContinueTimer = null;
      if (!this._loopMode || this._running) return;
      Promise.resolve(this._handleContinue('')).catch(() => {});
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
        await this._createRun(text || '[ORCHESTRATE]');
      }
      this._applyWorkerThinking();

      // Run the direct controller (persistent session, full prompt)
      // Always loop until the controller says STOP — that's the point of Orchestrate
      await this._runLoop({
        userMessage: text || '[ORCHESTRATE] Decide the next step based on the conversation transcript.',
        singlePass: false,
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
    const endActivity = this._beginActivity('foreground');
    this._abortController = new AbortController();

    const delayMs = parseWaitDelay(this._waitDelay);
    const useSinglePass = options.singlePass === false
      ? false
      : Boolean(options.singlePass || delayMs);

    try {
      this._activeManifest = await runManagerLoop(this._activeManifest, this._renderer, {
        ...options,
        singlePass: useSinglePass,
        abortSignal: this._abortController.signal,
        ...this._workerRunHooks(),
      });
      this._syncLoopConfigToManifest();
      if (this._activeManifest.waitDelay !== (this._waitDelay || null)) {
        this._activeManifest.waitDelay = this._waitDelay || null;
      }
      await saveManifest(this._activeManifest);
    } finally {
      this._abortController = null;
      endActivity();
      await this.sendReviewState(true);
    }
  }

  dispose() {
    this._clearLoopContinueTimer();
    this._stopWaitTimer();
    this.abort();
    this._stopAgentDelegateMcp();
    this._closePanelScopedAppServerConnections().catch(() => {});
    this._stopChromeScreencast('dispose');
    try { require('./chrome-manager').releaseChromeReservation(this._panelId); } catch {}
    this._prestartDone = false;
    // Close any persistent interactive Claude sessions
    if (this._activeManifest) {
      try { closeInteractiveSessions(this._activeManifest); } catch {}
    }
  }
}

module.exports = { SessionManager };
