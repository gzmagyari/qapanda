(function () {
  // @ts-ignore — acquireVsCodeApi exists in VSCode webviews; in a browser we shim via WebSocket
  const vscode = (typeof acquireVsCodeApi === 'function')
    ? acquireVsCodeApi()
    : (function () {
        const ws = new WebSocket('ws://' + location.host + '/ws');
        const _ready = new Promise(function (r) { ws.addEventListener('open', r); });
        function _stateKey() {
          try {
            var url = new URL(location.href);
            var params = Array.from(new URLSearchParams(url.search || '').entries())
              .sort(function (a, b) {
                if (a[0] === b[0]) return String(a[1]).localeCompare(String(b[1]));
                return String(a[0]).localeCompare(String(b[0]));
              })
              .map(function (entry) {
                return encodeURIComponent(entry[0]) + '=' + encodeURIComponent(entry[1]);
              })
              .join('&');
            return 'qapanda_state:' + (url.pathname || '/') + (params ? ('?' + params) : '');
          } catch (_) {
            return 'qapanda_state:' + (location.pathname || '/') + (location.search || '');
          }
        }
        const _SK = _stateKey();
        ws.addEventListener('message', function (e) {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === '_reload') { location.reload(); return; }
            window.dispatchEvent(new MessageEvent('message', { data: msg }));
          } catch (_) {}
        });
        return {
          postMessage: function (msg) { _ready.then(function () { ws.send(JSON.stringify(msg)); }); },
          getState: function () { try { return JSON.parse(localStorage.getItem(_SK)); } catch (_) { return undefined; } },
          setState: function (s) { localStorage.setItem(_SK, JSON.stringify(s)); },
        };
      })();

  // Debug logging — sends to extension host which writes to .qpanda/wizard-debug.log
  function _dbg(text) { try { vscode.postMessage({ type: '_debugLog', text: String(text) }); } catch {} }

  const appEl = document.getElementById('app');
  const messagesEl = document.getElementById('messages');
  const textarea = document.getElementById('user-input');
  const btnSend = document.getElementById('btn-send');
  const btnContinue = document.getElementById('btn-continue');
  const reviewSplit = document.getElementById('review-split');
  const btnReview = document.getElementById('btn-review');
  const btnReviewMenu = document.getElementById('btn-review-menu');
  const reviewMenu = document.getElementById('review-menu');
  const btnOrchestrate = document.getElementById('btn-orchestrate');
  const btnStop = document.getElementById('btn-stop');
  const loopToggle = document.getElementById('loop-toggle');
  const loopObjectiveWrap = document.getElementById('loop-objective-wrap');
  const loopObjectiveInput = document.getElementById('loop-objective');
  const progressBubble = document.getElementById('progress-bubble');
  const progressBody = progressBubble ? progressBubble.querySelector('.progress-body') : null;
  const fatalRecoveryEl = document.getElementById('fatal-recovery');
  const fatalRecoveryDetailEl = document.getElementById('fatal-recovery-detail');
  const fatalRecoveryReloadBtn = document.getElementById('fatal-recovery-reload');
  let fatalRecoveryShown = false;
  let initConfigReceived = false;
  let readyRetryCount = 0;
  let readyRetryTimer = null;
  const readySessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `ready-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function formatFatalDetail(kind, errorLike) {
    const prefix = `Fatal ${kind}`;
    if (!errorLike) return prefix;
    if (errorLike instanceof Error) {
      return `${prefix}\n${errorLike.stack || errorLike.message}`;
    }
    if (typeof errorLike === 'string') {
      return `${prefix}\n${errorLike}`;
    }
    if (errorLike && typeof errorLike === 'object') {
      try {
        if (errorLike.stack || errorLike.message) {
          return `${prefix}\n${errorLike.stack || errorLike.message}`;
        }
        return `${prefix}\n${JSON.stringify(errorLike, null, 2)}`;
      } catch {}
    }
    return `${prefix}\n${String(errorLike)}`;
  }

  function showFatalRecovery(kind, errorLike) {
    if (fatalRecoveryShown) return;
    fatalRecoveryShown = true;
    const detail = formatFatalDetail(kind, errorLike);
    _dbg('FATAL WEBVIEW ERROR: ' + detail.replace(/\s+/g, ' ').slice(0, 800));
    if (fatalRecoveryDetailEl) fatalRecoveryDetailEl.textContent = detail;
    if (appEl) appEl.classList.add('app-fatal');
    if (fatalRecoveryEl) fatalRecoveryEl.classList.add('visible');
  }

  if (fatalRecoveryReloadBtn) {
    fatalRecoveryReloadBtn.addEventListener('click', () => {
      try { location.reload(); } catch (error) { _dbg('fatal reload failed: ' + (error && error.message || error)); }
    });
  }

  window.onerror = function (message, source, lineno, colno, error) {
    showFatalRecovery('window.onerror', error || `${message || 'Unknown error'} @ ${source || 'unknown'}:${lineno || 0}:${colno || 0}`);
    return false;
  };
  window.addEventListener('error', (event) => {
    if (!event) return;
    showFatalRecovery('error', event.error || event.message || event);
  });
  window.addEventListener('unhandledrejection', (event) => {
    showFatalRecovery('unhandledrejection', event && 'reason' in event ? event.reason : event);
  });

  function safeInsertBefore(parent, node, nextSibling) {
    if (!parent || !node) return;
    if (nextSibling && nextSibling.parentNode === parent) {
      parent.insertBefore(node, nextSibling);
      return;
    }
    parent.appendChild(node);
  }

  function resolveSectionParent(section) {
    return (section && section.parentNode && section.parentNode.nodeType === 1) ? section.parentNode : messagesEl;
  }


  // ── Tab switching ───────────────────────────────────────────────────
  const tabBar = document.getElementById('tab-bar');
  const cloudEntryScreen = document.getElementById('cloud-entry-screen');
  const cloudEntryLogin = document.getElementById('cloud-entry-login');
  const cloudEntryGuest = document.getElementById('cloud-entry-guest');
  const tabPanels = {
    agent: document.getElementById('tab-agent'),
    tasks: document.getElementById('tab-tasks'),
    tests: document.getElementById('tab-tests'),
    appinfo: document.getElementById('tab-appinfo'),
    memory: document.getElementById('tab-memory'),
    agents: document.getElementById('tab-agents'),
    mcp: document.getElementById('tab-mcp'),
    instances: document.getElementById('tab-instances'),
    computer: document.getElementById('tab-computer'),
    browser: document.getElementById('tab-browser'),
    settings: document.getElementById('tab-settings'),
  };

  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    _dbg('TAB click: ' + tab);
    tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    for (const [key, el] of Object.entries(tabPanels)) {
      if (key === tab) el.classList.remove('tab-hidden');
      else el.classList.add('tab-hidden');
    }
    if (tab === 'tasks') {
      _dbg('TAB postMessage: tasksLoad');
      vscode.postMessage({ type: 'tasksLoad' });
    }
    if (tab === 'tests') {
      _dbg('TAB postMessage: testsLoad');
      vscode.postMessage({ type: 'testsLoad' });
    }
    if (tab === 'appinfo') vscode.postMessage({ type: 'appInfoLoad' });
    if (tab === 'memory') vscode.postMessage({ type: 'memoryLoad' });
    if (tab === 'agents') vscode.postMessage({ type: 'agentsLoad' });
    if (tab === 'instances') {
      instancesActionId++;
      setInstancesLoading(true);
      vscode.postMessage({ type: 'instancesLoad', _actionId: instancesActionId });
    }
    if (tab === 'settings') vscode.postMessage({ type: 'settingsLoad' });
    if (tab === 'browser') {
      _dbg(`TAB browser click: chromePort=${chromePort || 'null'} url=${(document.getElementById('browser-url') && document.getElementById('browser-url').value) || ''}`);
      if (!chromePort) {
        const ph = document.getElementById('browser-placeholder');
        if (ph) {
          ph.innerHTML = '<div class="browser-loading"><div class="browser-loading-spinner"></div><p>Starting Chrome\u2026</p></div>';
          ph.style.display = '';
        }
        // Hide nav bar and frame while loading
        hideBrowserNav();
        const fr = document.getElementById('browser-chrome-frame');
        if (fr) fr.style.display = 'none';
      }
      vscode.postMessage({ type: 'browserStart' });
    }
    renderCloudEntryScreen();
  });

  // ── Settings tab ────────────────────────────────────────────────────
  const selfTestToggle = document.getElementById('setting-self-testing');
  const lazyMcpToolsToggle = document.getElementById('setting-lazy-mcp-tools');
  const learnedApiToolsToggle = document.getElementById('setting-learned-api-tools');
  const learnedToolsManageBtn = document.getElementById('settings-learned-tools-manage');
  const learnedToolsModal = document.getElementById('learned-tools-modal');
  const learnedToolsModalClose = document.getElementById('learned-tools-modal-close');
  const learnedToolsFilter = document.getElementById('learned-tools-filter');
  const learnedToolsSort = document.getElementById('learned-tools-sort');
  const learnedToolsClearExpired = document.getElementById('learned-tools-clear-expired');
  const learnedToolsEmpty = document.getElementById('learned-tools-empty');
  const learnedToolsList = document.getElementById('learned-tools-list');
  const settingsPromptsSection = document.getElementById('settings-prompts-section');
  const settingPromptQaBrowser = document.getElementById('setting-prompt-qa-browser');
  const settingPromptController = document.getElementById('setting-prompt-controller');
  const settingPromptAgent = document.getElementById('setting-prompt-agent');
  const settingsPromptsSave = document.getElementById('settings-prompts-save');
  const settingsPromptsReset = document.getElementById('settings-prompts-reset');
  const customProviderList = document.getElementById('custom-provider-list');
  const customProviderAdd = document.getElementById('custom-provider-add');
  const customProviderSave = document.getElementById('custom-provider-save');
  const customProviderStatus = document.getElementById('custom-provider-status');
  const cloudAccountSection = document.getElementById('cloud-account-section');
  const cloudAccountState = document.getElementById('cloud-account-state');
  const cloudAccountDesc = document.getElementById('cloud-account-desc');
  const cloudAccountWorkspace = document.getElementById('cloud-account-workspace');
  const cloudAccountWorkspaceSelect = document.getElementById('cloud-account-workspace-select');
  const cloudAccountWorkspaceSwitch = document.getElementById('cloud-account-workspace-switch');
  const cloudAccountSession = document.getElementById('cloud-account-session');
  const cloudAccountMeta = document.getElementById('cloud-account-meta');
  const cloudAccountStatus = document.getElementById('cloud-account-status');
  const cloudSyncState = document.getElementById('cloud-sync-state');
  const cloudSyncMeta = document.getElementById('cloud-sync-meta');
  const cloudRepositoryState = document.getElementById('cloud-repository-state');
  const cloudRepositoryMeta = document.getElementById('cloud-repository-meta');
  const cloudContextState = document.getElementById('cloud-context-state');
  const cloudContextMeta = document.getElementById('cloud-context-meta');
  const cloudContextMode = document.getElementById('cloud-context-mode');
  const cloudContextKey = document.getElementById('cloud-context-key');
  const cloudContextLabel = document.getElementById('cloud-context-label');
  const cloudContextSave = document.getElementById('cloud-context-save');
    const cloudContextCreate = document.getElementById('cloud-context-create');
    const cloudContextOpen = document.getElementById('cloud-context-open');
    const cloudObjectsState = document.getElementById('cloud-objects-state');
    const cloudObjectsMeta = document.getElementById('cloud-objects-meta');
    const cloudObjectsList = document.getElementById('cloud-objects-list');
    const cloudConflictState = document.getElementById('cloud-conflict-state');
    const cloudConflictList = document.getElementById('cloud-conflict-list');
    const cloudConflictsRefresh = document.getElementById('cloud-conflicts-refresh');
  const cloudNotificationState = document.getElementById('cloud-notification-state');
  const cloudNotificationMeta = document.getElementById('cloud-notification-meta');
  const cloudAccountLogin = document.getElementById('cloud-account-login');
  const cloudAccountRefresh = document.getElementById('cloud-account-refresh');
  const cloudAccountOpenApp = document.getElementById('cloud-account-open-app');
  const cloudAccountOpenNotifications = document.getElementById('cloud-account-open-notifications');
  const cloudAccountLogout = document.getElementById('cloud-account-logout');
  const appInfoText = document.getElementById('app-info-text');
  const appInfoEnabled = document.getElementById('app-info-enabled');
  const BUILTIN_API_PROVIDER_IDS = ['openai', 'anthropic', 'openrouter', 'gemini'];
  const appInfoSave = document.getElementById('app-info-save');
  const appInfoStatus = document.getElementById('app-info-status');
  const memoryText = document.getElementById('memory-text');
  const memoryEnabled = document.getElementById('memory-enabled');
  const memorySave = document.getElementById('memory-save');
  const memoryStatus = document.getElementById('memory-status');
  let cloudBootstrap = null;
  let cloudSessionState = null;
  let cloudStatusState = null;
  let cloudPendingAction = '';
  let cloudNoticeText = '';
  let cloudContextDraft = { mode: 'shared', explicitContextKey: '', contextLabel: '' };
  let guestModeDismissed = false;
  let learnedApiToolEntries = [];

  const promptsExpander = document.getElementById('settings-prompts-expander');
  const promptsContent = document.getElementById('settings-prompts-content');
  if (promptsExpander) {
    promptsExpander.addEventListener('click', () => {
      promptsExpander.classList.toggle('expanded');
      if (promptsContent) promptsContent.classList.toggle('expanded');
    });
  }

  function updatePromptsVisibility() {
    if (settingsPromptsSection) {
      if (selfTestToggle && selfTestToggle.checked) {
        settingsPromptsSection.classList.remove('settings-prompts-hidden');
      } else {
        settingsPromptsSection.classList.add('settings-prompts-hidden');
      }
    }
  }

  function formatLearnedToolTimestamp(value) {
    if (!value) return 'Never';
    try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
  }

  function isLearnedToolExpired(entry) {
    if (!entry || entry.pinned || !entry.expiresAt) return false;
    const time = Date.parse(entry.expiresAt);
    return Number.isFinite(time) && time <= Date.now();
  }

  function sortLearnedTools(entries) {
    const mode = learnedToolsSort && learnedToolsSort.value ? learnedToolsSort.value : 'recent';
    const list = Array.isArray(entries) ? [...entries] : [];
    return list.sort((left, right) => {
      if (!!right.pinned !== !!left.pinned) return Number(right.pinned) - Number(left.pinned);
      if (mode === 'name') {
        if (String(left.agentId || '') !== String(right.agentId || '')) {
          return String(left.agentId || '').localeCompare(String(right.agentId || ''));
        }
        return String(left.toolName || '').localeCompare(String(right.toolName || ''));
      }
      if (mode === 'expires') {
        const leftExpires = left && left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
        const rightExpires = right && right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
        if (leftExpires !== rightExpires) return leftExpires - rightExpires;
      }
      const leftLastUsed = left && left.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
      const rightLastUsed = right && right.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
      if (rightLastUsed !== leftLastUsed) return rightLastUsed - leftLastUsed;
      return String(left.toolName || '').localeCompare(String(right.toolName || ''));
    });
  }

  function filteredLearnedTools() {
    const query = String(learnedToolsFilter && learnedToolsFilter.value || '').trim().toLowerCase();
    const filtered = !query
      ? learnedApiToolEntries
      : learnedApiToolEntries.filter((entry) =>
          String(entry.agentId || '').toLowerCase().includes(query) ||
          String(entry.toolName || '').toLowerCase().includes(query)
        );
    return sortLearnedTools(filtered);
  }

  function renderLearnedToolsModal() {
    if (!learnedToolsList || !learnedToolsEmpty) return;
    const entries = filteredLearnedTools();
    learnedToolsList.innerHTML = '';
    learnedToolsEmpty.style.display = entries.length > 0 ? 'none' : '';
    learnedToolsList.style.display = entries.length > 0 ? '' : 'none';
    if (entries.length === 0) return;

    const byAgent = new Map();
    entries.forEach((entry) => {
      const key = String(entry.agentId || 'default');
      if (!byAgent.has(key)) byAgent.set(key, []);
      byAgent.get(key).push(entry);
    });

    Array.from(byAgent.entries()).forEach(([agentId, agentEntries]) => {
      const section = document.createElement('div');
      section.className = 'learned-tools-group';

      const header = document.createElement('div');
      header.className = 'learned-tools-group-header';
      header.textContent = agentId;
      section.appendChild(header);

      agentEntries.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'learned-tools-row';
        if (isLearnedToolExpired(entry)) row.classList.add('expired');

        const info = document.createElement('div');
        info.className = 'learned-tools-row-info';

        const title = document.createElement('div');
        title.className = 'learned-tools-row-title';
        title.textContent = entry.toolName || '';
        info.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'learned-tools-row-meta';
        const expiryText = entry.pinned
          ? 'Pinned'
          : (entry.expiresAt ? `Expires ${formatLearnedToolTimestamp(entry.expiresAt)}` : 'No expiry');
        meta.textContent = `Uses ${entry.useCount || 0} | Last used ${formatLearnedToolTimestamp(entry.lastUsedAt)} | ${expiryText}`;
        info.appendChild(meta);
        row.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'learned-tools-row-actions';

        const pinBtn = document.createElement('button');
        pinBtn.className = 'mcp-btn';
        pinBtn.type = 'button';
        pinBtn.textContent = entry.pinned ? 'Unpin' : 'Pin';
        pinBtn.dataset.action = 'pin';
        pinBtn.dataset.agentId = agentId;
        pinBtn.dataset.toolName = entry.toolName || '';
        pinBtn.dataset.pinned = entry.pinned ? 'false' : 'true';
        actions.appendChild(pinBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'mcp-btn';
        removeBtn.type = 'button';
        removeBtn.textContent = 'Remove';
        removeBtn.dataset.action = 'remove';
        removeBtn.dataset.agentId = agentId;
        removeBtn.dataset.toolName = entry.toolName || '';
        actions.appendChild(removeBtn);

        row.appendChild(actions);
        section.appendChild(row);
      });

      learnedToolsList.appendChild(section);
    });
  }

  function openLearnedToolsModal() {
    if (!learnedToolsModal) return;
    renderLearnedToolsModal();
    learnedToolsModal.style.display = 'flex';
    learnedToolsModal.classList.add('visible');
  }

  function closeLearnedToolsModal() {
    if (!learnedToolsModal) return;
    learnedToolsModal.classList.remove('visible');
    learnedToolsModal.style.display = 'none';
  }

  function formatCloudTime(value) {
    if (!value) return 'Unknown';
    try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
  }

  function setCloudAccountStatus(text) {
    if (cloudAccountStatus) cloudAccountStatus.textContent = text || '';
  }

  function syncCloudContextDraftFromRuntime() {
    const runtime = cloudStatusState && cloudStatusState.sync ? cloudStatusState.sync : null;
    cloudContextDraft = {
      mode: runtime && runtime.contextMode ? runtime.contextMode : 'shared',
      explicitContextKey: runtime && runtime.explicitContextKey ? runtime.explicitContextKey : '',
      contextLabel: runtime && runtime.contextLabel ? runtime.contextLabel : '',
    };
  }

  function isExtensionCloudTarget() {
    const target = cloudBootstrap && cloudBootstrap.target;
    return !target || target === 'extension';
  }

  function getActiveTabKey() {
    const active = tabBar ? tabBar.querySelector('.tab-btn.active') : null;
    return active && active.dataset && active.dataset.tab ? active.dataset.tab : 'agent';
  }

  function shouldShowCloudEntryScreen() {
    return Boolean(
      cloudEntryScreen &&
      getActiveTabKey() === 'agent' &&
      isExtensionCloudTarget() &&
      cloudSessionState &&
      cloudSessionState.loggedIn === false &&
      !guestModeDismissed
    );
  }

  function renderCloudEntryScreen() {
    if (!cloudEntryScreen) return;
    cloudEntryScreen.classList.toggle('visible', shouldShowCloudEntryScreen());
  }

  function summarizeConflictPayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const preferred = ['title', 'name', 'description', 'content', 'value'];
    for (const key of preferred) {
      if (payload[key] != null && String(payload[key]).trim()) {
        return String(payload[key]).trim();
      }
    }
    try {
      const serialized = JSON.stringify(payload);
      return serialized && serialized !== '{}' ? serialized : '';
    } catch (_) {
      return '';
    }
  }

  function renderCloudConflicts(runtime, loggedIn, busy) {
    const conflicts = runtime && Array.isArray(runtime.conflicts) ? runtime.conflicts : [];
    if (cloudConflictState) {
      if (!loggedIn) {
        cloudConflictState.textContent = 'Sign in to inspect and resolve hosted sync conflicts.';
      } else if (conflicts.length === 0) {
        cloudConflictState.textContent = 'No open per-object sync conflicts.';
      } else {
        cloudConflictState.textContent = `${conflicts.length} open conflict${conflicts.length === 1 ? '' : 's'} need an explicit local or cloud decision.`;
      }
    }
    if (cloudConflictsRefresh) {
      cloudConflictsRefresh.disabled = busy || !loggedIn;
    }
    if (!cloudConflictList) return;
    cloudConflictList.innerHTML = '';
    if (!loggedIn || conflicts.length === 0) return;
    conflicts.forEach((conflict) => {
      const card = document.createElement('div');
      card.className = 'cloud-conflict-card';

      const header = document.createElement('div');
      header.className = 'cloud-conflict-header';
      header.textContent = `${conflict.objectType || 'object'}:${conflict.objectId || 'unknown'}`;
      card.appendChild(header);

      const meta = document.createElement('div');
      meta.className = 'cloud-conflict-meta';
      meta.textContent = [
        conflict.conflictCode || 'client_remote_conflict',
        conflict.updatedAt ? `Updated ${formatCloudTime(conflict.updatedAt)}` : null,
      ].filter(Boolean).join(' • ');
      card.appendChild(meta);

      const compare = document.createElement('div');
      compare.className = 'cloud-conflict-compare';

      const local = document.createElement('div');
      local.className = 'cloud-conflict-column';
      local.innerHTML = `<div class="cloud-conflict-label">Local</div><div class="cloud-conflict-value"></div>`;
      local.querySelector('.cloud-conflict-value').textContent = summarizeConflictPayload(conflict.localPayload) || 'No local payload summary';
      compare.appendChild(local);

      const remote = document.createElement('div');
      remote.className = 'cloud-conflict-column';
      remote.innerHTML = `<div class="cloud-conflict-label">Cloud</div><div class="cloud-conflict-value"></div>`;
      remote.querySelector('.cloud-conflict-value').textContent = summarizeConflictPayload(conflict.remotePayload) || 'No cloud payload summary';
      compare.appendChild(remote);

      card.appendChild(compare);

      const actions = document.createElement('div');
      actions.className = 'cloud-conflict-actions-row';

      const useLocal = document.createElement('button');
      useLocal.className = 'mcp-btn';
      useLocal.type = 'button';
      useLocal.textContent = 'Use Local';
      useLocal.disabled = busy;
      useLocal.addEventListener('click', () => {
        cloudPendingAction = 'Resolving conflict with local version...';
        cloudNoticeText = '';
        setCloudAccountStatus(cloudPendingAction);
        renderCloudAccount();
        vscode.postMessage({ type: 'cloudSyncResolveConflict', conflictId: conflict.conflictId, resolution: 'take_local' });
      });
      actions.appendChild(useLocal);

      const useCloud = document.createElement('button');
      useCloud.className = 'mcp-btn';
      useCloud.type = 'button';
      useCloud.textContent = 'Use Cloud';
      useCloud.disabled = busy;
      useCloud.addEventListener('click', () => {
        cloudPendingAction = 'Resolving conflict with cloud version...';
        cloudNoticeText = '';
        setCloudAccountStatus(cloudPendingAction);
        renderCloudAccount();
        vscode.postMessage({ type: 'cloudSyncResolveConflict', conflictId: conflict.conflictId, resolution: 'take_remote' });
      });
      actions.appendChild(useCloud);

      card.appendChild(actions);
      cloudConflictList.appendChild(card);
    });
  }

  function renderCloudWorkspacePicker(loggedIn, busy, memberships, workspace, session) {
    if (!cloudAccountWorkspaceSelect) return;
    const selectedWorkspaceId = workspace && workspace.workspaceId
      ? workspace.workspaceId
      : (session && session.workspaceId ? session.workspaceId : '');
    const options = loggedIn && Array.isArray(memberships) ? memberships : [];
    cloudAccountWorkspaceSelect.innerHTML = '';

    if (!loggedIn || options.length === 0) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'No hosted workspace available';
      cloudAccountWorkspaceSelect.appendChild(placeholder);
      cloudAccountWorkspaceSelect.value = '';
      cloudAccountWorkspaceSelect.disabled = true;
      if (cloudAccountWorkspaceSwitch) cloudAccountWorkspaceSwitch.disabled = true;
      return;
    }

    options.forEach((membership) => {
      const option = document.createElement('option');
      option.value = membership.workspaceId || '';
      option.textContent = `${membership.name || membership.slug || membership.workspaceId} (${membership.roleKey || 'member'})`;
      cloudAccountWorkspaceSelect.appendChild(option);
    });

    if (selectedWorkspaceId) {
      cloudAccountWorkspaceSelect.value = selectedWorkspaceId;
    }
    if (!cloudAccountWorkspaceSelect.value && cloudAccountWorkspaceSelect.options.length > 0) {
      cloudAccountWorkspaceSelect.selectedIndex = 0;
    }

    const canSwitch = options.length > 1;
    cloudAccountWorkspaceSelect.disabled = busy || !canSwitch;
    if (cloudAccountWorkspaceSwitch) {
      cloudAccountWorkspaceSwitch.disabled = busy
        || !canSwitch
        || !cloudAccountWorkspaceSelect.value
        || cloudAccountWorkspaceSelect.value === selectedWorkspaceId;
    }
  }

  function renderCloudRepositoryIdentity(loggedIn, repository) {
    if (cloudRepositoryState) {
      if (!loggedIn) {
        cloudRepositoryState.textContent = 'Sign in to inspect the connected-project identity for this checkout.';
      } else if (!repository) {
        cloudRepositoryState.textContent = 'Connected-project identity will appear here after the extension loads cloud sync status.';
      } else if (repository.kind === 'path_fallback') {
        cloudRepositoryState.textContent = `Using a local path fallback for ${repository.displayName || 'this checkout'} until this connected project has a shared remote.`;
      } else {
        cloudRepositoryState.textContent = `Hosted sync resolves this checkout to the connected project ${repository.displayName || 'for this workspace'} across machines.`;
      }
    }
    if (cloudRepositoryMeta) {
      const details = [];
      if (repository && repository.canonicalRemoteUrl) {
        details.push(`Canonical remote ${repository.canonicalRemoteUrl}`);
      } else if (repository && repository.kind === 'path_fallback') {
        details.push('Canonical remote local path fallback');
      }
      if (repository && repository.repositoryKey) details.push(`Project key ${repository.repositoryKey}`);
      if (repository && repository.contextKey) details.push(`Context ${repository.contextKey}`);
      if (repository && repository.instanceKey) details.push(`Instance ${repository.instanceKey}`);
      cloudRepositoryMeta.textContent = details.join('\n');
    }
  }

  function renderCloudObjects(loggedIn, runtime) {
    const counts = runtime && runtime.objectCounts ? runtime.objectCounts : { tests: 0, issues: 0, recipes: 0 };
    const recentObjects = runtime && Array.isArray(runtime.recentObjects) ? runtime.recentObjects : [];
    const total = Number(counts.tests || 0) + Number(counts.issues || 0) + Number(counts.recipes || 0);
    if (cloudObjectsState) {
      if (!loggedIn) {
        cloudObjectsState.textContent = 'Sign in to inspect synced tests, issues, and recipes for this checkout.';
      } else if (!runtime) {
        cloudObjectsState.textContent = 'Checking connected-project sync objects...';
      } else if (total === 0) {
        cloudObjectsState.textContent = 'No synced tests, issues, or recipes yet.';
      } else {
        cloudObjectsState.textContent = `${counts.tests || 0} tests, ${counts.issues || 0} issues, and ${counts.recipes || 0} recipes are currently mirrored for this connected-project context.`;
      }
    }
    if (cloudObjectsMeta) {
      const details = [];
      if (runtime && runtime.binding && runtime.binding.repositoryContextId) details.push(`Hosted context ${runtime.binding.repositoryContextId}`);
      if (runtime && Number.isFinite(runtime.pendingMutationCount)) details.push(`Pending local changes ${runtime.pendingMutationCount}`);
      cloudObjectsMeta.textContent = details.join('\n');
    }
    if (!cloudObjectsList) return;
    cloudObjectsList.innerHTML = '';
    if (!loggedIn || !recentObjects.length) return;
    recentObjects.forEach((object) => {
      const card = document.createElement('div');
      card.className = 'cloud-conflict-card';
      const header = document.createElement('div');
      header.className = 'cloud-conflict-header';
      header.textContent = `${object.objectType || 'object'}:${object.objectId || 'unknown'}`;
      card.appendChild(header);

      const meta = document.createElement('div');
      meta.className = 'cloud-conflict-meta';
      meta.textContent = object.updatedAt ? `Updated ${formatCloudTime(object.updatedAt)}` : 'Waiting for synced timestamp';
      card.appendChild(meta);

      const body = document.createElement('div');
      body.className = 'cloud-conflict-column';
      body.innerHTML = `<div class="cloud-conflict-label">Title</div><div class="cloud-conflict-value"></div>`;
      body.querySelector('.cloud-conflict-value').textContent = object.title || object.objectId || 'Untitled object';
      card.appendChild(body);

      cloudObjectsList.appendChild(card);
    });
  }

  function renderCloudAccount() {
    const target = cloudBootstrap && cloudBootstrap.target;
    const isExtension = !target || target === 'extension';
    if (cloudAccountSection) cloudAccountSection.style.display = isExtension ? '' : 'none';
    if (!isExtension) return;

    const state = cloudSessionState;
    const loggedIn = !!(state && state.loggedIn);
    const busy = !!cloudPendingAction;
    const authMode = state && state.authMode ? state.authMode : (cloudBootstrap && cloudBootstrap.auth && cloudBootstrap.auth.authMode) || 'disabled';
    const actor = state && state.actor;
    const memberships = state && Array.isArray(state.memberships) ? state.memberships : [];
    const workspace = state && state.workspace;
    const session = state && state.session;
    const runtime = cloudStatusState && cloudStatusState.sync ? cloudStatusState.sync : null;
    const repository = runtime && runtime.repository ? runtime.repository : null;
    const notifications = cloudStatusState && cloudStatusState.notifications ? cloudStatusState.notifications : null;
    const unreadCount = notifications ? Number(notifications.unreadCount || 0) : 0;

    if (cloudAccountState) {
      if (loggedIn) {
        const primary = actor && actor.email ? actor.email : 'Signed in';
        cloudAccountState.textContent = actor && actor.displayName ? `${primary} (${actor.displayName})` : primary;
      } else {
        cloudAccountState.textContent = 'Signed out';
      }
    }

    if (cloudAccountDesc) {
      cloudAccountDesc.textContent = loggedIn && workspace
        ? `Workspace role: ${workspace.roleKey || 'member'} • Plan: ${workspace.planTier || 'unknown'}`
        : 'Sign in to QA Panda Cloud to use hosted sessions from the extension.';
    }

    if (cloudAccountWorkspace) {
      cloudAccountWorkspace.textContent = loggedIn && workspace
        ? `${workspace.name} (${workspace.slug})`
        : 'No hosted workspace is currently linked.';
    }
    renderCloudWorkspacePicker(loggedIn, busy, memberships, workspace, session);

    if (cloudAccountSession) {
      const parts = [];
      if (state && state.storageMode) parts.push(`Storage: ${state.storageMode}`);
      if (authMode) parts.push(`Auth: ${authMode === 'disabled' ? 'pkce (extension default)' : authMode}`);
      if (session && session.updatedAt) parts.push(`Updated: ${formatCloudTime(session.updatedAt)}`);
      cloudAccountSession.textContent = parts.join(' • ') || 'Auth state will appear here after the extension loads cloud status.';
    }

    if (cloudAccountMeta) {
      const meta = [];
      if (workspace && workspace.planTier) meta.push(`Plan ${workspace.planTier}`);
      if (state && state.refreshed) meta.push('Session refreshed');
      if (busy) meta.push(cloudPendingAction);
      cloudAccountMeta.textContent = meta.join('\n');
    }

    if (cloudSyncState) {
      if (!loggedIn) {
        cloudSyncState.textContent = 'Sign in to start connected-project sync for this workspace.';
      } else if (runtime) {
        const detail = runtime.badge && runtime.badge.detail ? runtime.badge.detail : runtime.indicator && runtime.indicator.detail;
        cloudSyncState.textContent = `${runtime.badge ? runtime.badge.label : 'Sync'}${detail ? ` — ${detail}` : ''}`;
      } else {
        cloudSyncState.textContent = 'Preparing connected-project sync for this workspace.';
      }
    }

    if (cloudSyncMeta) {
      const syncMeta = [];
      if (runtime && runtime.contextMode) syncMeta.push(`Context ${runtime.contextMode}${runtime.contextLabel ? ` (${runtime.contextLabel})` : ''}`);
      if (runtime && Number.isFinite(runtime.pendingMutationCount)) syncMeta.push(`Pending ${runtime.pendingMutationCount}`);
      if (runtime && runtime.openConflictCount > 0) syncMeta.push(`Conflicts ${runtime.openConflictCount}`);
      if (runtime && runtime.lastSyncedAt) syncMeta.push(`Last sync ${formatCloudTime(runtime.lastSyncedAt)}`);
      cloudSyncMeta.textContent = syncMeta.join('\n');
    }

      renderCloudRepositoryIdentity(loggedIn, repository);
      renderCloudContext(loggedIn, busy, runtime, repository);
      renderCloudObjects(loggedIn, runtime);

      renderCloudConflicts(runtime, loggedIn, busy);

    if (cloudNotificationState) {
      if (!loggedIn) {
        cloudNotificationState.textContent = 'Unread hosted notifications appear here after sign-in.';
      } else if (notifications) {
        cloudNotificationState.textContent = unreadCount > 0
          ? `${unreadCount} unread hosted notification${unreadCount === 1 ? '' : 's'}`
          : 'No unread hosted notifications';
      } else {
        cloudNotificationState.textContent = 'Checking hosted notifications...';
      }
    }

    if (cloudNotificationMeta) {
      const notificationMeta = [];
      if (notifications && notifications.summary && Array.isArray(notifications.summary.latest) && notifications.summary.latest.length > 0) {
        const latest = notifications.summary.latest[0];
        if (latest && latest.title) notificationMeta.push(latest.title);
      }
      if (notifications && notifications.error) notificationMeta.push(`Error: ${notifications.error}`);
      cloudNotificationMeta.textContent = notificationMeta.join('\n');
    }

    if (!busy && cloudNoticeText) {
      setCloudAccountStatus(cloudNoticeText);
    } else if (!busy && runtime && runtime.lastError) {
      setCloudAccountStatus(runtime.lastError);
    } else if (!busy && notifications && notifications.error) {
      setCloudAccountStatus(notifications.error);
    } else if (!busy && state && state.error) {
      setCloudAccountStatus(state.error);
    } else if (!busy && !loggedIn) {
      setCloudAccountStatus('VS Code SecretStorage keeps the hosted session outside your repo files.');
    }

    if (cloudAccountLogin) cloudAccountLogin.disabled = busy || loggedIn;
    if (cloudAccountRefresh) cloudAccountRefresh.disabled = busy;
    if (cloudAccountOpenApp) cloudAccountOpenApp.disabled = busy;
    if (cloudAccountOpenNotifications) {
      cloudAccountOpenNotifications.disabled = busy;
      cloudAccountOpenNotifications.textContent = unreadCount > 0 ? `Notifications (${unreadCount})` : 'Notifications';
    }
    if (cloudAccountLogout) cloudAccountLogout.disabled = busy || !loggedIn;
  }

  function renderCloudContext(loggedIn, busy, runtime, repository) {
    const contextMode = cloudContextDraft.mode || (runtime && runtime.contextMode) || 'shared';
    const explicitContextKey = cloudContextDraft.explicitContextKey || '';
    const contextLabel = cloudContextDraft.contextLabel || '';
    const binding = runtime && runtime.binding ? runtime.binding : null;
    const hasRegistration = !!(binding && binding.repositoryId);
    if (cloudContextMode) cloudContextMode.value = contextMode;
    if (cloudContextKey) {
      cloudContextKey.value = explicitContextKey;
      cloudContextKey.disabled = busy || !loggedIn || contextMode !== 'custom';
    }
    if (cloudContextLabel) {
      cloudContextLabel.value = contextLabel;
      cloudContextLabel.disabled = busy || !loggedIn;
    }
    if (cloudContextState) {
      if (!loggedIn) {
        cloudContextState.textContent = 'Sign in to save a shared, branch, worktree, or named override context for this checkout.';
      } else if (contextMode === 'custom' && explicitContextKey) {
        cloudContextState.textContent = `This checkout uses the named override context ${explicitContextKey}.`;
      } else if (contextMode === 'branch') {
        cloudContextState.textContent = 'This checkout separates synced objects by git branch.';
      } else if (contextMode === 'worktree') {
        cloudContextState.textContent = 'This checkout keeps a separate context per worktree path.';
      } else {
        cloudContextState.textContent = 'This checkout shares synced objects with the default connected-project context.';
      }
    }
    if (cloudContextMeta) {
      const details = [];
      if (repository && repository.contextKey) details.push(`Resolved ${repository.contextKey}`);
      if (runtime && runtime.contextLabel) details.push(`Label ${runtime.contextLabel}`);
      if (binding && binding.repositoryContextId) details.push(`Hosted context ${binding.repositoryContextId}`);
      if (!repository || repository.kind === 'path_fallback') {
        details.push('No shared remote yet. This checkout still works, but hosted matching uses the local path fallback until you add a shared remote.');
      }
      cloudContextMeta.textContent = details.join('\n');
    }
    if (cloudContextMode) cloudContextMode.disabled = busy || !loggedIn;
    if (cloudContextSave) cloudContextSave.disabled = busy || !loggedIn || (contextMode === 'custom' && !String(explicitContextKey).trim());
    if (cloudContextCreate) cloudContextCreate.disabled = busy || !loggedIn || !String(cloudContextKey && cloudContextKey.value || explicitContextKey).trim();
    if (cloudContextOpen) cloudContextOpen.disabled = busy || !loggedIn || !hasRegistration;
  }

  if (selfTestToggle) {
    selfTestToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'settingsSave', settings: { selfTesting: selfTestToggle.checked } });
      updatePromptsVisibility();
    });
  }
  if (lazyMcpToolsToggle) {
    lazyMcpToolsToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'settingsSave', settings: { lazyMcpToolsEnabled: lazyMcpToolsToggle.checked } });
    });
  }
  if (learnedApiToolsToggle) {
    learnedApiToolsToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'settingsSave', settings: { learnedApiToolsEnabled: learnedApiToolsToggle.checked } });
    });
  }
  if (learnedToolsManageBtn) {
    learnedToolsManageBtn.addEventListener('click', () => {
      openLearnedToolsModal();
    });
  }
  if (learnedToolsModalClose) {
    learnedToolsModalClose.addEventListener('click', () => {
      closeLearnedToolsModal();
    });
  }
  if (learnedToolsModal) {
    learnedToolsModal.addEventListener('click', (event) => {
      if (event.target && event.target.classList && event.target.classList.contains('learned-tools-modal-backdrop')) {
        closeLearnedToolsModal();
      }
    });
  }
  if (learnedToolsFilter) {
    learnedToolsFilter.addEventListener('input', () => {
      renderLearnedToolsModal();
    });
  }
  if (learnedToolsSort) {
    learnedToolsSort.addEventListener('change', () => {
      renderLearnedToolsModal();
    });
  }
  if (learnedToolsClearExpired) {
    learnedToolsClearExpired.addEventListener('click', () => {
      vscode.postMessage({ type: 'settingsLearnedToolsClearExpired' });
    });
  }
  if (learnedToolsList) {
    learnedToolsList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const agentId = button.dataset.agentId || '';
      const toolName = button.dataset.toolName || '';
      if (!agentId || !toolName) return;
      if (button.dataset.action === 'remove') {
        vscode.postMessage({ type: 'settingsLearnedToolRemove', agentId, toolName });
        return;
      }
      if (button.dataset.action === 'pin') {
        vscode.postMessage({
          type: 'settingsLearnedToolPin',
          agentId,
          toolName,
          pinned: button.dataset.pinned === 'true',
        });
      }
    });
  }
  if (settingsPromptsSave) {
    settingsPromptsSave.addEventListener('click', () => {
      vscode.postMessage({ type: 'settingsSave', settings: {
        selfTestPromptController: settingPromptController ? settingPromptController.value : '',
        selfTestPromptQaBrowser: settingPromptQaBrowser ? settingPromptQaBrowser.value : '',
        selfTestPromptAgent: settingPromptAgent ? settingPromptAgent.value : '',
      }});
    });
  }
  if (settingsPromptsReset) {
    settingsPromptsReset.addEventListener('click', () => {
      vscode.postMessage({ type: 'settingsSave', settings: {
        selfTestPromptController: '',
        selfTestPromptQaBrowser: '',
        selfTestPromptAgent: '',
      }});
      // Request fresh data to repopulate with defaults
      vscode.postMessage({ type: 'settingsLoad' });
    });
  }

  if (cloudAccountLogin) {
    cloudAccountLogin.addEventListener('click', () => {
      cloudPendingAction = 'Opening browser login...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSessionLogin' });
    });
  }
  if (cloudAccountLogout) {
    cloudAccountLogout.addEventListener('click', () => {
      cloudPendingAction = 'Signing out...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSessionLogout' });
    });
  }
  if (cloudAccountRefresh) {
    cloudAccountRefresh.addEventListener('click', () => {
      cloudPendingAction = 'Refreshing hosted account...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSessionRefresh' });
    });
  }
  if (cloudAccountWorkspaceSelect) {
    cloudAccountWorkspaceSelect.addEventListener('change', () => {
      const currentWorkspaceId = cloudSessionState && cloudSessionState.workspace
        ? cloudSessionState.workspace.workspaceId
        : (cloudSessionState && cloudSessionState.session ? cloudSessionState.session.workspaceId : '');
      if (cloudAccountWorkspaceSwitch) {
        cloudAccountWorkspaceSwitch.disabled = !cloudAccountWorkspaceSelect.value
          || cloudAccountWorkspaceSelect.value === currentWorkspaceId
          || !!cloudPendingAction;
      }
    });
  }
  if (cloudAccountWorkspaceSwitch) {
    cloudAccountWorkspaceSwitch.addEventListener('click', () => {
      const workspaceId = cloudAccountWorkspaceSelect ? cloudAccountWorkspaceSelect.value : '';
      if (!workspaceId) return;
      cloudPendingAction = 'Switching hosted workspace...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSessionSwitchWorkspace', workspaceId });
    });
  }
  if (cloudContextMode) {
    cloudContextMode.addEventListener('change', () => {
      cloudContextDraft.mode = cloudContextMode.value || 'shared';
      const isCustom = cloudContextDraft.mode === 'custom';
      if (cloudContextKey) cloudContextKey.disabled = !isCustom || !!cloudPendingAction;
      renderCloudAccount();
    });
  }
  if (cloudContextKey) {
    cloudContextKey.addEventListener('input', () => {
      cloudContextDraft.explicitContextKey = cloudContextKey.value || '';
      renderCloudAccount();
    });
  }
  if (cloudContextLabel) {
    cloudContextLabel.addEventListener('input', () => {
      cloudContextDraft.contextLabel = cloudContextLabel.value || '';
    });
  }
  if (cloudContextSave) {
    cloudContextSave.addEventListener('click', () => {
      const contextModeValue = cloudContextDraft.mode || 'shared';
      const explicitContextKey = String(cloudContextDraft.explicitContextKey || '').trim();
      const contextLabelValue = String(cloudContextDraft.contextLabel || '').trim();
      cloudPendingAction = 'Saving connected-project context...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({
        type: 'cloudContextSave',
        contextMode: contextModeValue,
        explicitContextKey,
        contextLabel: contextLabelValue,
      });
    });
  }
  if (cloudContextCreate) {
    cloudContextCreate.addEventListener('click', () => {
      const explicitContextKey = String(cloudContextDraft.explicitContextKey || '').trim();
      if (!explicitContextKey) return;
      const contextLabelValue = String(cloudContextDraft.contextLabel || '').trim();
      cloudPendingAction = 'Saving named connected-project context...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      cloudContextDraft.mode = 'custom';
      if (cloudContextMode) cloudContextMode.value = 'custom';
      renderCloudAccount();
      vscode.postMessage({
        type: 'cloudContextSave',
        contextMode: 'custom',
        explicitContextKey,
        contextLabel: contextLabelValue,
      });
    });
  }
  if (cloudContextOpen) {
    cloudContextOpen.addEventListener('click', () => {
      cloudPendingAction = 'Opening connected project in the app...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudContextOpen' });
    });
  }
  if (cloudConflictsRefresh) {
    cloudConflictsRefresh.addEventListener('click', () => {
      cloudPendingAction = 'Refreshing sync conflicts...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSyncRefreshConflicts' });
    });
  }
  if (cloudAccountOpenApp) {
    cloudAccountOpenApp.addEventListener('click', () => {
      cloudPendingAction = 'Opening QA Panda Cloud...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSessionOpen', target: 'app' });
    });
  }
  if (cloudAccountOpenNotifications) {
    cloudAccountOpenNotifications.addEventListener('click', () => {
      cloudPendingAction = 'Opening notifications...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      vscode.postMessage({ type: 'cloudSessionOpen', target: 'notifications' });
    });
  }
  if (cloudEntryLogin) {
    cloudEntryLogin.addEventListener('click', () => {
      cloudPendingAction = 'Opening browser login...';
      cloudNoticeText = '';
      setCloudAccountStatus(cloudPendingAction);
      renderCloudAccount();
      renderCloudEntryScreen();
      vscode.postMessage({ type: 'cloudSessionLogin' });
    });
  }
  if (cloudEntryGuest) {
    cloudEntryGuest.addEventListener('click', () => {
      guestModeDismissed = true;
      renderCloudEntryScreen();
    });
  }

  function sanitizeProviderIdCandidate(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function buildCustomProviderDraft(provider) {
    return {
      id: provider && provider.id ? String(provider.id) : '',
      name: provider && provider.name ? String(provider.name) : '',
      baseURL: provider && provider.baseURL ? String(provider.baseURL) : '',
    };
  }

  function getCustomProviderRows() {
    return Array.from((customProviderList && customProviderList.querySelectorAll('.custom-provider-card')) || []).map(function(row) {
      const nameInput = row.querySelector('[data-field="name"]');
      const idInput = row.querySelector('[data-field="id"]');
      const baseURLInput = row.querySelector('[data-field="baseURL"]');
      const apiKeyInput = row.querySelector('[data-field="apiKey"]');
      const name = nameInput ? nameInput.value : '';
      const id = idInput ? idInput.value : '';
      const providerId = sanitizeProviderIdCandidate(id || name);
      return {
        id: id,
        name: name,
        baseURL: baseURLInput ? baseURLInput.value : '',
        apiKey: apiKeyInput ? apiKeyInput.value : '',
        normalizedId: providerId,
      };
    });
  }

  function setCustomProviderStatus(text, isError) {
    if (!customProviderStatus) return;
    customProviderStatus.textContent = text || '';
    customProviderStatus.style.color = isError ? 'var(--vscode-errorForeground, #f48771)' : '';
  }

  function snapshotCustomProviderDraftState() {
    var rows = getCustomProviderRows()
      .filter(function(row) { return row.name || row.id || row.baseURL || row.apiKey; });
    var nextApiKeys = {};
    Object.keys(_apiKeys || {}).forEach(function(key) {
      if (BUILTIN_API_PROVIDER_IDS.indexOf(key) !== -1) nextApiKeys[key] = _apiKeys[key];
    });
    rows.forEach(function(row) {
      if (row.normalizedId) nextApiKeys[row.normalizedId] = row.apiKey || '';
    });
    _apiKeys = nextApiKeys;
    _customProviders = rows.map(function(row) {
      return buildCustomProviderDraft({
        id: row.normalizedId || row.id || row.name,
        name: row.name,
        baseURL: row.baseURL,
      });
    });
  }

  function renderCustomProviderSettings() {
    if (!customProviderList) return;
    customProviderList.innerHTML = '';
    if (!_customProviders || _customProviders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-item';
      empty.innerHTML = '<div class="settings-item-info"><div class="settings-item-name">No custom providers yet</div><div class="settings-item-desc">Add a named OpenAI-compatible endpoint to use it from API agents and the config bar.</div></div>';
      customProviderList.appendChild(empty);
      return;
    }
    _customProviders.forEach(function(provider) {
      const providerId = provider && provider.id ? String(provider.id) : '';
      const apiKeyValue = providerId && Object.prototype.hasOwnProperty.call(_apiKeys, providerId) ? (_apiKeys[providerId] || '') : '';
      const card = document.createElement('div');
      card.className = 'custom-provider-card';
      card.innerHTML =
        '<div class="custom-provider-header">' +
          '<div class="settings-item-name">Custom Provider</div>' +
          '<button class="mcp-btn" type="button" data-action="remove">Remove</button>' +
        '</div>' +
        '<div class="custom-provider-grid">' +
          '<div class="custom-provider-field"><label>Name</label><input class="mcp-input" data-field="name" placeholder="LM Studio" value="' + escapeHtml(provider && provider.name ? provider.name : '') + '" /></div>' +
          '<div class="custom-provider-field"><label>ID</label><input class="mcp-input" data-field="id" placeholder="lmstudio" value="' + escapeHtml(providerId) + '" /></div>' +
          '<div class="custom-provider-field custom-provider-field-wide"><label>Base URL</label><input class="mcp-input" data-field="baseURL" placeholder="http://localhost:1234/v1" value="' + escapeHtml(provider && provider.baseURL ? provider.baseURL : '') + '" /></div>' +
          '<div class="custom-provider-field custom-provider-field-wide"><label>API Key (optional)</label><input class="mcp-input" data-field="apiKey" type="password" placeholder="Optional" value="' + escapeHtml(apiKeyValue) + '" /></div>' +
        '</div>';
      customProviderList.appendChild(card);
    });

    Array.from(customProviderList.querySelectorAll('[data-action="remove"]')).forEach(function(button) {
      button.addEventListener('click', function() {
        const card = button.closest('.custom-provider-card');
        if (!card) return;
        const rows = getCustomProviderRows();
        const cards = Array.from(customProviderList.querySelectorAll('.custom-provider-card'));
        const removeIndex = cards.indexOf(card);
        card.remove();
        const nextRows = rows
          .filter(function(_row, index) { return index !== removeIndex; })
          .filter(function(row) { return row.name || row.id || row.baseURL || row.apiKey; });
        const nextApiKeys = {};
        Object.keys(_apiKeys || {}).forEach(function(key) {
          if (BUILTIN_API_PROVIDER_IDS.indexOf(key) !== -1) nextApiKeys[key] = _apiKeys[key];
        });
        nextRows.forEach(function(row) {
          if (row.normalizedId) nextApiKeys[row.normalizedId] = row.apiKey || '';
        });
        _apiKeys = nextApiKeys;
        _customProviders = nextRows.map(function(row) {
          return buildCustomProviderDraft({
            id: row.normalizedId || row.id || row.name,
            name: row.name,
            baseURL: row.baseURL,
          });
        });
        renderCustomProviderSettings();
        setCustomProviderStatus('', false);
      });
    });
  }

  if (customProviderAdd) {
    customProviderAdd.addEventListener('click', function() {
      snapshotCustomProviderDraftState();
      _customProviders.push(buildCustomProviderDraft({}));
      renderCustomProviderSettings();
      setCustomProviderStatus('', false);
    });
  }

  if (customProviderSave) {
    customProviderSave.addEventListener('click', function() {
      const rows = getCustomProviderRows()
        .filter(function(row) { return row.name || row.id || row.baseURL || row.apiKey; });
      const customProviders = rows.map(function(row) {
        return {
          id: row.id || row.name,
          name: row.name,
          baseURL: row.baseURL,
        };
      });
      const nextApiKeys = {};
      Object.keys(_apiKeys || {}).forEach(function(key) {
        if (BUILTIN_API_PROVIDER_IDS.indexOf(key) !== -1) nextApiKeys[key] = _apiKeys[key];
      });
      rows.forEach(function(row) {
        if (!row.normalizedId) return;
        nextApiKeys[row.normalizedId] = row.apiKey || '';
      });
      setCustomProviderStatus('Saving custom providers...', false);
      vscode.postMessage({
        type: 'settingsSave',
        settings: {
          customProviders: customProviders,
          apiKeys: nextApiKeys,
        },
      });
    });
  }

  // API key auto-save on change
  document.querySelectorAll('.settings-api-key-input').forEach(el => {
    el.addEventListener('change', () => {
      const provider = el.dataset.provider;
      if (!provider) return;
      _apiKeys[provider] = el.value;
      vscode.postMessage({ type: 'settingsSave', settings: { apiKeys: _apiKeys } });
      updateControllerDropdowns(); // refresh warning
    });
  });

  function setProjectDocStatus(kind, text) {
    const el = kind === 'appInfo' ? appInfoStatus : memoryStatus;
    if (el) el.textContent = text || '';
  }

  if (appInfoSave) {
    appInfoSave.addEventListener('click', () => {
      vscode.postMessage({
        type: 'appInfoSave',
        content: appInfoText ? appInfoText.value : '',
        enabled: appInfoEnabled ? appInfoEnabled.checked : true,
      });
      setProjectDocStatus('appInfo', 'Saved.');
    });
  }

  if (memorySave) {
    memorySave.addEventListener('click', () => {
      vscode.postMessage({
        type: 'memorySave',
        content: memoryText ? memoryText.value : '',
        enabled: memoryEnabled ? memoryEnabled.checked : true,
      });
      setProjectDocStatus('memory', 'Saved.');
    });
  }

  // ── MCP Server Management ─────────────────────────────────────────
  let mcpGlobal = {};
  let mcpProject = {};
  let mcpEditingForm = null; // { scope, name } or null

  function renderMcpList(scope) {
    const listEl = document.getElementById('mcp-list-' + scope);
    const servers = scope === 'global' ? mcpGlobal : mcpProject;
    listEl.innerHTML = '';

    const names = Object.keys(servers);
    if (names.length === 0 && !(mcpEditingForm && mcpEditingForm.scope === scope && !mcpEditingForm.name)) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.textContent = 'No servers configured';
      listEl.appendChild(empty);
    }

    // Show add form at top if adding to this scope
    if (mcpEditingForm && mcpEditingForm.scope === scope && !mcpEditingForm.name) {
      listEl.appendChild(createMcpForm(scope, null));
    }

    for (const name of names) {
      const server = servers[name];
      // Show edit form inline
      if (mcpEditingForm && mcpEditingForm.scope === scope && mcpEditingForm.name === name) {
        listEl.appendChild(createMcpForm(scope, name));
        continue;
      }
      const card = document.createElement('div');
      card.className = 'mcp-card' + (server.target === 'none' ? ' mcp-disabled' : '');

      const header = document.createElement('div');
      header.className = 'mcp-card-header';

      const targetSelect = document.createElement('select');
      targetSelect.className = 'mcp-target-select';
      const currentTarget = server.target || 'both';
      for (const [val, label] of [['both', 'Both'], ['controller', 'Controller'], ['worker', 'Worker'], ['none', 'Off']]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        if (val === currentTarget) opt.selected = true;
        targetSelect.appendChild(opt);
      }
      targetSelect.addEventListener('change', () => {
        server.target = targetSelect.value;
        notifyMcpChanged(scope);
        renderMcpList(scope);
      });

      const nameEl = document.createElement('span');
      nameEl.className = 'mcp-name';
      nameEl.textContent = name;

      const actions = document.createElement('span');
      actions.className = 'mcp-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'mcp-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        mcpEditingForm = { scope, name };
        renderMcpList(scope);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'mcp-btn mcp-btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => {
        delete servers[name];
        notifyMcpChanged(scope);
        renderMcpList(scope);
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      header.appendChild(targetSelect);
      header.appendChild(nameEl);
      header.appendChild(actions);

      const details = document.createElement('div');
      details.className = 'mcp-card-details';
      details.innerHTML =
        '<span class="mcp-detail-label">Command:</span> ' + escapeHtml(server.command || '') +
        '<br><span class="mcp-detail-label">Args:</span> ' + escapeHtml((server.args || []).join(' '));
      if (server.env && Object.keys(server.env).length > 0) {
        details.innerHTML += '<br><span class="mcp-detail-label">Env:</span> ' +
          escapeHtml(Object.entries(server.env).map(([k, v]) => k + '=' + v).join(', '));
      }

      card.appendChild(header);
      card.appendChild(details);
      listEl.appendChild(card);
    }
  }

  function serverToJson(name, server) {
    const obj = {};
    if (server.type) obj.type = server.type;
    obj.command = server.command;
    if (server.args && server.args.length > 0) obj.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) obj.env = server.env;
    const wrapper = {};
    wrapper[name] = obj;
    return JSON.stringify(wrapper, null, 2);
  }

  function createMcpForm(scope, editName) {
    const servers = scope === 'global' ? mcpGlobal : mcpProject;
    const existing = editName ? servers[editName] : null;

    const form = document.createElement('div');
    form.className = 'mcp-form';

    const prefill = existing ? serverToJson(editName, existing) : '';
    const placeholder = '{\n  "server-name": {\n    "command": "uvx",\n    "args": ["package@latest"]\n  }\n}\n\nAlso accepts {\"mcpServers\": {...}} wrapper';

    form.innerHTML =
      '<div class="mcp-form-row"><textarea class="mcp-input mcp-textarea-json" id="mcp-f-json" placeholder="' + escapeHtml(placeholder) + '">' + escapeHtml(prefill) + '</textarea></div>' +
      '<div id="mcp-f-error" class="mcp-form-error"></div>' +
      '<div class="mcp-form-actions"><button class="mcp-btn mcp-btn-primary" id="mcp-f-save">Save</button><button class="mcp-btn" id="mcp-f-cancel">Cancel</button></div>';

    setTimeout(() => {
      const saveBtn = document.getElementById('mcp-f-save');
      const cancelBtn = document.getElementById('mcp-f-cancel');
      if (saveBtn) saveBtn.addEventListener('click', () => saveMcpForm(scope, editName));
      if (cancelBtn) cancelBtn.addEventListener('click', () => { mcpEditingForm = null; renderMcpList(scope); });
    }, 0);

    return form;
  }

  /** Parse pasted JSON: supports { name: {...} }, { mcpServers: { name: {...} } }, or a fragment like "key": { ... } */
  function parseMcpJson(text) {
    let raw = text.trim();
    // If it doesn't start with '{', try wrapping with {} (handles pasted fragments like "mcpServers": {...})
    if (!raw.startsWith('{')) {
      raw = '{' + raw + '}';
    }
    // Also handle trailing commas before closing brace
    raw = raw.replace(/,\s*}/g, '}');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Expected a JSON object');

    // Unwrap { mcpServers: { ... } } wrapper
    let servers = parsed;
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
      servers = parsed.mcpServers;
    }

    // Validate: each entry must have a "command" string
    const result = {};
    for (const [name, config] of Object.entries(servers)) {
      if (!config || typeof config !== 'object') throw new Error(`"${name}" is not an object`);
      if (!config.command) throw new Error(`"${name}" is missing "command"`);
      result[name] = {
        command: config.command,
        args: Array.isArray(config.args) ? config.args : [],
        env: (config.env && typeof config.env === 'object') ? config.env : {},
      };
    }
    if (Object.keys(result).length === 0) throw new Error('No servers found in JSON');
    return result;
  }

  function saveMcpForm(scope, editName) {
    const servers = scope === 'global' ? mcpGlobal : mcpProject;
    const jsonInput = document.getElementById('mcp-f-json');
    const errorEl = document.getElementById('mcp-f-error');

    let parsed;
    try {
      parsed = parseMcpJson(jsonInput.value);
    } catch (err) {
      if (errorEl) { errorEl.textContent = err.message; }
      return;
    }

    // If editing, remove the old entry
    if (editName) {
      delete servers[editName];
    }

    // Add all parsed servers, preserving existing target if editing a single server
    for (const [name, config] of Object.entries(parsed)) {
      const prevTarget = servers[name] ? servers[name].target : (editName ? 'both' : 'both');
      servers[name] = { ...config, target: prevTarget || 'both' };
    }

    mcpEditingForm = null;
    notifyMcpChanged(scope);
    renderMcpList(scope);
  }

  function notifyMcpChanged(scope) {
    const servers = scope === 'global' ? mcpGlobal : mcpProject;
    vscode.postMessage({ type: 'mcpServersChanged', scope, servers });
  }

  // Add button listeners
  document.querySelectorAll('.mcp-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const scope = btn.dataset.scope;
      mcpEditingForm = { scope, name: null };
      renderMcpList(scope);
    });
  });

  // ── Agents Management ──────────────────────────────────────────────
  let agentsSystem = {};
  let agentsSystemMeta = {}; // { [id]: { hasUserOverride, removed, bundled } }
  let agentsGlobal = {};
  let agentsProject = {};
  let agentBrowserOverrides = {};
  let agentEditingForm = null; // { scope, id } or null

  function allAgentsMap() {
    return { ...agentsSystem, ...agentsGlobal, ...agentsProject };
  }

  function agentIdForTarget(target) {
    return target && typeof target === 'string' && target.startsWith('agent-')
      ? target.slice('agent-'.length)
      : null;
  }

  function agentForTarget(target) {
    const agentId = agentIdForTarget(target);
    return agentId ? (allAgentsMap()[agentId] || null) : null;
  }

  function agentHasBrowserMcp(agent) {
    const mcps = agent && agent.mcps && typeof agent.mcps === 'object' ? agent.mcps : {};
    return Object.keys(mcps).some(function(name) {
      return name.includes('chrome-devtools') || name.includes('chrome_devtools');
    });
  }

  function agentSupportsBrowserToggle(agent) {
    return !!agent && !(typeof agent.cli === 'string' && agent.cli.startsWith('qa-remote'));
  }

  function defaultAgentBrowserEnabled(agentId) {
    return !!agentHasBrowserMcp(agentId ? allAgentsMap()[agentId] : null);
  }

  function rememberAgentBrowserOverride(agentId, enabled) {
    if (!agentId) return;
    agentBrowserOverrides[agentId] = !!enabled;
  }

  function clearUnknownAgentBrowserOverrides() {
    const agents = allAgentsMap();
    for (const agentId of Object.keys(agentBrowserOverrides)) {
      if (!agents[agentId]) delete agentBrowserOverrides[agentId];
    }
  }

  function resetAgentBrowserOverrides() {
    agentBrowserOverrides = {};
  }

  function effectiveAgentBrowserEnabled(agentId) {
    if (!agentId) return false;
    if (Object.prototype.hasOwnProperty.call(agentBrowserOverrides, agentId)) {
      return !!agentBrowserOverrides[agentId];
    }
    return defaultAgentBrowserEnabled(agentId);
  }

  function apiProviderOptionsHtml(selectedValue) {
    var selected = String(selectedValue || 'openrouter');
    var options = API_PROVIDER_OPTIONS.length ? API_PROVIDER_OPTIONS.slice() : defaultApiProviderOptions();
    if (selected === 'custom') {
      options = options.concat([legacyCustomProviderMeta()]);
    } else if (selected && !options.some(function(provider) { return provider.id === selected; })) {
      options = options.concat([{
        id: selected,
        name: selected + ' (missing)',
        catalogKey: 'custom',
        builtIn: false,
        custom: true,
        apiKeyOptional: true,
      }]);
    }
    return options.map(function(provider) {
      return '<option value="' + escapeHtml(provider.id) + '"' + (selected === provider.id ? ' selected' : '') + '>' + escapeHtml(provider.name) + '</option>';
    }).join('');
  }

  function renderAgentList(scope) {
    const listEl = document.getElementById('agent-list-' + scope);
    if (!listEl) return;
    const isSystem = scope === 'system';
    const agents = isSystem ? agentsSystem : (scope === 'global' ? agentsGlobal : agentsProject);
    listEl.innerHTML = '';

    // For system scope, also show removed agents (so user can restore them)
    const removedSystemIds = isSystem
      ? Object.entries(agentsSystemMeta).filter(([, m]) => m.removed).map(([id]) => id)
      : [];

    const ids = Object.keys(agents);
    const allIds = isSystem ? [...new Set([...ids, ...removedSystemIds])] : ids;

    if (allIds.length === 0 && !(agentEditingForm && agentEditingForm.scope === scope && !agentEditingForm.id)) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.textContent = isSystem ? 'No system agents' : 'No agents configured';
      listEl.appendChild(empty);
    }

    if (agentEditingForm && agentEditingForm.scope === scope && !agentEditingForm.id) {
      listEl.appendChild(createAgentForm(scope, null));
    }

    for (const id of allIds) {
      const meta = isSystem ? (agentsSystemMeta[id] || {}) : {};
      const isRemoved = isSystem && meta.removed;
      const agent = isRemoved ? meta.bundled : agents[id];
      if (!agent) continue;

      if (agentEditingForm && agentEditingForm.scope === scope && agentEditingForm.id === id) {
        listEl.appendChild(createAgentForm(scope, id));
        continue;
      }

      const card = document.createElement('div');
      card.className = 'mcp-card' + (agent.enabled === false || isRemoved ? ' mcp-disabled' : '');

      const header = document.createElement('div');
      header.className = 'mcp-card-header';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !isRemoved && agent.enabled !== false;
      toggle.className = 'mcp-toggle';
      toggle.style.accentColor = 'var(--vscode-focusBorder, #007fd4)';
      toggle.style.cursor = 'pointer';
      toggle.disabled = isRemoved;
      toggle.addEventListener('change', () => {
        if (isSystem) {
          const override = { ...(meta.hasUserOverride ? agents[id] : agent), enabled: toggle.checked };
          vscode.postMessage({ type: 'agentSaveSystem', id, agent: override });
        } else {
          agent.enabled = toggle.checked;
          notifyAgentChanged(scope);
          renderAgentList(scope);
        }
      });

      const nameEl = document.createElement('span');
      nameEl.className = 'mcp-name';
      nameEl.textContent = (agent.name || id) + ' (' + id + ')';

      // Badge for system agents
      if (isSystem) {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:10px;opacity:0.6;margin-left:6px;font-style:italic;';
        badge.textContent = isRemoved ? 'removed' : (meta.hasUserOverride ? 'customized' : 'built-in');
        nameEl.appendChild(badge);
      }

      const actions = document.createElement('span');
      actions.className = 'mcp-actions';

      if (isSystem) {
        if (!isRemoved) {
          const editBtn = document.createElement('button');
          editBtn.className = 'mcp-btn';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => { agentEditingForm = { scope, id }; renderAgentList(scope); });
          actions.appendChild(editBtn);
        }
        if (!isRemoved) {
          const delBtn = document.createElement('button');
          delBtn.className = 'mcp-btn mcp-btn-danger';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'agentSaveSystem', id, agent: { removed: true } });
          });
          actions.appendChild(delBtn);
        }
        if (isRemoved || meta.hasUserOverride) {
          const restoreBtn = document.createElement('button');
          restoreBtn.className = 'mcp-btn';
          restoreBtn.textContent = isRemoved ? 'Restore' : 'Restore default';
          restoreBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'agentRestoreSystem', id });
          });
          actions.appendChild(restoreBtn);
        }
      } else {
        const editBtn = document.createElement('button');
        editBtn.className = 'mcp-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => { agentEditingForm = { scope, id }; renderAgentList(scope); });
        const delBtn = document.createElement('button');
        delBtn.className = 'mcp-btn mcp-btn-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => { delete agents[id]; notifyAgentChanged(scope); renderAgentList(scope); });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
      }

      header.appendChild(toggle);
      header.appendChild(nameEl);
      header.appendChild(actions);

      const details = document.createElement('div');
      details.className = 'mcp-card-details';
      if (agent.description) {
        details.innerHTML = escapeHtml(agent.description);
      } else {
        details.innerHTML = '<em style="opacity:0.5">No description</em>';
      }
      if (agent.system_prompt) details.innerHTML += '<br><span class="mcp-detail-label">Prompt:</span> ' + escapeHtml(agent.system_prompt.slice(0, 80)) + (agent.system_prompt.length > 80 ? '...' : '');
      if (agent.cli) details.innerHTML += '<br><span class="mcp-detail-label">CLI:</span> ' + escapeHtml(agent.cli) + (agent.model ? ' / ' + escapeHtml(agent.model) : '') + (agent.thinking ? ' / thinking:' + escapeHtml(agent.thinking) : '');
      const mcpCount = Object.keys(agent.mcps || {}).length;
      if (mcpCount) details.innerHTML += '<br><span class="mcp-detail-label">MCPs:</span> ' + mcpCount + ' server' + (mcpCount > 1 ? 's' : '');

      card.appendChild(header);
      card.appendChild(details);
      listEl.appendChild(card);
    }
  }

  function createAgentForm(scope, editId) {
    const agents = scope === 'system' ? agentsSystem : (scope === 'global' ? agentsGlobal : agentsProject);
    const existing = editId ? agents[editId] : null;

    const form = document.createElement('div');
    form.className = 'mcp-form';

    const mcpsJson = existing && existing.mcps && Object.keys(existing.mcps).length > 0
      ? JSON.stringify(existing.mcps, null, 2) : '';

    const existingCli = existing ? (existing.cli || '') : '';
    const existingProvider = existing ? (existing.provider || 'openrouter') : 'openrouter';
    const existingModel = existing ? (existing.model || '') : '';
    const existingThinking = existing ? (existing.thinking || '') : '';
    const existingRunMode = existing ? (existing.runMode || '') : '';
    const existingCodexMode = existing ? (existing.codexMode || '') : '';
    const existingApiCompactionTriggerMessages = existing && existing.apiCompactionTriggerMessages != null
      ? String(existing.apiCompactionTriggerMessages)
      : '';

    let cliOptions = ['', 'claude', 'codex', 'api', 'qa-remote-claude', 'qa-remote-codex'];
    const cliLabels = { '': 'Default (inherit from worker)', 'claude': 'claude', 'codex': 'codex', 'api': 'API (BYOK)', 'qa-remote-claude': 'qa-remote-claude', 'qa-remote-codex': 'qa-remote-codex' };
    if (!_featureFlags.enableClaudeCli) cliOptions = cliOptions.filter(v => v !== 'claude' && v !== 'qa-remote-claude');
    if (!_featureFlags.enableRemoteDesktop) cliOptions = cliOptions.filter(v => v !== 'qa-remote-claude' && v !== 'qa-remote-codex');
    const cliSelectHtml = '<select class="mcp-input" id="agent-f-cli">' +
      cliOptions.map(v => '<option value="' + v + '"' + (existingCli === v ? ' selected' : '') + '>' + cliLabels[v] + '</option>').join('') +
      '</select>';

    form.innerHTML =
      '<div class="agent-form-row"><label>ID</label><input class="mcp-input" id="agent-f-id" value="' + escapeHtml(editId || '') + '" ' + (editId ? 'disabled' : '') + ' placeholder="unique-id (e.g. qa, dev)"></div>' +
      '<div class="agent-form-row"><label>Name</label><input class="mcp-input" id="agent-f-name" value="' + escapeHtml(existing ? existing.name || '' : '') + '" placeholder="Display name"></div>' +
      '<div class="agent-form-row"><label>Description</label><input class="mcp-input" id="agent-f-desc" value="' + escapeHtml(existing ? existing.description || '' : '') + '" placeholder="Short description visible to the controller (what this agent does)"></div>' +
      '<div class="agent-form-row"><label>CLI Backend</label>' + cliSelectHtml + '</div>' +
      '<div class="agent-form-row" id="agent-f-provider-row"><label>Provider</label><select class="mcp-input" id="agent-f-provider">' +
        apiProviderOptionsHtml(existingProvider) +
      '</select></div>' +
      '<div class="agent-form-row"><label>Model</label><select class="mcp-input" id="agent-f-model"><option value="">Default</option></select>' +
      '<input type="text" class="mcp-input cfg-custom-model" id="agent-f-custom-model" placeholder="custom model name" value="' + escapeHtml(existing && existing.model && !['', '_custom'].includes(existing.model) ? '' : (existing ? existing.model || '' : '')) + '" />' +
      '<select class="mcp-input" id="agent-f-thinking"><option value="">Thinking: default</option></select></div>' +
      '<div class="agent-form-row" id="agent-f-runmode-row"><label>Run Mode</label><select class="mcp-input" id="agent-f-runmode">' +
      '<option value=""' + (existingRunMode === '' ? ' selected' : '') + '>Default (stream-json)</option>' +
      '<option value="interactive"' + (existingRunMode === 'interactive' ? ' selected' : '') + '>Interactive (terminal parser, experimental)</option>' +
      '</select></div>' +
      '<div class="agent-form-row" id="agent-f-codexmode-row"><label>Codex Mode</label><select class="mcp-input" id="agent-f-codexmode">' +
      '<option value=""' + (existingCodexMode === '' ? ' selected' : '') + '>Default (App Server)</option>' +
      '<option value="cli"' + (existingCodexMode === 'cli' ? ' selected' : '') + '>CLI (per turn)</option>' +
      '</select></div>' +
      '<div class="agent-form-row" id="agent-f-api-compaction-row"><label>API Compaction</label><input type="number" min="1" step="1" class="mcp-input" id="agent-f-api-compaction" value="' + escapeHtml(existingApiCompactionTriggerMessages) + '" placeholder="Trigger after N replay messages (e.g. 100)"></div>' +
      '<div class="agent-form-row"><label>Prompt</label><textarea class="mcp-input mcp-textarea" id="agent-f-prompt" placeholder="System prompt for this agent. Overrides the default worker prompt. NOT visible to the controller.">' + escapeHtml(existing ? existing.system_prompt || '' : '') + '</textarea></div>' +
      '<div class="agent-form-row"><label>MCPs</label><textarea class="mcp-input mcp-textarea-json" id="agent-f-mcps" placeholder="Optional additional MCP servers (JSON, same format as MCP tab)">' + escapeHtml(mcpsJson) + '</textarea></div>' +
      '<div id="agent-f-error" class="mcp-form-error"></div>' +
      '<div class="mcp-form-actions"><button class="mcp-btn mcp-btn-primary" id="agent-f-save">Save</button><button class="mcp-btn" id="agent-f-cancel">Cancel</button></div>';

    setTimeout(() => {
      const cliEl = document.getElementById('agent-f-cli');
      const providerEl = document.getElementById('agent-f-provider');
      const providerRow = document.getElementById('agent-f-provider-row');
      const modelEl = document.getElementById('agent-f-model');
      const customModelEl = document.getElementById('agent-f-custom-model');
      const thinkingEl = document.getElementById('agent-f-thinking');

      function isCodexCli(v) { return v === 'codex' || v === 'qa-remote-codex'; }
      function effectiveAgentModelValue() {
        return effectiveModelValue(modelEl, customModelEl);
      }

      function updateAgentModelOptions() {
        const cli = cliEl ? cliEl.value : '';
        const useCodex = isCodexCli(cli);
        const useApi = cli === 'api';
        const currentProvider = providerEl ? (providerEl.value || existingProvider || 'openrouter') : (existingProvider || 'openrouter');
        const providerMeta = currentProviderMeta(currentProvider);
        const previousModel = effectiveAgentModelValue();
        const previousThinking = thinkingEl ? thinkingEl.value : '';
        var models, thinkings;
        if (useApi) {
          repopulateProviderSelect(providerEl, currentProvider);
          var catalogKey = providerMeta && providerMeta.catalogKey ? providerMeta.catalogKey : currentProvider;
          models = API_PROVIDER_MODELS[catalogKey] || API_PROVIDER_MODELS.openrouter;
          thinkings = API_PROVIDER_THINKING[catalogKey] || API_PROVIDER_THINKING.openrouter;
        } else if (useCodex) {
          models = CODEX_MODELS;
          thinkings = CODEX_THINKING;
        } else {
          models = CLAUDE_MODELS;
          thinkings = CLAUDE_THINKING;
        }
        repopulateSelect(modelEl, models, '');
        repopulateSelect(thinkingEl, thinkings, previousThinking);
        setSelectWithCustomValue(modelEl, customModelEl, previousModel);
        if (useApi && providerMeta && providerMeta.custom && !previousModel) {
          ensureCustomModelSelection(modelEl, customModelEl);
        }
        if (!useApi) {
          if (modelEl && modelEl.options[0]) modelEl.options[0].text = 'Model: default';
          if (thinkingEl && thinkingEl.options[0]) thinkingEl.options[0].text = 'Thinking: default';
        }
        // Custom model input visible when _custom selected
        if (customModelEl) {
          customModelEl.classList.toggle('visible', modelEl && modelEl.value === '_custom');
        }
        // Provider row only visible for API CLI
        if (providerRow) providerRow.style.display = useApi ? '' : 'none';
        // Run Mode only applies to claude CLI
        const runModeRow = document.getElementById('agent-f-runmode-row');
        if (runModeRow) {
          const isClaude = !cli || cli === 'claude';
          runModeRow.style.display = isClaude ? '' : 'none';
        }
        // Codex Mode only applies to codex CLI
        const codexModeRow = document.getElementById('agent-f-codexmode-row');
        if (codexModeRow) {
          codexModeRow.style.display = useCodex ? '' : 'none';
        }
        // API compaction threshold only applies to API CLI
        const apiCompactionRow = document.getElementById('agent-f-api-compaction-row');
        if (apiCompactionRow) {
          apiCompactionRow.style.display = useApi ? '' : 'none';
        }
      }

      // Populate on load with saved values
      updateAgentModelOptions();
      if (modelEl && !(currentProviderMeta(existingProvider) && currentProviderMeta(existingProvider).custom && !existingModel)) {
        setSelectWithCustomValue(modelEl, customModelEl, existingModel || '');
      }
      if (thinkingEl) thinkingEl.value = existingThinking;

      if (cliEl) cliEl.addEventListener('change', updateAgentModelOptions);
      if (providerEl) providerEl.addEventListener('change', updateAgentModelOptions);
      if (modelEl) modelEl.addEventListener('change', function() {
        // Only toggle custom model input — don't repopulate the dropdown
        if (customModelEl) customModelEl.classList.toggle('visible', modelEl.value === '_custom');
      });
      document.getElementById('agent-f-save').addEventListener('click', () => saveAgentForm(scope, editId));
      document.getElementById('agent-f-cancel').addEventListener('click', () => { agentEditingForm = null; renderAgentList(scope); });
    }, 0);

    return form;
  }

  function saveAgentForm(scope, editId) {
    const isSystem = scope === 'system';
    const agents = isSystem ? agentsSystem : (scope === 'global' ? agentsGlobal : agentsProject);
    const id = (document.getElementById('agent-f-id').value || '').trim();
    const name = (document.getElementById('agent-f-name').value || '').trim();
    const description = (document.getElementById('agent-f-desc').value || '').trim();
    const cli = (document.getElementById('agent-f-cli') ? document.getElementById('agent-f-cli').value : '') || null;
    const provider = (document.getElementById('agent-f-provider') ? document.getElementById('agent-f-provider').value : '') || null;
    let model = (document.getElementById('agent-f-model') ? document.getElementById('agent-f-model').value : '') || null;
    if (model === '_custom') {
      const customModel = (document.getElementById('agent-f-custom-model') ? document.getElementById('agent-f-custom-model').value : '').trim();
      model = customModel || null;
    }
    const thinking = (document.getElementById('agent-f-thinking') ? document.getElementById('agent-f-thinking').value : '') || null;
    const runMode = (document.getElementById('agent-f-runmode') ? document.getElementById('agent-f-runmode').value : '') || null;
    const codexMode = (document.getElementById('agent-f-codexmode') ? document.getElementById('agent-f-codexmode').value : '') || null;
    const apiCompactionTriggerMessagesText = (document.getElementById('agent-f-api-compaction') ? document.getElementById('agent-f-api-compaction').value : '').trim();
    const systemPrompt = (document.getElementById('agent-f-prompt').value || '').trim();
    const mcpsText = (document.getElementById('agent-f-mcps').value || '').trim();
    const errorEl = document.getElementById('agent-f-error');

    if (!id) { if (errorEl) errorEl.textContent = 'ID is required'; return; }
    if (id === 'default') { if (errorEl) errorEl.textContent = '"default" is reserved'; return; }

    let mcps = {};
    if (mcpsText) {
      try {
        mcps = parseMcpJson(mcpsText);
      } catch (e) {
        if (errorEl) errorEl.textContent = 'MCPs JSON error: ' + e.message;
        return;
      }
    }

    let apiCompactionTriggerMessages = null;
    if (apiCompactionTriggerMessagesText) {
      if (!/^\d+$/.test(apiCompactionTriggerMessagesText) || Number(apiCompactionTriggerMessagesText) <= 0) {
        if (errorEl) errorEl.textContent = 'API compaction must be a positive integer';
        return;
      }
      apiCompactionTriggerMessages = Number(apiCompactionTriggerMessagesText);
    }

    const prevEnabled = editId && agents[editId] ? agents[editId].enabled : true;
    const agentData = { name: name || id, description, system_prompt: systemPrompt, mcps, enabled: prevEnabled !== false };
    if (cli) agentData.cli = cli;
    if (cli === 'api' && provider) agentData.provider = provider;
    if (model) agentData.model = model;
    if (thinking) agentData.thinking = thinking;
    if (runMode) agentData.runMode = runMode;
    if (codexMode) agentData.codexMode = codexMode;
    if (apiCompactionTriggerMessages != null) agentData.apiCompactionTriggerMessages = apiCompactionTriggerMessages;

    agentEditingForm = null;

    if (isSystem) {
      // Save as user override for the system agent
      vscode.postMessage({ type: 'agentSaveSystem', id: editId || id, agent: agentData });
    } else {
      if (editId && editId !== id) delete agents[editId];
      agents[id] = agentData;
      notifyAgentChanged(scope);
      renderAgentList(scope);
    }
  }

  function notifyAgentChanged(scope) {
    const agents = scope === 'global' ? agentsGlobal : agentsProject;
    vscode.postMessage({ type: 'agentSave', scope, agents });
  }

  document.querySelectorAll('.agent-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      agentEditingForm = { scope: btn.dataset.scope, id: null };
      renderAgentList(btn.dataset.scope);
    });
  });

  // ── Tests Management ──────────────────────────────────────────────

  const TEST_COLUMNS = [
    { key: 'untested', label: 'Untested', color: '#888' },
    { key: 'passing', label: 'Passing', color: '#4caf50' },
    { key: 'failing', label: 'Failing', color: '#f44336' },
    { key: 'partial', label: 'Partial', color: '#ff9800' },
  ];

  let testBoardData = [];
  const testBoardEl = document.getElementById('test-board');
  const testDetailEl = document.getElementById('test-detail');

  function renderTestBoard() {
    if (!testBoardEl) return;
    testBoardEl.innerHTML = '';

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'kanban-toolbar';
    const addBtn = document.createElement('button');
    addBtn.className = 'kanban-add-btn';
    addBtn.textContent = '+ New Test';
    addBtn.addEventListener('click', () => showTestForm(null));
    toolbar.appendChild(addBtn);

    // Summary
    const passing = testBoardData.filter(t => t.status === 'passing').length;
    const failing = testBoardData.filter(t => t.status === 'failing').length;
    const total = testBoardData.length;
    const summaryEl = document.createElement('span');
    summaryEl.className = 'test-summary';
    summaryEl.innerHTML = `<span style="color:#4caf50">${passing} passing</span> · <span style="color:#f44336">${failing} failing</span> · ${total} total`;
    toolbar.appendChild(summaryEl);
    testBoardEl.appendChild(toolbar);

    if (testBoardData.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.textContent = 'No tests yet';
      testBoardEl.appendChild(empty);
      return;
    }

    // Columns
    const cols = document.createElement('div');
    cols.className = 'kanban-columns';
    for (const col of TEST_COLUMNS) {
      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      const header = document.createElement('div');
      header.className = 'kanban-column-header';
      header.innerHTML = `<span style="color:${col.color}">●</span> ${col.label} <span class="kanban-count">${testBoardData.filter(t => t.status === col.key).length}</span>`;
      colEl.appendChild(header);

      for (const test of testBoardData.filter(t => t.status === col.key)) {
        const card = document.createElement('div');
        card.className = 'kanban-card test-card';
        card.style.borderLeftColor = col.color;

        const stepsTotal = (test.steps || []).length;
        const stepsPassing = (test.steps || []).filter(s => s.status === 'pass').length;
        const envBadge = test.environment === 'browser' ? '🌐' : '🖥️';
        const tags = (test.tags || []).map(t => `<span class="test-tag">${escapeHtml(t)}</span>`).join(' ');
        const lastTested = test.lastTestedAt ? new Date(test.lastTestedAt).toLocaleDateString() : 'Never';

        card.innerHTML =
          renderArtifactHeaderHtml('test', test.id, test.title, { icon: envBadge }) +
          `<div class="test-card-meta">
            <span class="test-steps-count">${stepsPassing}/${stepsTotal} steps passing</span>
            <span class="test-last-tested">Last: ${lastTested}</span>
          </div>` +
          (tags ? '<div class="test-tags">' + tags + '</div>' : '');
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'kanban-card-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy test';
        copyBtn.draggable = false;
        copyBtn.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        copyBtn.addEventListener('dragstart', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        wireCopyButton(copyBtn, () => formatTestCopyText(test));
        card.appendChild(copyBtn);

        card.addEventListener('click', () => showTestForm(test));
        colEl.appendChild(card);
      }
      cols.appendChild(colEl);
    }
    testBoardEl.appendChild(cols);
  }

  function showTestForm(editTest) {
    if (!testDetailEl) return;
    testDetailEl.style.display = '';
    testDetailEl.dataset.testId = editTest ? editTest.id : '';
    if (testBoardEl) testBoardEl.style.display = 'none';

    const isEdit = !!editTest;
    let html = `<div class="task-form">`;
    html += `<div class="task-detail-toolbar"><button class="mcp-btn" id="test-back">Back</button></div>`;
    html += `<div class="task-form-header">`;
    if (isEdit) {
      html += `<div class="task-detail-artifact-header">${renderArtifactHeaderHtml('test', editTest.id, editTest.title, { extraMeta: editTest.environment || '' })}</div>`;
    } else {
      html += `<h3>New Test</h3>`;
    }
    html += `</div>`;

    html += `<label>Title</label><input type="text" id="test-title" value="${isEdit ? escapeHtml(editTest.title) : ''}" placeholder="Test title..." />`;
    html += `<label>Environment</label><select id="test-env"><option value="browser" ${isEdit && editTest.environment === 'browser' ? 'selected' : ''}>Browser</option><option value="computer" ${isEdit && editTest.environment === 'computer' ? 'selected' : ''}>Desktop</option></select>`;
    html += `<label>Description</label><textarea id="test-desc" rows="2" placeholder="What does this test verify?">${isEdit ? escapeHtml(editTest.description || '') : ''}</textarea>`;
    html += `<label>Tags (comma-separated)</label><input type="text" id="test-tags" value="${isEdit ? (editTest.tags || []).join(', ') : ''}" placeholder="auth, ui, critical" />`;

    // Steps
    if (isEdit) {
      html += `<h4>Steps</h4><div id="test-steps-list">`;
      for (const step of editTest.steps || []) {
        const icon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : '⬜';
        html += `<div class="test-step-item" data-step-id="${step.id}">`;
        html += `<span class="test-step-icon">${icon}</span>`;
        html += `<div class="test-step-body">`;
        html += `<div class="test-step-desc">${escapeHtml(step.description)}</div>`;
        html += `<div class="test-step-expected">Expected: ${escapeHtml(step.expectedResult)}</div>`;
        if (step.status === 'fail' && step.actualResult) {
          html += `<div class="test-step-actual" style="color:#f44336">Actual: ${escapeHtml(step.actualResult)}</div>`;
        }
        html += `</div>`;
        html += `<button class="mcp-btn mcp-btn-danger test-step-delete" data-step-id="${step.id}">✕</button>`;
        html += `</div>`;
      }
      html += `</div>`;
      html += `<div class="test-add-step"><input type="text" id="test-new-step-desc" placeholder="Step description..." /><input type="text" id="test-new-step-expected" placeholder="Expected result..." /><button class="mcp-btn" id="test-add-step-btn">+ Add Step</button></div>`;

      // Linked tasks
      if (editTest.linkedTaskIds && editTest.linkedTaskIds.length > 0) {
        html += `<h4>Linked Issues</h4><div class="test-linked-tasks">`;
        for (const taskId of editTest.linkedTaskIds) {
          html += `<span class="test-linked-task">${escapeHtml(formatArtifactReference(taskId))}</span> `;
        }
        html += `</div>`;
      }

      // Run history
      if (editTest.runs && editTest.runs.length > 0) {
        html += `<h4>Run History (last 5)</h4><div class="test-run-history">`;
        for (const run of editTest.runs.slice(-5).reverse()) {
          const statusColor = run.status === 'passing' ? '#4caf50' : run.status === 'failing' ? '#f44336' : '#ff9800';
          html += `<div class="test-run-item"><span style="color:${statusColor}">● ${run.status}</span> — ${run.agent || 'agent'} — ${new Date(run.date).toLocaleString()}`;
          if (run.notes) html += ` — <em>${escapeHtml(run.notes)}</em>`;
          html += `</div>`;
        }
        html += `</div>`;
      }
    }

    // Buttons
    html += `<div class="task-form-actions">`;
    html += `<button class="mcp-btn" id="test-save-btn">${isEdit ? 'Save' : 'Create'}</button>`;
    if (isEdit) {
      html += ` <button class="mcp-btn" id="test-retest-btn" style="background:#0e639c;color:white">Re-test</button>`;
      html += ` <button class="mcp-btn mcp-btn-danger" id="test-delete-btn">Delete</button>`;
    }
    html += `</div></div>`;

    testDetailEl.innerHTML = html;

    // Wire events
    document.getElementById('test-back').addEventListener('click', () => {
      testDetailEl.style.display = 'none';
      testDetailEl.innerHTML = '';
      if (testBoardEl) testBoardEl.style.display = '';
    });

    document.getElementById('test-save-btn').addEventListener('click', () => {
      const title = document.getElementById('test-title').value.trim();
      if (!title) return;
      const env = document.getElementById('test-env').value;
      const desc = document.getElementById('test-desc').value.trim();
      const tags = document.getElementById('test-tags').value.split(',').map(t => t.trim()).filter(Boolean);
      if (isEdit) {
        vscode.postMessage({ type: 'testUpdate', test_id: editTest.id, title, description: desc, environment: env, tags });
      } else {
        vscode.postMessage({ type: 'testCreate', title, description: desc, environment: env, tags });
      }
      testDetailEl.style.display = 'none';
      testDetailEl.innerHTML = '';
      if (testBoardEl) testBoardEl.style.display = '';
    });

    if (isEdit) {
      // Add step
      const addStepBtn = document.getElementById('test-add-step-btn');
      if (addStepBtn) {
        addStepBtn.addEventListener('click', () => {
          const desc = document.getElementById('test-new-step-desc').value.trim();
          const expected = document.getElementById('test-new-step-expected').value.trim();
          if (!desc || !expected) return;
          vscode.postMessage({ type: 'testAddStep', test_id: editTest.id, description: desc, expectedResult: expected });
        });
      }

      // Delete step buttons
      testDetailEl.querySelectorAll('.test-step-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'testDeleteStep', test_id: editTest.id, step_id: parseInt(btn.dataset.stepId, 10) });
        });
      });

      // Delete test
      const deleteBtn = document.getElementById('test-delete-btn');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'testDelete', test_id: editTest.id });
          testDetailEl.style.display = 'none';
          testDetailEl.innerHTML = '';
          if (testBoardEl) testBoardEl.style.display = '';
        });
      }

      // Re-test
      const retestBtn = document.getElementById('test-retest-btn');
      if (retestBtn) {
        retestBtn.addEventListener('click', () => {
          const agentId = editTest.environment === 'computer' ? 'QA' : 'QA-Browser';
          const stepsText = (editTest.steps || []).map((s, i) => `${i + 1}. ${s.description} — Expected: ${s.expectedResult}`).join('\n');
          const prompt = `Re-test the following test case using the cc-tests MCP tools:\n\nTest: ${editTest.title} (${editTest.id})\nEnvironment: ${editTest.environment}\n\nSteps:\n${stepsText}\n\nInstructions:\n1. Call get_test with test_id "${editTest.id}"\n2. Call reset_test_steps with test_id "${editTest.id}"\n3. Call run_test with test_id "${editTest.id}"\n4. Execute each step and call update_step_result for each\n5. Call complete_test_run when done\n6. If any step fails, first check linked issues and search_tasks for an existing matching issue before creating a new bug ticket`;

          // Switch to correct agent and send
          const targetValue = 'agent-' + agentId;
          if (cfgChatTarget) {
            cfgChatTarget.value = targetValue;
            updateConfigBarForTarget(targetValue);
          }
          vscode.postMessage({ type: 'configChanged', config: { chatTarget: targetValue } });
          vscode.postMessage({ type: 'userInput', text: prompt });

          // Close detail and switch to Agent tab
          testDetailEl.style.display = 'none';
          testDetailEl.innerHTML = '';
          if (testBoardEl) testBoardEl.style.display = '';
          // Switch to agent tab
          tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
          const agentBtn = tabBar.querySelector('[data-tab="agent"]');
          if (agentBtn) agentBtn.classList.add('active');
          for (const [key, el] of Object.entries(tabPanels)) {
            if (key === 'agent') el.classList.remove('tab-hidden');
            else el.classList.add('tab-hidden');
          }
        });
      }
    }
  }

  // ── Modes Management ──────────────────────────────────────────────
  let modesSystem = {};
  let modesSystemMeta = {};
  let modesGlobal = {};
  let modesProject = {};
  let modeEditingForm = null; // { scope, id } or null
  let suppressTargetConfirm = false;
  let hasExplicitChatTarget = false;

  function renderModeList(scope) {
    const listEl = document.getElementById('mode-list-' + scope);
    if (!listEl) return;
    const isSystem = scope === 'system';
    const modes = isSystem ? modesSystem : (scope === 'global' ? modesGlobal : modesProject);
    listEl.innerHTML = '';

    const removedSystemIds = isSystem
      ? Object.entries(modesSystemMeta).filter(([, m]) => m.removed).map(([id]) => id)
      : [];

    const ids = Object.keys(modes);
    const allIds = isSystem ? [...new Set([...ids, ...removedSystemIds])] : ids;

    if (allIds.length === 0 && !(modeEditingForm && modeEditingForm.scope === scope && !modeEditingForm.id)) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.textContent = isSystem ? 'No system modes' : 'No modes configured';
      listEl.appendChild(empty);
    }

    if (modeEditingForm && modeEditingForm.scope === scope && !modeEditingForm.id) {
      listEl.appendChild(createModeForm(scope, null));
    }

    for (const id of allIds) {
      const meta = isSystem ? (modesSystemMeta[id] || {}) : {};
      const isRemoved = isSystem && meta.removed;
      const mode = isRemoved ? meta.bundled : modes[id];
      if (!mode) continue;

      if (modeEditingForm && modeEditingForm.scope === scope && modeEditingForm.id === id) {
        listEl.appendChild(createModeForm(scope, id));
        continue;
      }

      const card = document.createElement('div');
      card.className = 'mcp-card' + (mode.enabled === false || isRemoved ? ' mcp-disabled' : '');

      const header = document.createElement('div');
      header.className = 'mcp-card-header';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !isRemoved && mode.enabled !== false;
      toggle.className = 'mcp-toggle';
      toggle.style.accentColor = 'var(--vscode-focusBorder, #007fd4)';
      toggle.style.cursor = 'pointer';
      toggle.disabled = isRemoved;
      toggle.addEventListener('change', () => {
        if (isSystem) {
          const override = { ...(meta.hasUserOverride ? modes[id] : mode), enabled: toggle.checked };
          vscode.postMessage({ type: 'modeSaveSystem', id, mode: override });
        } else {
          mode.enabled = toggle.checked;
          notifyModeChanged(scope);
          renderModeList(scope);
        }
      });

      const nameEl = document.createElement('span');
      nameEl.className = 'mcp-name';
      nameEl.textContent = (mode.icon ? mode.icon + ' ' : '') + (mode.name || id) + ' (' + id + ')';

      if (isSystem) {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:10px;opacity:0.6;margin-left:6px;font-style:italic;';
        badge.textContent = isRemoved ? 'removed' : (meta.hasUserOverride ? 'customized' : 'built-in');
        nameEl.appendChild(badge);
      }

      const actions = document.createElement('span');
      actions.className = 'mcp-actions';

      if (isSystem) {
        if (!isRemoved) {
          const editBtn = document.createElement('button');
          editBtn.className = 'mcp-btn';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => { modeEditingForm = { scope, id }; renderModeList(scope); });
          actions.appendChild(editBtn);
        }
        if (!isRemoved) {
          const delBtn = document.createElement('button');
          delBtn.className = 'mcp-btn mcp-btn-danger';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'modeSaveSystem', id, mode: { removed: true } });
          });
          actions.appendChild(delBtn);
        }
        if (isRemoved || meta.hasUserOverride) {
          const restoreBtn = document.createElement('button');
          restoreBtn.className = 'mcp-btn';
          restoreBtn.textContent = isRemoved ? 'Restore' : 'Restore default';
          restoreBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'modeRestoreSystem', id });
          });
          actions.appendChild(restoreBtn);
        }
      } else {
        const editBtn = document.createElement('button');
        editBtn.className = 'mcp-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => { modeEditingForm = { scope, id }; renderModeList(scope); });
        const delBtn = document.createElement('button');
        delBtn.className = 'mcp-btn mcp-btn-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => { delete modes[id]; notifyModeChanged(scope); renderModeList(scope); });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
      }

      header.appendChild(toggle);
      header.appendChild(nameEl);
      header.appendChild(actions);

      const details = document.createElement('div');
      details.className = 'mcp-card-details';
      if (mode.description) {
        details.innerHTML = escapeHtml(mode.description);
      } else {
        details.innerHTML = '<em style="opacity:0.5">No description</em>';
      }
      const detailParts = [];
      if (mode.category) detailParts.push('<span class="mcp-detail-label">Category:</span> ' + escapeHtml(mode.category));
      if (mode.useController) detailParts.push('<span class="mcp-detail-label">Controller:</span> yes');
      if (mode.defaultAgent) detailParts.push('<span class="mcp-detail-label">Default Agent:</span> ' + escapeHtml(mode.defaultAgent));
      if (mode.availableAgents) detailParts.push('<span class="mcp-detail-label">Agents:</span> ' + escapeHtml(Array.isArray(mode.availableAgents) ? mode.availableAgents.join(', ') : JSON.stringify(mode.availableAgents)));
      if (mode.requiresTestEnv) detailParts.push('<span class="mcp-detail-label">Requires Test Env:</span> yes');
      if (detailParts.length) details.innerHTML += '<br>' + detailParts.join(' | ');

      card.appendChild(header);
      card.appendChild(details);
      listEl.appendChild(card);
    }
  }

  function createModeForm(scope, editId) {
    const modes = scope === 'system' ? modesSystem : (scope === 'global' ? modesGlobal : modesProject);
    const existing = editId ? modes[editId] : null;

    const form = document.createElement('div');
    form.className = 'mcp-form';

    form.innerHTML =
      '<div class="agent-form-row"><label>ID</label><input class="mcp-input" id="mode-f-id" value="' + escapeHtml(editId || '') + '" ' + (editId ? 'disabled' : '') + ' placeholder="unique-id (e.g. quick-test)"></div>' +
      '<div class="agent-form-row"><label>Name</label><input class="mcp-input" id="mode-f-name" value="' + escapeHtml(existing ? existing.name || '' : '') + '" placeholder="Display name"></div>' +
      '<div class="agent-form-row"><label>Description</label><input class="mcp-input" id="mode-f-desc" value="' + escapeHtml(existing ? existing.description || '' : '') + '" placeholder="Short description"></div>' +
      '<div class="agent-form-row"><label>Icon</label><input class="mcp-input" id="mode-f-icon" value="' + escapeHtml(existing ? existing.icon || '' : '') + '" placeholder="Emoji icon" style="max-width:60px;"></div>' +
      '<div class="agent-form-row"><label>Category</label><select class="mcp-input" id="mode-f-category"><option value="test"' + (existing && existing.category === 'test' ? ' selected' : '') + '>test</option><option value="develop"' + (existing && existing.category === 'develop' ? ' selected' : '') + '>develop</option></select></div>' +
      '<div class="agent-form-row"><label>Use Controller</label><input type="checkbox" id="mode-f-controller"' + (existing && existing.useController ? ' checked' : '') + '></div>' +
      '<div class="agent-form-row"><label>Default Agent</label><input class="mcp-input" id="mode-f-defaultAgent" value="' + escapeHtml(existing ? existing.defaultAgent || '' : '') + '" placeholder="Agent ID (e.g. QA-Browser)"></div>' +
      '<div class="agent-form-row"><label>Available Agents</label><input class="mcp-input" id="mode-f-availableAgents" value="' + escapeHtml(existing && existing.availableAgents ? existing.availableAgents.join(', ') : '') + '" placeholder="Comma-separated agent IDs"></div>' +
      '<div class="agent-form-row"><label>Requires Test Env</label><input type="checkbox" id="mode-f-requiresTestEnv"' + (existing && existing.requiresTestEnv ? ' checked' : '') + '></div>' +
      '<div class="agent-form-row"><label>Controller Prompt</label><textarea class="mcp-input mcp-textarea" id="mode-f-controllerPrompt" placeholder="Controller system prompt override">' + escapeHtml(existing ? existing.controllerPrompt || '' : '') + '</textarea></div>' +
      '<div id="mode-f-error" class="mcp-form-error"></div>' +
      '<div class="mcp-form-actions"><button class="mcp-btn mcp-btn-primary" id="mode-f-save">Save</button><button class="mcp-btn" id="mode-f-cancel">Cancel</button></div>';

    setTimeout(() => {
      document.getElementById('mode-f-save').addEventListener('click', () => saveModeForm(scope, editId));
      document.getElementById('mode-f-cancel').addEventListener('click', () => { modeEditingForm = null; renderModeList(scope); });
    }, 0);

    return form;
  }

  function saveModeForm(scope, editId) {
    const isSystem = scope === 'system';
    const modes = isSystem ? modesSystem : (scope === 'global' ? modesGlobal : modesProject);
    const id = (document.getElementById('mode-f-id').value || '').trim();
    const name = (document.getElementById('mode-f-name').value || '').trim();
    const description = (document.getElementById('mode-f-desc').value || '').trim();
    const icon = (document.getElementById('mode-f-icon').value || '').trim();
    const category = document.getElementById('mode-f-category').value;
    const useController = document.getElementById('mode-f-controller').checked;
    const defaultAgent = (document.getElementById('mode-f-defaultAgent').value || '').trim();
    const availableAgentsStr = (document.getElementById('mode-f-availableAgents').value || '').trim();
    const requiresTestEnv = document.getElementById('mode-f-requiresTestEnv').checked;
    const controllerPrompt = (document.getElementById('mode-f-controllerPrompt').value || '').trim();
    const errorEl = document.getElementById('mode-f-error');

    if (!id) { if (errorEl) errorEl.textContent = 'ID is required'; return; }

    const prevEnabled = editId && modes[editId] ? modes[editId].enabled : true;
    const modeData = {
      name: name || id,
      description,
      icon,
      category,
      useController,
      defaultAgent: defaultAgent || null,
      availableAgents: availableAgentsStr ? availableAgentsStr.split(',').map(s => s.trim()).filter(Boolean) : null,
      requiresTestEnv,
      enabled: prevEnabled !== false,
    };
    if (controllerPrompt) modeData.controllerPrompt = controllerPrompt;

    modeEditingForm = null;

    if (isSystem) {
      vscode.postMessage({ type: 'modeSaveSystem', id: editId || id, mode: modeData });
    } else {
      if (editId && editId !== id) delete modes[editId];
      modes[id] = modeData;
      notifyModeChanged(scope);
      renderModeList(scope);
    }
  }

  function notifyModeChanged(scope) {
    const modes = scope === 'global' ? modesGlobal : modesProject;
    vscode.postMessage({ type: 'modeSave', scope, modes });
  }

  document.querySelectorAll('.mode-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modeEditingForm = { scope: btn.dataset.scope, id: null };
      renderModeList(btn.dataset.scope);
    });
  });

  // ── Init Wizard ───────────────────────────────────────────────────
  const wizardEl = document.getElementById('init-wizard');
  const wizardStepOnboard = document.getElementById('wizard-step-onboard');
  const wizardStepOnboardSummary = document.getElementById('wizard-step-onboard-summary');
  let onboardingDetected = null;
  let onboardingPreference = 'both';
  let onboardingComplete = false;
  _dbg('INIT: wizardEl=' + !!wizardEl);

  // Custom confirm modal (native confirm() is blocked in VSCode webviews)
  function showConfirm(message, onYes, onNo) {
    const modal = document.getElementById('confirm-modal');
    const text = document.getElementById('confirm-modal-text');
    const yesBtn = document.getElementById('confirm-modal-yes');
    const noBtn = document.getElementById('confirm-modal-no');
    if (!modal || !text || !yesBtn || !noBtn) { if (onYes) onYes(); return; }
    text.textContent = message;
    modal.classList.add('visible');
    const cleanup = () => { modal.classList.remove('visible'); yesBtn.onclick = null; noBtn.onclick = null; };
    yesBtn.onclick = () => { cleanup(); if (onYes) onYes(); };
    noBtn.onclick = () => { cleanup(); if (onNo) onNo(); };
  }

  function showInitWizard() {
    _dbg('showInitWizard() called, onboardingComplete=' + onboardingComplete);
    if (!wizardEl) { _dbg('showInitWizard: wizardEl is null, aborting'); return; }
    if (onboardingComplete) {
      // Skip wizard entirely — go straight to chat
      goToChat();
      return;
    }
    wizardEl.classList.remove('wizard-hidden');
    tabPanels.agent.classList.add('wizard-hidden');
    renderOnboardingStep();
  }

  /**
   * Transition from wizard/onboarding to the chat screen.
   * Sets QA-Browser as default target (unless user already has a saved target).
   */
  function goToChat() {
    _dbg('goToChat() called');
    // Hide wizard overlay, show agent tab
    if (wizardEl) wizardEl.classList.add('wizard-hidden');
    tabPanels.agent.classList.remove('wizard-hidden');
    // Default to QA-Browser if no target already set
    const currentTarget = cfgChatTarget ? cfgChatTarget.value : '';
    if (!hasExplicitChatTarget && (!currentTarget || currentTarget === 'controller' || currentTarget === 'claude')) {
      suppressTargetConfirm = true;
      if (cfgChatTarget) {
        cfgChatTarget.value = 'agent-QA-Browser';
        updateConfigBarForTarget('agent-QA-Browser');
      }
      suppressTargetConfirm = false;
      hasExplicitChatTarget = true;
      vscode.postMessage({ type: 'configChanged', config: { chatTarget: 'agent-QA-Browser' } });
    }
    // Show welcome splash if no real chat entries exist
    if (messagesEl && !messagesEl.querySelector('.section')) {
      showWelcome();
    }
    saveState();
  }

  // ── Onboarding Wizard ─────────────────────────────────────────────

  function hideAllWizardSteps() {
    if (wizardStepOnboard) wizardStepOnboard.classList.add('wizard-hidden');
    if (wizardStepOnboardSummary) wizardStepOnboardSummary.classList.add('wizard-hidden');
  }

  function renderOnboardingStep() {
    hideAllWizardSteps();
    if (!wizardStepOnboard) return;
    wizardStepOnboard.classList.remove('wizard-hidden');

    const statusEl = document.getElementById('onboard-status');
    const prefEl = document.getElementById('onboard-cli-preference');
    const nextBtn = document.getElementById('onboard-next');

    if (statusEl) {
      statusEl.innerHTML = '<div class="onboard-item"><span class="onboard-spinner"></span><span class="onboard-item-label"><span class="onboard-item-name">Detecting tools...</span></span></div>';
    }
    if (prefEl) prefEl.classList.add('wizard-hidden');
    if (nextBtn) nextBtn.disabled = true;

    // Request detection from extension host
    vscode.postMessage({ type: 'onboardingDetect' });
  }

  function renderOnboardingDetected(detected) {
    onboardingDetected = detected;
    const statusEl = document.getElementById('onboard-status');
    const prefEl = document.getElementById('onboard-cli-preference');
    const nextBtn = document.getElementById('onboard-next');
    if (!statusEl || !detected) return;

    const c = detected.clis || {};
    const t = detected.tools || {};
    const platform = detected.platform || 'win32';
    _onboardPlatform = platform;
    const codex = c.codex || {};
    const chrome = t.chrome || {};
    const node = t.node || {};
    const claudeEnabled = _featureFlags.enableClaudeCli;
    const claudeOk = claudeEnabled && c.claude && c.claude.available;
    const codexOk = codex.available;

    // Build check items with detailed status/messages + fixStep for actionable items
    const items = [];

    // Codex CLI
    if (codexOk) {
      if (!codex.versionOk) {
        items.push({ status: 'warn', name: 'Codex CLI', detail: 'Outdated (v' + (codex.parsed ? codex.parsed.raw : codex.version) + ')', fixStep: 'codex-install' });
      } else if (!codex.loggedIn) {
        items.push({ status: 'warn', name: 'Codex CLI', detail: 'v' + (codex.parsed ? codex.parsed.raw : '') + ' — not logged in', fixStep: 'codex-login' });
      } else {
        items.push({ status: 'ok', name: 'Codex CLI', detail: 'v' + (codex.parsed ? codex.parsed.raw : '') + ' — logged in via ' + (codex.loginMethod || 'API key') });
      }
    } else {
      items.push({ status: 'fail', name: 'Codex CLI', detail: 'Not found', fixStep: 'codex-install' });
    }

    // Claude CLI (only if feature flag on)
    if (claudeEnabled) {
      if (claudeOk) {
        items.push({ status: 'ok', name: 'Claude Code CLI', detail: (c.claude.version || '').split('\\n')[0] });
      } else {
        items.push({ status: 'fail', name: 'Claude Code CLI', detail: 'Not found' });
      }
    }

    // Node.js
    if (node.available) {
      if (!node.versionOk) {
        items.push({ status: 'warn', name: 'Node.js', detail: 'v' + (node.major || '') + ' is too old — update to v18+', fixStep: 'node-install' });
      } else {
        items.push({ status: 'ok', name: 'Node.js', detail: node.version });
      }
    } else {
      items.push({ status: 'warn', name: 'Node.js', detail: 'Not found', fixStep: 'node-install' });
    }

    // Chrome
    if (chrome.available) {
      if (!chrome.versionOk) {
        items.push({ status: 'warn', name: 'Google Chrome', detail: 'v' + (chrome.major || '?') + ' is too old — update to v120+', fixStep: 'chrome-update' });
      } else {
        items.push({ status: 'ok', name: 'Google Chrome', detail: 'v' + chrome.major + ' — browser testing ready' });
      }
    } else {
      items.push({ status: 'warn', name: 'Google Chrome', detail: 'Not found', fixStep: 'chrome-install' });
    }

    // Docker (only if remote desktop flag on)
    if (_featureFlags.enableRemoteDesktop) {
      const docker = t.docker || {};
      if (docker.available && docker.running) {
        items.push({ status: 'ok', name: 'Docker', detail: 'Running — desktop testing available' });
      } else if (docker.available) {
        items.push({ status: 'warn', name: 'Docker', detail: 'Installed but not running — start Docker Desktop' });
      } else {
        items.push({ status: 'warn', name: 'Docker', detail: 'Not found — install Docker Desktop for desktop testing' });
      }
    }

    // Animate items appearing one by one (skip animation in test environment)
    var animDelay = (typeof window._noOnboardAnimation !== 'undefined') ? 0 : 200;
    statusEl.innerHTML = '';
    items.forEach(function (item, i) {
      if (animDelay === 0) {
        statusEl.innerHTML += makeOnboardItem(item.status, item.name, item.detail, item.fixStep);
        if (i === items.length - 1) {
          _showOnboardImpact(statusEl, codexOk, codex, chrome, node, claudeOk);
          _showOnboardPreference(prefEl, nextBtn, codexOk, claudeOk);
        }
      } else {
        setTimeout(function () {
          statusEl.innerHTML += makeOnboardItem(item.status, item.name, item.detail, item.fixStep);
          if (i === items.length - 1) {
            _showOnboardImpact(statusEl, codexOk, codex, chrome, node, claudeOk);
            _showOnboardPreference(prefEl, nextBtn, codexOk, claudeOk);
          }
        }, i * animDelay);
      }
    });
  }

  function _showOnboardImpact(statusEl, codexOk, codex, chrome, node, claudeOk) {
    var impacts = [];
    if (!codexOk) {
      impacts.push({ icon: '\u274C', text: 'QA Panda requires Codex CLI to function. Install it to continue.', cls: 'impact-block' });
    } else if (!codex.loggedIn) {
      impacts.push({ icon: '\u26A0\uFE0F', text: 'Log in to Codex (run codex login) before using QA Panda.', cls: 'impact-warn' });
    } else {
      impacts.push({ icon: '\u2705', text: 'AI Chat & Agents ready', cls: 'impact-ok' });
    }
    if (chrome.available && chrome.versionOk) {
      impacts.push({ icon: '\u2705', text: 'Browser testing ready', cls: 'impact-ok' });
    } else if (chrome.available) {
      impacts.push({ icon: '\u26A0\uFE0F', text: 'Update Chrome for browser testing (v120+ required)', cls: 'impact-warn' });
    } else {
      impacts.push({ icon: '\u2139\uFE0F', text: 'Browser testing unavailable — install Chrome to enable it', cls: 'impact-info' });
    }
    if (!node.available || !node.versionOk) {
      impacts.push({ icon: '\u2139\uFE0F', text: 'Some MCP tools may be limited without Node.js 18+', cls: 'impact-info' });
    }

    var html = '<div class="onboard-impact">';
    for (var j = 0; j < impacts.length; j++) {
      html += '<div class="onboard-impact-item ' + impacts[j].cls + '">' + impacts[j].icon + ' ' + impacts[j].text + '</div>';
    }
    html += '</div>';
    statusEl.innerHTML += html;
  }

  function _showOnboardPreference(prefEl, nextBtn, codexOk, claudeOk) {
    if (!codexOk && !claudeOk) {
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    if (prefEl) {
      prefEl.innerHTML = '';
      var claudeEnabled = _featureFlags.enableClaudeCli;
      var options = [];
      if (claudeEnabled && claudeOk && codexOk) options.push({ id: 'both', icon: '&#9889;', title: 'Both (recommended)', desc: 'Codex as controller, Claude Code as worker — best results' });
      if (claudeEnabled && claudeOk) options.push({ id: 'claude-only', icon: '&#129302;', title: 'Claude Code only', desc: 'Use Claude Code for everything' });
      if (codexOk) options.push({ id: 'codex-only', icon: '&#128187;', title: 'Codex only', desc: 'Use Codex for everything' });

      if (claudeEnabled && claudeOk && codexOk) onboardingPreference = 'both';
      else if (claudeEnabled && claudeOk) onboardingPreference = 'claude-only';
      else onboardingPreference = 'codex-only';

      if (options.length <= 1) {
        prefEl.classList.add('wizard-hidden');
        if (nextBtn) nextBtn.disabled = false;
        return;
      }
      prefEl.classList.remove('wizard-hidden');

      var heading = document.createElement('div');
      heading.className = 'onboard-section-label';
      heading.textContent = 'Choose your preferred CLI setup:';
      prefEl.appendChild(heading);

      var cardsWrap = document.createElement('div');
      cardsWrap.className = 'wizard-cards';

      for (var k = 0; k < options.length; k++) {
        (function (opt) {
          var card = document.createElement('div');
          card.className = 'wizard-card' + (opt.id === onboardingPreference ? ' selected' : '');
          card.dataset.pref = opt.id;
          card.innerHTML = '<div class="wizard-card-icon">' + opt.icon + '</div><div class="wizard-card-title">' + opt.title + '</div><div class="wizard-card-desc">' + opt.desc + '</div>';
          card.addEventListener('click', function () {
            onboardingPreference = opt.id;
            cardsWrap.querySelectorAll('.wizard-card').forEach(function (c) { c.classList.remove('selected'); });
            card.classList.add('selected');
          });
          cardsWrap.appendChild(card);
        })(options[k]);
      }
      prefEl.appendChild(cardsWrap);
    }

    if (nextBtn) nextBtn.disabled = false;
  }

  var _onboardPlatform = 'win32';

  function makeOnboardItem(status, name, detail, fixStep) {
    var icons = { ok: '\u2705', warn: '\u26A0\uFE0F', fail: '\u274C' };
    var html = '<div class="onboard-item ' + status + ' onboard-fade-in" data-step="' + (fixStep || '') + '">'
      + '<span class="onboard-item-icon">' + (icons[status] || '') + '</span>'
      + '<span class="onboard-item-label">'
      + '<span class="onboard-item-name">' + name + '</span>'
      + '<span class="onboard-item-detail">' + detail + '</span>';
    // Add action buttons for failing/warning items that have a fix step
    if (status !== 'ok' && fixStep) {
      var canAutoFix = (fixStep === 'codex-install' || fixStep === 'codex-login');
      html += '<div class="onboard-actions">';
      if (canAutoFix) html += '<button class="onboard-fix-btn" data-step="' + fixStep + '">Fix automatically</button>';
      html += '<button class="onboard-manual-btn" data-step="' + fixStep + '">Show manual steps</button>';
      html += '</div>';
      html += '<div class="onboard-manual-instructions" id="manual-' + fixStep + '">' + _getManualInstructions(fixStep, _onboardPlatform) + '</div>';
      html += '<div class="onboard-fix-output" id="fix-output-' + fixStep + '" style="display:none"></div>';
    }
    html += '</span></div>';
    return html;
  }

  function _getManualInstructions(step, platform) {
    var openTerminal = platform === 'win32'
      ? 'Open <strong>Command Prompt</strong> (press Win+R, type <code>cmd</code>, press Enter)'
      : platform === 'darwin'
        ? 'Open <strong>Terminal</strong> (press Cmd+Space, type <code>Terminal</code>, press Enter)'
        : 'Open a <strong>terminal</strong>';
    if (step === 'codex-install') {
      return '<ol>'
        + '<li>' + openTerminal + '</li>'
        + '<li>Type the following command and press Enter:<br><code>npm install -g @openai/codex</code></li>'
        + '<li>Wait for installation to complete</li>'
        + '<li>Click <strong>Re-check</strong> to verify</li>'
        + '</ol>';
    }
    if (step === 'codex-login') {
      return '<ol>'
        + '<li>' + openTerminal + '</li>'
        + '<li>Type the following command and press Enter:<br><code>codex login</code></li>'
        + '<li>Your browser will open — sign in to your account</li>'
        + '<li>Return here and click <strong>Re-check</strong></li>'
        + '</ol>';
    }
    if (step === 'node-install') {
      if (platform === 'darwin') {
        return '<ol><li>Download and install from <strong>nodejs.org</strong> (LTS version)</li>'
          + '<li>Or run: <code>brew install node</code></li>'
          + '<li>Click <strong>Re-check</strong> to verify</li></ol>';
      }
      if (platform === 'linux') {
        return '<ol><li>Run: <code>sudo apt install nodejs npm</code> (Ubuntu/Debian)</li>'
          + '<li>Or download from <strong>nodejs.org</strong></li>'
          + '<li>Click <strong>Re-check</strong> to verify</li></ol>';
      }
      return '<ol><li>Download and install from <strong>nodejs.org</strong> (LTS version recommended)</li>'
        + '<li>Click <strong>Re-check</strong> to verify</li></ol>';
    }
    if (step === 'chrome-install') {
      var html = '<ol><li>Download from <strong>google.com/chrome</strong></li>';
      if (platform === 'linux') html += '<li>Or run: <code>sudo apt install google-chrome-stable</code></li>';
      html += '<li>Click <strong>Re-check</strong> to verify</li></ol>';
      return html;
    }
    if (step === 'chrome-update') {
      return '<ol><li>Open Chrome and go to <strong>Settings → About Chrome</strong> to update</li>'
        + '<li>Click <strong>Re-check</strong> to verify</li></ol>';
    }
    return '';
  }

  function renderOnboardingSummary() {
    hideAllWizardSteps();
    if (!wizardStepOnboardSummary) return;
    wizardStepOnboardSummary.classList.remove('wizard-hidden');

    const summaryEl = document.getElementById('onboard-summary');
    if (!summaryEl || !onboardingDetected) return;

    const c = onboardingDetected.clis || {};
    const t = onboardingDetected.tools || {};
    const items = [];

    // CLI preference summary
    const prefLabel = { both: 'Both CLIs', 'claude-only': 'Claude Code only', 'codex-only': 'Codex only' };
    items.push(makeOnboardItem('ok', 'CLI Preference', prefLabel[onboardingPreference] || onboardingPreference));

    if (_featureFlags.enableClaudeCli && c.claude && c.claude.available) items.push(makeOnboardItem('ok', 'Claude Code', 'Available'));
    if (c.codex && c.codex.available) items.push(makeOnboardItem('ok', 'Codex', 'Available'));
    if (t.chrome && t.chrome.available) items.push(makeOnboardItem('ok', 'Chrome', 'Browser testing available'));
    else items.push(makeOnboardItem('warn', 'Chrome', 'Not available — browser testing disabled'));
    if (_featureFlags.enableRemoteDesktop) {
      if (t.docker && t.docker.available && t.docker.running) items.push(makeOnboardItem('ok', 'Docker', 'Desktop testing available'));
      else items.push(makeOnboardItem('warn', 'Docker', 'Not available — desktop testing disabled'));
    }

    summaryEl.innerHTML = items.join('');
  }

  // Wire up onboarding buttons
  const onboardNextBtn = document.getElementById('onboard-next');
  if (onboardNextBtn) {
    onboardNextBtn.addEventListener('click', () => {
      // Skip summary step if there's nothing extra to show (no claude, no remote desktop)
      if (!_featureFlags.enableClaudeCli && !_featureFlags.enableRemoteDesktop) {
        onboardingComplete = true;
        vscode.postMessage({ type: 'onboardingSave', preference: onboardingPreference || 'codex-only', detected: onboardingDetected || { clis: {}, tools: {} } });
        goToChat();
        return;
      }
      renderOnboardingSummary();
    });
  }
  const onboardSkipBtn = document.getElementById('onboard-skip');
  if (onboardSkipBtn) {
    onboardSkipBtn.addEventListener('click', () => {
      // Skip onboarding — mark as complete with defaults
      onboardingComplete = true;
      vscode.postMessage({ type: 'onboardingSave', preference: 'both', detected: onboardingDetected || { clis: {}, tools: {} } });
      goToChat();
    });
  }
  const onboardCompleteBtn = document.getElementById('onboard-complete');
  if (onboardCompleteBtn) {
    onboardCompleteBtn.addEventListener('click', () => {
      onboardingComplete = true;
      vscode.postMessage({ type: 'onboardingSave', preference: onboardingPreference, detected: onboardingDetected || { clis: {}, tools: {} } });
      goToChat();
    });
  }
  const onboardSummaryBackBtn = document.getElementById('onboard-summary-back');
  if (onboardSummaryBackBtn) {
    onboardSummaryBackBtn.addEventListener('click', () => renderOnboardingStep());
  }
  // Re-check button
  const onboardRecheckBtn = document.getElementById('onboard-recheck');
  if (onboardRecheckBtn) {
    onboardRecheckBtn.addEventListener('click', () => renderOnboardingStep());
  }
  // Event delegation for auto-fix and manual instruction buttons
  const onboardStatusEl = document.getElementById('onboard-status');
  if (onboardStatusEl) {
    onboardStatusEl.addEventListener('click', function (e) {
      var fixBtn = e.target.closest('.onboard-fix-btn');
      if (fixBtn) {
        var step = fixBtn.dataset.step;
        fixBtn.disabled = true;
        fixBtn.textContent = step === 'codex-login' ? 'Waiting for login...' : 'Installing...';
        var outputEl = document.getElementById('fix-output-' + step);
        if (outputEl) { outputEl.style.display = ''; outputEl.textContent = ''; }
        vscode.postMessage({ type: 'onboardingAutoFix', step: step });
        return;
      }
      var manualBtn = e.target.closest('.onboard-manual-btn');
      if (manualBtn) {
        var manualEl = document.getElementById('manual-' + manualBtn.dataset.step);
        if (manualEl) manualEl.classList.toggle('visible');
        return;
      }
    });
  }

  function hideInitWizard() {
    _dbg('hideInitWizard() called');
    goToChat();
  }

  function showWelcome() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '<div class="welcome-splash">' +
      '<div class="welcome-icon">\uD83D\uDC3C</div>' +
      '<div class="welcome-title">QA Panda</div>' +
      '<div class="welcome-subtitle">AI-powered QA for your codebase</div>' +
      '<div class="welcome-hints">' +
        '<div class="welcome-hint">\uD83E\uDDEA Ask me to <strong>set up your app</strong> and run it</div>' +
        '<div class="welcome-hint">\uD83D\uDD0D Ask me to <strong>test</strong> your app or a specific feature</div>' +
        '<div class="welcome-hint">\uD83D\uDC1B Ask me to <strong>find and fix bugs</strong> in your code</div>' +
      '</div>' +
      '<div class="welcome-rerun-setup" id="welcome-rerun-setup">Re-run environment setup</div>' +
    '</div>';
    // Wire up re-run setup link
    const rerunEl = document.getElementById('welcome-rerun-setup');
    if (rerunEl) {
      rerunEl.addEventListener('click', () => {
        onboardingComplete = false;
        showInitWizard();
      });
    }
  }

  function clearWelcome() {
    const splash = messagesEl && messagesEl.querySelector('.welcome-splash');
    if (splash) splash.remove();
  }

  /**
   * Check if the currently active agent runs inside a Docker container.
   * Remote agents (qa-remote-*) → VNC widget. Local agents (claude/codex) → Chrome widget.
   */
  function _isCurrentAgentRemote() {
    const target = cfgChatTarget ? cfgChatTarget.value : 'controller';
    if (!target.startsWith('agent-')) return false;
    const agentId = target.slice('agent-'.length);
    const allAgents = { ...agentsSystem, ...agentsGlobal, ...agentsProject };
    const agent = allAgents[agentId];
    if (!agent || !agent.cli) return false;
    return agent.cli.startsWith('qa-remote');
  }


  // ── Issues / Kanban ──────────────────────────────────────────────────
  const TASK_COLUMNS = [
    { key: 'backlog', label: 'Backlog' },
    { key: 'todo', label: 'To Do' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'review', label: 'Code Review' },
    { key: 'testing', label: 'Testing' },
    { key: 'done', label: 'Done' },
  ];

  let kanbanTasks = [];
  const kanbanBoard = document.getElementById('kanban-board');
  const taskDetail = document.getElementById('task-detail');

  function renderKanban() {
    kanbanBoard.innerHTML = '';
    kanbanBoard.style.display = '';
    taskDetail.style.display = 'none';

    // New issue button row
    const toolbar = document.createElement('div');
    toolbar.className = 'kanban-toolbar';
    const addBtn = document.createElement('button');
    addBtn.className = 'mcp-btn mcp-btn-primary';
    addBtn.textContent = '+ New Issue';
    addBtn.addEventListener('click', () => showTaskForm(null));
    toolbar.appendChild(addBtn);
    kanbanBoard.appendChild(toolbar);

    if (kanbanTasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.textContent = 'No issues yet';
      kanbanBoard.appendChild(empty);
      return;
    }

    const columnsRow = document.createElement('div');
    columnsRow.className = 'kanban-columns';

    let draggedTaskId = null;

    for (const col of TASK_COLUMNS) {
      const colEl = document.createElement('div');
      colEl.className = 'kanban-column';
      colEl.dataset.status = col.key;

      // Drop target events
      colEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        colEl.classList.add('kanban-column-dragover');
      });
      colEl.addEventListener('dragleave', () => {
        colEl.classList.remove('kanban-column-dragover');
      });
      colEl.addEventListener('drop', (e) => {
        e.preventDefault();
        colEl.classList.remove('kanban-column-dragover');
        if (draggedTaskId && col.key) {
          vscode.postMessage({ type: 'taskUpdate', task_id: draggedTaskId, status: col.key });
          draggedTaskId = null;
        }
      });

      const tasks = kanbanTasks.filter(t => t.status === col.key);
      const header = document.createElement('div');
      header.className = 'kanban-column-header';
      header.innerHTML = escapeHtml(col.label) + ' <span class="kanban-count">' + tasks.length + '</span>';
      colEl.appendChild(header);

      for (const task of tasks) {
        const card = document.createElement('div');
        card.className = 'kanban-card';
        card.draggable = true;
        card.dataset.taskId = task.id;
        card.addEventListener('click', () => showTaskDetail(task.id));
        card.addEventListener('dragstart', (e) => {
          draggedTaskId = task.id;
          card.classList.add('kanban-card-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', task.id);
        });
        card.addEventListener('dragend', () => {
          card.classList.remove('kanban-card-dragging');
          draggedTaskId = null;
          document.querySelectorAll('.kanban-column-dragover').forEach(el => el.classList.remove('kanban-column-dragover'));
        });

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'kanban-card-copy';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy issue';
        copyBtn.draggable = false;
        copyBtn.addEventListener('mousedown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        copyBtn.addEventListener('dragstart', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        wireCopyButton(copyBtn, () => formatTaskCopyText(task));

        const title = document.createElement('div');
        title.className = 'kanban-card-title';
        title.innerHTML = renderArtifactHeaderHtml('task', task.id, task.title);

        const desc = document.createElement('div');
        desc.className = 'kanban-card-desc';
        desc.textContent = (task.description || '').slice(0, 80);

        const meta = document.createElement('div');
        meta.className = 'kanban-card-meta';
        const cc = (task.comments || []).length;
        const pc = (task.progress_updates || []).length;
        if (cc) meta.innerHTML += '<span>' + cc + ' comment' + (cc > 1 ? 's' : '') + '</span>';
        if (pc) meta.innerHTML += '<span>' + pc + ' update' + (pc > 1 ? 's' : '') + '</span>';

        card.appendChild(copyBtn);
        card.appendChild(title);
        if (task.description) card.appendChild(desc);
        if (cc || pc) card.appendChild(meta);
        colEl.appendChild(card);
      }

      // Spacer fills remaining space so the entire column is a drop target
      const spacer = document.createElement('div');
      spacer.className = 'kanban-column-spacer';
      colEl.appendChild(spacer);

      columnsRow.appendChild(colEl);
    }
    kanbanBoard.appendChild(columnsRow);
  }

  function showTaskForm(editTask) {
    kanbanBoard.style.display = 'none';
    taskDetail.style.display = '';
    taskDetail.innerHTML = '';
    taskDetail.dataset.taskId = editTask ? editTask.id : '';

    const isEdit = !!editTask;
    const t = editTask || { title: '', description: '', detail_text: '', status: 'backlog' };

    taskDetail.innerHTML =
      '<div class="task-detail-toolbar">' +
        '<button class="mcp-btn" id="task-back">Back</button>' +
        (isEdit ? '<button class="mcp-btn mcp-btn-danger" id="task-delete">Delete</button>' : '') +
      '</div>' +
      (isEdit ? '<div class="task-detail-artifact-header">' + renderArtifactHeaderHtml('task', t.id, t.title || 'Issue') + '</div>' : '') +
      '<div class="mcp-form">' +
        '<div class="mcp-form-row"><label>Title</label><input class="mcp-input" id="task-f-title" value="' + escapeHtml(t.title) + '"></div>' +
        '<div class="mcp-form-row"><label>Status</label><select class="mcp-input" id="task-f-status">' +
          TASK_COLUMNS.map(c => '<option value="' + c.key + '"' + (c.key === t.status ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>').join('') +
        '</select></div>' +
        '<div class="mcp-form-row"><label>Description</label><textarea class="mcp-input mcp-textarea" id="task-f-desc" rows="3" placeholder="Short summary">' + escapeHtml(t.description || '') + '</textarea></div>' +
        '<div class="mcp-form-row"><label>Details</label><textarea class="mcp-input mcp-textarea" id="task-f-detail" placeholder="Detailed notes / acceptance criteria">' + escapeHtml(t.detail_text || '') + '</textarea></div>' +
        '<div class="mcp-form-actions"><button class="mcp-btn mcp-btn-primary" id="task-f-save">' + (isEdit ? 'Save Changes' : 'Create Issue') + '</button></div>' +
      '</div>';

    // Comments & progress (edit mode only)
    if (isEdit) {
      // Comments section
      let commentsHtml = '<div class="task-section"><h4>Comments</h4>';
      for (const c of (t.comments || [])) {
        commentsHtml += '<div class="task-entry" data-comment-id="' + c.id + '"><div class="task-entry-header"><span class="task-entry-author">' + escapeHtml(c.author) + '</span> <span class="task-entry-date">' + (c.created_at || '').slice(0, 16) + '</span><span class="task-entry-actions"><button class="mcp-btn task-edit-comment-btn" data-id="' + c.id + '">Edit</button><button class="mcp-btn mcp-btn-danger task-del-comment-btn" data-id="' + c.id + '">Del</button></span></div><div class="task-entry-text">' + escapeHtml(c.text) + '</div></div>';
      }
      commentsHtml += '<div class="task-add-row"><input class="mcp-input" id="task-comment-text" placeholder="Add a comment..."><button class="mcp-btn mcp-btn-primary" id="task-comment-post">Post</button></div></div>';

      // Progress section
      let progressHtml = '<div class="task-section"><h4>Progress Updates</h4>';
      for (const p of (t.progress_updates || [])) {
        progressHtml += '<div class="task-entry" data-progress-id="' + p.id + '"><div class="task-entry-header"><span class="task-entry-author">' + escapeHtml(p.author) + '</span> <span class="task-entry-date">' + (p.created_at || '').slice(0, 16) + '</span><span class="task-entry-actions"><button class="mcp-btn task-edit-progress-btn" data-id="' + p.id + '">Edit</button><button class="mcp-btn mcp-btn-danger task-del-progress-btn" data-id="' + p.id + '">Del</button></span></div><div class="task-entry-text">' + escapeHtml(p.text) + '</div></div>';
      }
      progressHtml += '<div class="task-add-row"><input class="mcp-input" id="task-progress-text" placeholder="Add a progress update..."><button class="mcp-btn mcp-btn-primary" id="task-progress-post">Post</button></div></div>';

      taskDetail.innerHTML += commentsHtml + progressHtml;
    }

    // Wire up events
    setTimeout(() => {
      document.getElementById('task-back').addEventListener('click', renderKanban);

      document.getElementById('task-f-save').addEventListener('click', () => {
        const title = document.getElementById('task-f-title').value.trim();
        if (!title) return;
        if (isEdit) {
          vscode.postMessage({ type: 'taskUpdate', task_id: t.id, title, description: document.getElementById('task-f-desc').value, detail_text: document.getElementById('task-f-detail').value, status: document.getElementById('task-f-status').value });
        } else {
          vscode.postMessage({ type: 'taskCreate', title, description: document.getElementById('task-f-desc').value, detail_text: document.getElementById('task-f-detail').value, status: document.getElementById('task-f-status').value });
        }
      });

      const delBtn = document.getElementById('task-delete');
      if (delBtn) {
        delBtn.addEventListener('click', () => {
          showConfirm('Delete this issue?', () => {
            vscode.postMessage({ type: 'taskDelete', task_id: t.id });
            taskDetail.style.display = 'none';
            taskDetail.innerHTML = '';
            renderKanban();
          });
        });
      }

      const commentPost = document.getElementById('task-comment-post');
      if (commentPost) {
        commentPost.addEventListener('click', () => {
          const text = document.getElementById('task-comment-text').value.trim();
          if (text) vscode.postMessage({ type: 'taskAddComment', task_id: t.id, text });
        });
      }

      // Comment edit/delete
      document.querySelectorAll('.task-del-comment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'taskDeleteComment', task_id: t.id, comment_id: Number(btn.dataset.id) });
        });
      });
      document.querySelectorAll('.task-edit-comment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = btn.closest('.task-entry');
          const textEl = entry.querySelector('.task-entry-text');
          const current = textEl.textContent;
          textEl.innerHTML = '<div class="task-add-row"><input class="mcp-input task-inline-edit" value="' + escapeHtml(current) + '"><button class="mcp-btn mcp-btn-primary task-inline-save">Save</button></div>';
          const saveBtn = textEl.querySelector('.task-inline-save');
          saveBtn.addEventListener('click', () => {
            const newText = textEl.querySelector('.task-inline-edit').value.trim();
            if (newText) vscode.postMessage({ type: 'taskEditComment', task_id: t.id, comment_id: Number(btn.dataset.id), text: newText });
          });
        });
      });

      const progressPost = document.getElementById('task-progress-post');
      if (progressPost) {
        progressPost.addEventListener('click', () => {
          const text = document.getElementById('task-progress-text').value.trim();
          if (text) vscode.postMessage({ type: 'taskAddProgress', task_id: t.id, text });
        });
      }

      // Progress edit/delete
      document.querySelectorAll('.task-del-progress-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'taskDeleteProgress', task_id: t.id, progress_id: Number(btn.dataset.id) });
        });
      });
      document.querySelectorAll('.task-edit-progress-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = btn.closest('.task-entry');
          const textEl = entry.querySelector('.task-entry-text');
          const current = textEl.textContent;
          textEl.innerHTML = '<div class="task-add-row"><input class="mcp-input task-inline-edit" value="' + escapeHtml(current) + '"><button class="mcp-btn mcp-btn-primary task-inline-save">Save</button></div>';
          const saveBtn = textEl.querySelector('.task-inline-save');
          saveBtn.addEventListener('click', () => {
            const newText = textEl.querySelector('.task-inline-edit').value.trim();
            if (newText) vscode.postMessage({ type: 'taskEditProgress', task_id: t.id, progress_id: Number(btn.dataset.id), text: newText });
          });
        });
      });
    }, 0);
  }

  function showTaskDetail(taskId) {
    const task = kanbanTasks.find(t => t.id === taskId);
    if (task) showTaskForm(task);
  }

  // ── VNC / Computer Tab ───────────────────────────────────────────────
  let panelId = null;  // set by initConfig, persisted for container linking
  let novncPort = null;
  // Split-view state
  let splitVncWrapper = null;
  let splitVncLeft = null;
  let splitVncCollapsed = false;

  // Chrome screencast state (for local agents)
  let chromePort = null;
  let chromeFrameDebugCount = 0;
  let splitChromeWrapper = null;
  let splitChromeLeft = null;
  let splitChromeCollapsed = false;
  let chromeImgEl = null; // <img> element receiving screencast frames

  function vncUrl() {
    return `http://localhost:${novncPort}/vnc.html?autoconnect=true&resize=scale&password=secret`;
  }

  function updateComputerTab() {
    const placeholder = document.getElementById('computer-placeholder');
    const frame = document.getElementById('computer-vnc-frame');
    if (!placeholder || !frame) return;
    if (novncPort) {
      placeholder.style.display = 'none';
      frame.style.display = 'block';
      if (!frame.src || !frame.src.includes(':' + novncPort + '/')) {
        frame.src = vncUrl();
      }
    } else {
      placeholder.style.display = '';
      frame.style.display = 'none';
      frame.src = '';
    }
  }

  function showSplitVnc() {
    if (splitVncWrapper || !novncPort || !currentSection) return;
    hideThinking();

    const insertionParent = resolveSectionParent(currentSection);
    const nextSib = currentSection.nextSibling;

    // Build wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'split-vnc-wrapper';

    // Header with label + toggle
    const header = document.createElement('div');
    header.className = 'split-vnc-header';
    const label = document.createElement('span');
    label.textContent = 'Live Desktop';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'split-vnc-toggle';
    toggleBtn.textContent = 'Collapse';
    toggleBtn.addEventListener('click', toggleSplitVnc);
    header.append(label, toggleBtn);

    // Body with left (entries) + right (VNC)
    const body = document.createElement('div');
    body.className = 'split-vnc-body';

    const left = document.createElement('div');
    left.className = 'split-vnc-left';

    const right = document.createElement('div');
    right.className = 'split-vnc-right';
    const iframe = document.createElement('iframe');
    iframe.src = vncUrl();
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    right.appendChild(iframe);

    body.append(left, right);
    wrapper.append(header, body);

    // Move the current section into the left column
    left.appendChild(currentSection);

    // Insert wrapper where the section was
    safeInsertBefore(insertionParent, wrapper, nextSib);

    splitVncWrapper = wrapper;
    splitVncLeft = left;
    splitVncCollapsed = false;
    autoScroll();
  }

  function toggleSplitVnc() {
    if (!splitVncWrapper) return;
    splitVncCollapsed = !splitVncCollapsed;
    if (splitVncCollapsed) {
      splitVncWrapper.classList.add('split-vnc-collapsed');
      splitVncWrapper.querySelector('.split-vnc-toggle').textContent = 'Show Desktop';
    } else {
      splitVncWrapper.classList.remove('split-vnc-collapsed');
      splitVncWrapper.querySelector('.split-vnc-toggle').textContent = 'Collapse';
    }
  }

  function teardownSplitVnc(leaveBar) {
    if (!splitVncWrapper) return;
    const wrapperParent = splitVncWrapper.parentNode || messagesEl;

    // Move all children from the left column back into #messages before the wrapper.
    // Track the last moved child so we can place the bar right after it.
    let lastMoved = null;
    if (splitVncLeft) {
      while (splitVncLeft.firstChild) {
        lastMoved = splitVncLeft.firstChild;
        safeInsertBefore(wrapperParent, lastMoved, splitVncWrapper);
      }
    }

    if (leaveBar && novncPort && lastMoved) {
      // Insert bar right after the last agent section (not at end of chat)
      const bar = document.createElement('div');
      bar.className = 'split-vnc-bar';
      bar.innerHTML = '<span>\u25b6 Show Desktop</span>';
      bar.addEventListener('click', () => {
        if (!novncPort) return;
        // Show VNC iframe after the bar
        const frame = document.createElement('div');
        frame.className = 'inline-vnc-wrapper';
        const hdr = document.createElement('div');
        hdr.className = 'split-vnc-header';
        const lbl = document.createElement('span');
        lbl.textContent = 'Desktop Snapshot';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'split-vnc-toggle';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => {
          frame.remove();
          bar.style.display = '';  // Show the bar again
        });
        hdr.append(lbl, closeBtn);
        const ifr = document.createElement('iframe');
        ifr.className = 'inline-vnc-frame';
        ifr.src = vncUrl();
        ifr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
        frame.append(hdr, ifr);
        bar.style.display = 'none';  // Hide bar while frame is open
        bar.insertAdjacentElement('afterend', frame);
      });
      lastMoved.insertAdjacentElement('afterend', bar);
      // Insert a thumbnail screenshot of the desktop at this point in the chat
      const canvas = splitVncWrapper.querySelector('canvas');
      if (canvas) {
        try {
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          if (dataUrl && dataUrl.startsWith('data:')) {
            const thumb = document.createElement('img');
            thumb.src = dataUrl;
            thumb.className = 'chat-screenshot';
            thumb.alt = 'Desktop screenshot';
            bar.insertAdjacentElement('afterend', thumb);
            vscode.postMessage({ type: 'logChatEntry', entry: { type: 'chatScreenshot', data: dataUrl, alt: 'Desktop screenshot' } });
          }
        } catch {}
      }
      splitVncWrapper.remove();
    } else {
      splitVncWrapper.remove();
    }

    splitVncWrapper = null;
    splitVncLeft = null;
    splitVncCollapsed = false;
  }

  // ── Chrome screencast (Browser tab + split widget) ───────────────────

  function updateAgentBrowserToggle(target) {
    if (!agentBrowserToggleWrap || !agentBrowserToggle) return;
    const resolvedTarget = target || (cfgChatTarget ? cfgChatTarget.value : '');
    const agentId = agentIdForTarget(resolvedTarget);
    const agent = agentForTarget(resolvedTarget);
    if (!agentId || !agentSupportsBrowserToggle(agent)) {
      agentBrowserToggleWrap.style.display = 'none';
      agentBrowserToggle.checked = false;
      return;
    }
    agentBrowserToggleWrap.style.display = 'inline-flex';
    agentBrowserToggle.checked = effectiveAgentBrowserEnabled(agentId);
  }

  function updateBrowserStatus() {
    const el = document.getElementById('browser-status');
    if (!el) return;
    if (chromePort) {
      el.classList.add('online');
    } else {
      el.classList.remove('online');
    }
    const target = cfgChatTarget ? cfgChatTarget.value : '';
    if (target.startsWith('agent-')) {
      const agentId = agentIdForTarget(target);
      const agent = agentForTarget(target);
      const needsChrome = !!agentId && agentSupportsBrowserToggle(agent) && effectiveAgentBrowserEnabled(agentId);
      el.style.display = needsChrome ? 'inline-flex' : 'none';
    } else {
      el.style.display = 'none';
    }
  }

  function updateBrowserTab() {
    const placeholder = document.getElementById('browser-placeholder');
    const frame = document.getElementById('browser-chrome-frame');
    if (!placeholder || !frame) return;
    if (chromePort) {
      placeholder.style.display = 'none';
      frame.style.display = 'block';
    } else {
      placeholder.innerHTML = '<p>No Chrome instance linked to this session.</p><p><small>Click this tab to start a headless Chrome instance.</small></p>';
      placeholder.style.display = '';
      frame.style.display = 'none';
    }
  }

  function showSplitChrome() {
    if (splitChromeWrapper || !chromePort || !currentSection) return;
    hideThinking();

    const insertionParent = resolveSectionParent(currentSection);
    const nextSib = currentSection.nextSibling;
    const wrapper = document.createElement('div');
    wrapper.className = 'split-vnc-wrapper';

    const header = document.createElement('div');
    header.className = 'split-vnc-header';
    const label = document.createElement('span');
    label.textContent = 'Live Browser';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'split-vnc-toggle';
    toggleBtn.textContent = 'Collapse';
    toggleBtn.addEventListener('click', toggleSplitChrome);
    header.append(label, toggleBtn);

    const body = document.createElement('div');
    body.className = 'split-vnc-body';

    const left = document.createElement('div');
    left.className = 'split-vnc-left';

    const right = document.createElement('div');
    right.className = 'split-vnc-right';
    chromeImgEl = document.createElement('img');
    chromeImgEl.className = 'chrome-screencast-img';
    chromeImgEl.alt = 'Chrome Screencast';
    chromeImgEl.tabIndex = 0;
    // Initialize with current frame from Browser tab if available
    const existingFrame = document.getElementById('browser-chrome-frame');
    if (existingFrame && existingFrame.src) chromeImgEl.src = existingFrame.src;
    attachChromeInputListeners(chromeImgEl);
    right.appendChild(chromeImgEl);

    body.append(left, right);
    wrapper.append(header, body);

    left.appendChild(currentSection);

    safeInsertBefore(insertionParent, wrapper, nextSib);

    splitChromeWrapper = wrapper;
    splitChromeLeft = left;
    splitChromeCollapsed = false;
    autoScroll();
  }

  function toggleSplitChrome() {
    if (!splitChromeWrapper) return;
    splitChromeCollapsed = !splitChromeCollapsed;
    if (splitChromeCollapsed) {
      splitChromeWrapper.classList.add('split-vnc-collapsed');
      splitChromeWrapper.querySelector('.split-vnc-toggle').textContent = 'Show Browser';
    } else {
      splitChromeWrapper.classList.remove('split-vnc-collapsed');
      splitChromeWrapper.querySelector('.split-vnc-toggle').textContent = 'Collapse';
    }
  }

  function teardownSplitChrome(leaveBar) {
    if (!splitChromeWrapper) return;
    const wrapperParent = splitChromeWrapper.parentNode || messagesEl;

    let lastMoved = null;
    if (splitChromeLeft) {
      while (splitChromeLeft.firstChild) {
        lastMoved = splitChromeLeft.firstChild;
        safeInsertBefore(wrapperParent, lastMoved, splitChromeWrapper);
      }
    }

    if (leaveBar && chromePort && lastMoved) {
      const bar = document.createElement('div');
      bar.className = 'split-vnc-bar';
      bar.innerHTML = '<span>\u25b6 Show Browser</span>';
      bar.addEventListener('click', () => {
        if (!chromePort) return;
        const frame = document.createElement('div');
        frame.className = 'inline-vnc-wrapper';
        const hdr = document.createElement('div');
        hdr.className = 'split-vnc-header';
        const lbl = document.createElement('span');
        lbl.textContent = 'Browser Snapshot';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'split-vnc-toggle';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => {
          frame.remove();
          bar.style.display = '';
        });
        hdr.append(lbl, closeBtn);
        const img = document.createElement('img');
        img.className = 'inline-vnc-frame';
        img.style.height = '400px';
        img.style.objectFit = 'contain';
        img.alt = 'Chrome Snapshot';
        // Use the last received frame from the Browser tab
        const tabImg = document.getElementById('browser-chrome-frame');
        if (tabImg && tabImg.src) img.src = tabImg.src;
        frame.append(hdr, img);
        bar.style.display = 'none';
        bar.insertAdjacentElement('afterend', frame);
      });
      lastMoved.insertAdjacentElement('afterend', bar);
      // Insert a thumbnail screenshot of the browser at this point in the chat
      const tabFrame = document.getElementById('browser-chrome-frame');
      const frameSrc = (chromeImgEl && chromeImgEl.src) || (tabFrame && tabFrame.src);
      if (frameSrc && frameSrc.startsWith('data:')) {
        const thumb = document.createElement('img');
        thumb.src = frameSrc;
        thumb.className = 'chat-screenshot';
        thumb.alt = 'Browser screenshot';
        bar.insertAdjacentElement('afterend', thumb);
        // Log to chat.jsonl for restore
        vscode.postMessage({ type: 'logChatEntry', entry: { type: 'chatScreenshot', data: frameSrc, alt: 'Browser screenshot' } });
      }
      splitChromeWrapper.remove();
    } else {
      splitChromeWrapper.remove();
    }

    splitChromeWrapper = null;
    splitChromeLeft = null;
    splitChromeCollapsed = false;
    chromeImgEl = null;
    // Force scroll to bottom — layout changed so shouldAutoScroll() would give wrong result
    requestAnimationFrame(scrollToBottom);
  }

  // ── Chrome Input Forwarding ──────────────────────────────────────────

  // Updated from screencast metadata each frame
  let chromeMeta = { deviceWidth: 1280, deviceHeight: 720, offsetTop: 0, pageScaleFactor: 1 };

  function chromeCoords(imgEl, clientX, clientY) {
    const rect = imgEl.getBoundingClientRect();
    // Use the image's actual rendered pixel dimensions (naturalWidth/Height)
    const natW = imgEl.naturalWidth || chromeMeta.deviceWidth;
    const natH = imgEl.naturalHeight || chromeMeta.deviceHeight;
    const imgAspect = natW / natH;
    const elAspect = rect.width / rect.height;
    let renderW, renderH, offsetX, offsetY;
    if (elAspect > imgAspect) {
      // Pillarboxed (extra space on left/right)
      renderH = rect.height;
      renderW = renderH * imgAspect;
      offsetX = (rect.width - renderW) / 2;
      offsetY = 0;
    } else {
      // Letterboxed (extra space on top/bottom)
      renderW = rect.width;
      renderH = renderW / imgAspect;
      offsetX = 0;
      offsetY = (rect.height - renderH) / 2;
    }
    // Map from rendered image position to Chrome's device coordinates
    const x = Math.round(((clientX - rect.left - offsetX) / renderW) * chromeMeta.deviceWidth);
    const y = Math.round(((clientY - rect.top - offsetY) / renderH) * chromeMeta.deviceHeight);
    return {
      x: Math.max(0, Math.min(chromeMeta.deviceWidth, x)),
      y: Math.max(0, Math.min(chromeMeta.deviceHeight, y)),
    };
  }

  function chromeMouseFlags(e) {
    let button = 'none';
    if (e.button === 0) button = 'left';
    else if (e.button === 1) button = 'middle';
    else if (e.button === 2) button = 'right';
    let buttons = 0;
    if (e.buttons & 1) buttons |= 1;
    if (e.buttons & 2) buttons |= 2;
    if (e.buttons & 4) buttons |= 4;
    return { button, buttons };
  }

  function sendChromeInput(cdpMethod, cdpParams) {
    vscode.postMessage({ type: 'chromeInput', cdpMethod, cdpParams });
  }

  function attachChromeInputListeners(imgEl) {
    imgEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      imgEl.focus();
      const { x, y } = chromeCoords(imgEl, e.clientX, e.clientY);
      const { button, buttons } = chromeMouseFlags(e);
      sendChromeInput('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, buttons, clickCount: 1,
        modifiers: chromeModifiers(e),
      });
    });

    imgEl.addEventListener('mouseup', (e) => {
      e.preventDefault();
      const { x, y } = chromeCoords(imgEl, e.clientX, e.clientY);
      const { button, buttons } = chromeMouseFlags(e);
      sendChromeInput('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, buttons, clickCount: 1,
        modifiers: chromeModifiers(e),
      });
    });

    imgEl.addEventListener('mousemove', (e) => {
      const { x, y } = chromeCoords(imgEl, e.clientX, e.clientY);
      sendChromeInput('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'none', buttons: 0,
        modifiers: chromeModifiers(e),
      });
    });

    imgEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = chromeCoords(imgEl, e.clientX, e.clientY);
      sendChromeInput('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY,
        modifiers: chromeModifiers(e),
      });
    }, { passive: false });

    imgEl.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendChromeInput('Input.dispatchKeyEvent', chromeKeyParams('keyDown', e));
    });

    imgEl.addEventListener('keyup', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendChromeInput('Input.dispatchKeyEvent', chromeKeyParams('keyUp', e));
    });

    imgEl.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function chromeModifiers(e) {
    let m = 0;
    if (e.altKey) m |= 1;
    if (e.ctrlKey) m |= 2;
    if (e.metaKey) m |= 4;
    if (e.shiftKey) m |= 8;
    return m;
  }

  function chromeKeyParams(type, e) {
    return {
      type,
      modifiers: chromeModifiers(e),
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      text: type === 'keyDown' && e.key.length === 1 ? e.key : undefined,
      unmodifiedText: type === 'keyDown' && e.key.length === 1 ? e.key : undefined,
    };
  }

  // Attach to Browser tab image
  const browserFrame = document.getElementById('browser-chrome-frame');
  if (browserFrame) attachChromeInputListeners(browserFrame);

  // ── Browser Navigation Bar ─────────────────────────────────────────

  function showBrowserNav() {
    const nav = document.getElementById('browser-nav');
    if (nav) nav.style.display = '';
  }
  function hideBrowserNav() {
    const nav = document.getElementById('browser-nav');
    if (nav) nav.style.display = 'none';
  }

  function browserNavigate(url) {
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    _dbg(`browserNavigate: chromePort=${chromePort || 'null'} url=${url}`);
    sendChromeInput('Page.navigate', { url });
  }

  const browserUrlInput = document.getElementById('browser-url');
  const browserGoBtn = document.getElementById('browser-go');
  const browserBackBtn = document.getElementById('browser-back');
  const browserForwardBtn = document.getElementById('browser-forward');
  const browserReloadBtn = document.getElementById('browser-reload');

  if (browserUrlInput) {
    browserUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        browserNavigate(browserUrlInput.value.trim());
        browserFrame && browserFrame.focus();
      }
      // Don't let key events propagate to Chrome input listeners
      e.stopPropagation();
    });
    browserUrlInput.addEventListener('keyup', (e) => e.stopPropagation());
  }
  if (browserGoBtn) {
    browserGoBtn.addEventListener('click', () => {
      browserNavigate(browserUrlInput && browserUrlInput.value.trim());
      browserFrame && browserFrame.focus();
    });
  }
  if (browserBackBtn) {
    browserBackBtn.addEventListener('click', () => sendChromeInput('Runtime.evaluate', { expression: 'history.back()' }));
  }
  if (browserForwardBtn) {
    browserForwardBtn.addEventListener('click', () => sendChromeInput('Runtime.evaluate', { expression: 'history.forward()' }));
  }
  if (browserReloadBtn) {
    browserReloadBtn.addEventListener('click', () => sendChromeInput('Page.reload', {}));
  }

  // ── Instance Management ──────────────────────────────────────────────
  let instancesList = [];
  let instancesLoading = false;
  let instancesActionId = 0;
  let useSnapshot = false;
  let workspaceSnapshotExists = false;
  let workspaceSnapshotTag = '';

  function setInstancesLoading(loading, actionId) {
    // If clearing the loader, only do so if this response matches the current action
    if (!loading && actionId !== undefined && actionId !== instancesActionId) return;
    instancesLoading = loading;
    const listEl = document.getElementById('instance-list');
    const overlay = document.getElementById('instance-loading');
    if (!listEl) return;
    if (loading) {
      if (!overlay) {
        const el = document.createElement('div');
        el.id = 'instance-loading';
        el.className = 'instance-loading-overlay';
        el.innerHTML = '<div class="instance-spinner"></div><span>Working...</span>';
        listEl.parentElement.style.position = 'relative';
        listEl.parentElement.appendChild(el);
      }
      // Disable all buttons in the tab
      document.querySelectorAll('#tab-instances button').forEach(b => { b.disabled = true; });
    } else {
      const el = document.getElementById('instance-loading');
      if (el) el.remove();
      document.querySelectorAll('#tab-instances button').forEach(b => { b.disabled = false; });
    }
  }

  function instanceAction(msgType, extra) {
    if (instancesLoading) return;
    instancesActionId++;
    setInstancesLoading(true);
    vscode.postMessage({ type: msgType, ...extra, _actionId: instancesActionId });
  }

  function renderInstances() {
    const listEl = document.getElementById('instance-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    // Check if this session has a linked container
    const hasLinked = instancesList.some(i => i.isLinked);

    // Update snapshot status row in header
    const snapInfoEl = document.getElementById('snapshot-info');
    if (snapInfoEl) {
      snapInfoEl.innerHTML = '';
      if (workspaceSnapshotExists) {
        const badge = document.createElement('span');
        badge.className = 'instance-snapshot-badge';
        badge.textContent = 'snapshot saved';
        badge.title = workspaceSnapshotTag;
        const delBtn = document.createElement('button');
        delBtn.className = 'mcp-btn mcp-btn-del-snapshot';
        delBtn.textContent = 'Delete snapshot';
        delBtn.style.fontSize = '11px';
        delBtn.addEventListener('click', () => instanceAction('instanceSnapshotDelete', { name: '_workspace_' }));
        snapInfoEl.append(badge, delBtn);
      }
    }

    if (instancesList.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mcp-empty';
      empty.innerHTML = 'No instances running.<br><small>Use a qa-remote-* agent to auto-start, or click "Start for this session" above.</small>';
      listEl.appendChild(empty);
      return;
    }

    for (const inst of instancesList) {
      const card = document.createElement('div');
      card.className = 'mcp-card' + (inst.isLinked ? ' instance-linked' : '');

      const header = document.createElement('div');
      header.className = 'mcp-card-header';
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';

      const statusBadge = document.createElement('span');
      const isUp = inst.status && inst.status.toLowerCase().startsWith('up');
      statusBadge.className = 'instance-status ' + (isUp ? 'instance-status-up' : 'instance-status-down');
      statusBadge.textContent = isUp ? 'Up' : 'Down';

      const nameEl = document.createElement('span');
      nameEl.className = 'mcp-name';
      nameEl.style.flex = '1';
      nameEl.textContent = inst.name;
      if (inst.isLinked) {
        const badge = document.createElement('span');
        badge.className = 'instance-session-badge';
        badge.textContent = 'this session';
        nameEl.appendChild(document.createTextNode(' '));
        nameEl.appendChild(badge);
      }
      if (inst.snapshotExists) {
        const snapBadge = document.createElement('span');
        snapBadge.className = 'instance-snapshot-badge';
        snapBadge.textContent = 'snapshot';
        nameEl.appendChild(document.createTextNode(' '));
        nameEl.appendChild(snapBadge);
      }

      const actions = document.createElement('span');
      actions.style.display = 'flex';
      actions.style.gap = '4px';

      const vncBtn = document.createElement('button');
      vncBtn.className = 'mcp-btn';
      vncBtn.textContent = 'Open VNC';
      vncBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'instanceOpenVnc', novncPort: inst.novnc_port });
      });

      const snapBtn = document.createElement('button');
      snapBtn.className = 'mcp-btn mcp-btn-snapshot';
      snapBtn.textContent = 'Snapshot';
      snapBtn.title = inst.snapshotExists ? 'Overwrite existing snapshot' : 'Save container state as snapshot';
      snapBtn.addEventListener('click', () => instanceAction('instanceSnapshot', { name: inst.name }));

      if (inst.snapshotExists) {
        const delSnapBtn = document.createElement('button');
        delSnapBtn.className = 'mcp-btn mcp-btn-del-snapshot';
        delSnapBtn.textContent = 'Del snapshot';
        delSnapBtn.addEventListener('click', () => instanceAction('instanceSnapshotDelete', { name: inst.name }));
        actions.append(vncBtn, snapBtn, delSnapBtn);
      } else {
        actions.append(vncBtn, snapBtn);
      }

      const restartBtn = document.createElement('button');
      restartBtn.className = 'mcp-btn';
      restartBtn.textContent = 'Restart';
      restartBtn.addEventListener('click', () => instanceAction('instanceRestart', { name: inst.name }));

      const stopBtn = document.createElement('button');
      stopBtn.className = 'mcp-btn mcp-btn-danger';
      stopBtn.textContent = 'Stop';
      stopBtn.addEventListener('click', () => instanceAction('instanceStop', { name: inst.name }));

      actions.append(restartBtn, stopBtn);
      header.append(statusBadge, nameEl, actions);

      const details = document.createElement('div');
      details.className = 'instance-details';
      details.innerHTML =
        '<span class="instance-detail-label">API:</span> ' + inst.api_port +
        ' &nbsp; <span class="instance-detail-label">VNC:</span> ' + inst.vnc_port +
        ' &nbsp; <span class="instance-detail-label">noVNC:</span> ' + inst.novnc_port +
        (inst.container_id ? ' &nbsp; <span class="instance-detail-label">ID:</span> ' + inst.container_id : '');

      card.append(header, details);
      listEl.appendChild(card);
    }

    // Update the "Start for this session" button text based on whether we have a linked instance
    const startBtn = document.querySelector('.instance-action-btn[data-action="start"]');
    if (startBtn) {
      startBtn.textContent = hasLinked ? 'Restart this session' : 'Start for this session';
      startBtn.dataset.action = hasLinked ? 'restartLinked' : 'start';
    }
  }

  // Toolbar buttons
  const instancesTab = document.getElementById('tab-instances');
  if (instancesTab) {
    instancesTab.addEventListener('click', (e) => {
      const btn = e.target.closest('.instance-action-btn');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      if (action === 'start') instanceAction('instanceStart');
      if (action === 'restartLinked') instanceAction('instanceStart');
      if (action === 'stopAll') instanceAction('instanceStopAll');
      if (action === 'restartAll') instanceAction('instanceRestartAll');
    });
  }

  // Use-snapshot checkbox
  document.getElementById('use-snapshot-checkbox')?.addEventListener('change', (e) => {
    vscode.postMessage({ type: 'instanceSettingsSave', useSnapshot: e.target.checked });
  });

  // Config dropdowns
  const cfgControllerModel = document.getElementById('cfg-controller-model');
  const cfgControllerThinking = document.getElementById('cfg-controller-thinking');
  const cfgWorkerModel = document.getElementById('cfg-worker-model');
  const cfgWorkerThinking = document.getElementById('cfg-worker-thinking');
  const cfgChatTarget = document.getElementById('cfg-chat-target');
  const cfgControllerCli = document.getElementById('cfg-controller-cli');
  const cfgCodexMode = document.getElementById('cfg-codex-mode');
  const cfgWorkerCli = document.getElementById('cfg-worker-cli');
  const cfgWaitDelay = document.getElementById('cfg-wait-delay');
  const agentBrowserToggleWrap = document.getElementById('agent-browser-toggle-wrap');
  const agentBrowserToggle = document.getElementById('agent-browser-toggle');
  const usageSummaryEl = document.getElementById('usage-summary');
  const usageSummaryCostEl = document.getElementById('usage-summary-cost');
  const usageSummaryTokensEl = document.getElementById('usage-summary-tokens');
  const usageSummaryActorsEl = document.getElementById('usage-summary-actors');

  // ── Persisted state ─────────────────────────────────────────────────
  // messageLog: array of message objects replayed on restore
  // runId: currently attached run id
  const USER_MESSAGE_COLLAPSE_MAX_LINES = 50;
  const VISIBLE_HISTORY_MAX_CHARS = 50_000;
  const VISIBLE_HISTORY_TRUNCATION_BANNER = 'Showing only the latest chat tail for this run.';
  const VISIBLE_HISTORY_SCREENSHOT_PLACEHOLDER = '[Screenshot]';
  const VISIBLE_HISTORY_CARD_PLACEHOLDER = '[Card]';
  const TEST_CARD_CONFETTI_DEDUPE_MS = 10_000;
  let messageLog = [];
  let currentRunId = null;
  let currentUsageSummary = null;
  let currentWorkspace = null;
  let currentResumeToken = null;
  let currentRootIdentity = null;
  let pendingVisibleHistoryTrim = false;
  let suppressCelebrationEffects = 0;
  const recentCelebratedTestCards = new Map();
  let reviewState = {
    visible: false,
    isGitRepo: false,
    hasUnstaged: false,
    hasStaged: false,
    defaultScope: null,
    unstagedCount: 0,
    stagedCount: 0,
  };
  let importChatPickerState = null;
  let importChatSearchTimer = null;
  let importChatSearchSeq = 0;

  function clearImportChatSearchTimer() {
    if (importChatSearchTimer) {
      clearTimeout(importChatSearchTimer);
      importChatSearchTimer = null;
    }
  }

  function closeImportChatPicker() {
    clearImportChatSearchTimer();
    if (importChatPickerState && importChatPickerState.container && importChatPickerState.container.parentNode) {
      importChatPickerState.container.parentNode.removeChild(importChatPickerState.container);
    }
    importChatPickerState = null;
  }

  function nextImportChatSearchRequestId() {
    importChatSearchSeq += 1;
    return 'import-chat-search-' + importChatSearchSeq;
  }

  function queueImportChatSearch(state, query) {
    if (!state) return;
    clearImportChatSearchTimer();
    var requestId = nextImportChatSearchRequestId();
    state.lastRequestId = requestId;
    importChatSearchTimer = setTimeout(function() {
      vscode.postMessage({
        type: 'searchImportChats',
        provider: state.provider || null,
        query: String(query || ''),
        requestId: requestId,
      });
    }, 180);
  }

  function importChatSearchPlaceholder(provider) {
    if (provider === 'codex') return 'Search Codex chat messages...';
    if (provider === 'claude') return 'Search Claude chat messages...';
    return 'Search imported chat messages...';
  }

  function formatUsageUsd(value, available) {
    if (!available) return 'n/a';
    var numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return 'n/a';
    if (numeric >= 1) return '$' + numeric.toFixed(2);
    return '$' + numeric.toFixed(4);
  }

  function formatUsageTokens(value) {
    var numeric = Number(value || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return '0';
    if (numeric >= 1000000) return (numeric / 1000000).toFixed(numeric >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (numeric >= 1000) return (numeric / 1000).toFixed(numeric >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(Math.round(numeric));
  }

  function usagePillHtml(label, value, modifier) {
    return (
      '<span class="usage-pill' + (modifier ? ' usage-pill-' + modifier : '') + '">' +
        '<span class="usage-pill-label">' + escapeHtml(label) + '</span> ' +
        '<span class="usage-pill-value">' + escapeHtml(value) + '</span>' +
      '</span>'
    );
  }

  function usagePillRowHtml(pills) {
    return pills.filter(Boolean).join('<span class="usage-summary-separator" aria-hidden="true">|</span>');
  }

  function actorHasUsage(actor) {
    if (!actor) return false;
    return !!(
      Number(actor.promptTokens || 0) > 0 ||
      Number(actor.completionTokens || 0) > 0 ||
      Number(actor.cachedTokens || 0) > 0 ||
      Number(actor.cacheWriteTokens || 0) > 0 ||
      actor.costAvailable
    );
  }

  function renderUsageSummary(summary) {
    currentUsageSummary = summary || null;
    if (!usageSummaryEl || !usageSummaryCostEl || !usageSummaryTokensEl || !usageSummaryActorsEl) return;

    var controller = summary && summary.byActor ? summary.byActor.controller || null : null;
    var worker = summary && summary.byActor ? summary.byActor.worker || null : null;
    var hasData = !!(
      summary &&
      (
        actorHasUsage(controller) ||
        actorHasUsage(worker) ||
        Number(summary.promptTokens || 0) > 0 ||
        Number(summary.completionTokens || 0) > 0 ||
        Number(summary.cachedTokens || 0) > 0 ||
        Number(summary.cacheWriteTokens || 0) > 0 ||
        summary.costAvailable
      )
    );
    if (!hasData) {
      usageSummaryEl.classList.add('hidden');
      usageSummaryCostEl.innerHTML = '';
      usageSummaryTokensEl.innerHTML = '';
      usageSummaryActorsEl.innerHTML = '';
      return;
    }

    usageSummaryCostEl.innerHTML = usagePillRowHtml([
      usagePillHtml('Cost', formatUsageUsd(summary.totalCostUsd, summary.costAvailable), 'cost'),
      usagePillHtml('Prompt', formatUsageUsd(summary.promptCostUsd, summary.costAvailable), 'prompt'),
      usagePillHtml('Completion', formatUsageUsd(summary.completionCostUsd, summary.costAvailable), 'completion')
    ]);
    usageSummaryTokensEl.innerHTML = usagePillRowHtml([
      usagePillHtml('Tokens', formatUsageTokens(summary.promptTokens) + ' in', 'token'),
      usagePillHtml('Output', formatUsageTokens(summary.completionTokens) + ' out', 'token'),
      usagePillHtml('Cached', formatUsageTokens(summary.cachedTokens), 'token'),
      usagePillHtml('Writes', formatUsageTokens(summary.cacheWriteTokens), 'token')
    ]);

    var showActorLine = actorHasUsage(controller) && actorHasUsage(worker);
    if (showActorLine) {
      var actorCostAvailable = !!(
        (controller && controller.costAvailable) ||
        (worker && worker.costAvailable)
      );
      usageSummaryActorsEl.innerHTML = actorCostAvailable
        ? usagePillRowHtml([
          usagePillHtml('Worker', formatUsageUsd(worker.totalCostUsd, !!(worker && worker.costAvailable)), 'actor'),
          usagePillHtml('Orchestrator', formatUsageUsd(controller.totalCostUsd, !!(controller && controller.costAvailable)), 'actor')
        ])
        : usagePillRowHtml([
          usagePillHtml('Worker In', formatUsageTokens(worker && worker.promptTokens), 'actor'),
          usagePillHtml('Orchestrator In', formatUsageTokens(controller && controller.promptTokens), 'actor')
        ]);
      usageSummaryActorsEl.style.display = '';
    } else {
      usageSummaryActorsEl.innerHTML = '';
      usageSummaryActorsEl.style.display = 'none';
    }

    usageSummaryEl.classList.remove('hidden');
  }

  function saveState() {
    // Persist run ID, config, and desktop info per panel. Chat history is
    // restored from transcript.jsonl on disk, so messageLog is NOT persisted.
    const state = { runId: currentRunId, config: getConfig() };
    if (novncPort) state.novncPort = novncPort;
    if (panelId) state.panelId = panelId;
    if (currentWorkspace) state.workspace = currentWorkspace;
    if (currentResumeToken) state.resume = currentResumeToken;
    if (currentRootIdentity) state.rootIdentity = currentRootIdentity;
    _dbg('saveState: ' + JSON.stringify({
      runId: state.runId || null,
      panelId: state.panelId || null,
      workspace: state.workspace || null,
      resume: state.resume || null,
      rootIdentity: state.rootIdentity || null,
      chatTarget: state.config && state.config.chatTarget || null,
    }));
    vscode.setState(state);
  }

  function currentAgentLaunchToken() {
    const pendingTarget = _pendingChatTarget || null;
    const config = getConfig();
    const target = pendingTarget || (config && config.chatTarget ? config.chatTarget : 'controller');
    if (!target || target === 'controller' || target === 'claude') return target || 'controller';
    if (target.startsWith('agent-')) return target.slice('agent-'.length);
    return target;
  }

  function normalizeLaunchTarget(agent) {
    const value = String(agent || '').trim();
    if (!value) return null;
    if (value === 'controller' || value === 'claude') return value;
    return value.startsWith('agent-') ? value : ('agent-' + value);
  }

  function parseWorkspaceLaunchFromUrl() {
    try {
      const params = new URLSearchParams(location.search || '');
      const match = /^\/w\/([^/?#]+)/.exec(location.pathname || '');
      const workspace = match ? decodeURIComponent(match[1]) : null;
      return {
        workspace,
        resume: params.get('resume') || null,
        agent: params.get('agent') || null,
        rootIdentity: workspace ? `workspace:${String(workspace).trim().toLowerCase()}` : null,
      };
    } catch (_) {
      return { workspace: null, resume: null, agent: null, rootIdentity: null };
    }
  }

  function _reviewScopeAvailable(scope) {
    if (!reviewState) return false;
    if (scope === 'unstaged') return !!reviewState.hasUnstaged;
    if (scope === 'staged') return !!reviewState.hasStaged;
    if (scope === 'both') return !!(reviewState.hasUnstaged && reviewState.hasStaged);
    return false;
  }

  function _defaultReviewScope() {
    if (reviewState && _reviewScopeAvailable(reviewState.defaultScope)) return reviewState.defaultScope;
    if (_reviewScopeAvailable('unstaged')) return 'unstaged';
    if (_reviewScopeAvailable('staged')) return 'staged';
    if (_reviewScopeAvailable('both')) return 'both';
    return null;
  }

  function hideReviewMenu() {
    if (reviewMenu) reviewMenu.style.display = 'none';
    if (reviewSplit) reviewSplit.classList.remove('menu-open');
    if (btnReviewMenu) btnReviewMenu.setAttribute('aria-expanded', 'false');
  }

  function renderReviewControls() {
    if (!reviewSplit) return;
    const visible = !!(reviewState && reviewState.visible);
    reviewSplit.style.display = visible && !isRunning ? 'inline-flex' : 'none';
    if (!visible || isRunning) {
      hideReviewMenu();
      return;
    }

    const defaultScope = _defaultReviewScope();
    const summary = [];
    if (reviewState.hasUnstaged) summary.push(`unstaged ${reviewState.unstagedCount || 0}`);
    if (reviewState.hasStaged) summary.push(`staged ${reviewState.stagedCount || 0}`);
    const title = summary.length > 0
      ? `Review current git changes (${summary.join(', ')})`
      : 'Review current git changes';

    if (btnReview) {
      btnReview.disabled = !defaultScope;
      btnReview.title = title;
    }
    if (btnReviewMenu) {
      const anyMenuScope = _reviewScopeAvailable('unstaged') || _reviewScopeAvailable('staged') || _reviewScopeAvailable('both');
      btnReviewMenu.disabled = !anyMenuScope;
      btnReviewMenu.title = title;
    }
    if (reviewMenu) {
      reviewMenu.querySelectorAll('.split-action-item[data-scope]').forEach((btn) => {
        const scope = btn.getAttribute('data-scope');
        btn.disabled = !_reviewScopeAvailable(scope);
      });
    }
  }

  function sendReviewRequest(scope) {
    if (!_reviewScopeAvailable(scope)) return;
    const guidance = textarea ? textarea.value.trim() : '';
    if (textarea) {
      textarea.value = '';
      textarea.style.height = 'auto';
    }
    suggestionsEl.style.display = 'none';
    hideReviewMenu();
    vscode.postMessage({ type: 'reviewRequest', scope, guidance });
  }

  function updateLoopObjectiveVisibility() {
    if (!loopObjectiveWrap) return;
    const visible = !!(loopToggle && loopToggle.checked);
    loopObjectiveWrap.classList.toggle('visible', visible);
  }

  function logMessage(msg) {
    // Only log messages that produce visible UI (skip transient/meta types).
    // messageLog is kept in memory for the current session but NOT persisted —
    // chat history survives reloads via transcript.jsonl on disk.
    const skipped = ['running', 'initConfig', 'syncConfig', 'rawEvent', 'setRunId', 'clearRunId', 'progressLine', 'progressFull', 'waitStatus', 'transcriptHistory', 'runHistory', 'importChatHistory', 'liveEntityCard', 'clearLiveEntityCard', 'liveQaReportCard', 'clearLiveQaReportCard', 'reviewState', 'usageStats'];
    if (skipped.includes(msg.type)) return;
    messageLog.push(msg);
  }

  function isVisibleHistoryTruncationBanner(msg) {
    return !!(msg && msg.type === 'banner' && msg.text === VISIBLE_HISTORY_TRUNCATION_BANNER);
  }

  function visibleCardSummary(msg) {
    if (!msg || typeof msg !== 'object') return VISIBLE_HISTORY_CARD_PLACEHOLDER;
    const parts = [];
    if (msg.card) parts.push(String(msg.card));
    const data = msg.data && typeof msg.data === 'object' ? msg.data : {};
    for (const key of ['title', 'name', 'text', 'status', 'summary', 'author', 'detail']) {
      if (data[key] != null && String(data[key]).trim()) {
        parts.push(String(data[key]).trim());
      }
    }
    if (!parts.length && msg.text) {
      parts.push(String(msg.text).trim());
    }
    return parts.length ? parts.join(' ') : VISIBLE_HISTORY_CARD_PLACEHOLDER;
  }

  function getUserMessageText(msg) {
    if (!msg || typeof msg !== 'object') return '';
    return String(msg.text || '');
  }

  function getUserMessageLines(text) {
    return String(text || '').split(/\r?\n/);
  }

  function isUserMessageExpanded(msg) {
    return !!(msg && typeof msg === 'object' && msg.type === 'user' && msg._userMessageExpanded);
  }

  function getUserMessageDisplayState(msg) {
    const fullText = getUserMessageText(msg);
    const lines = getUserMessageLines(fullText);
    const isLong = lines.length > USER_MESSAGE_COLLAPSE_MAX_LINES;
    return {
      fullText,
      previewText: isLong ? lines.slice(0, USER_MESSAGE_COLLAPSE_MAX_LINES).join('\n') : fullText,
      lineCount: lines.length,
      isLong,
      expanded: isLong ? isUserMessageExpanded(msg) : false,
    };
  }

  function visibleHistoryText(msg) {
    if (!msg || typeof msg !== 'object') return '';
    switch (msg.type) {
      case 'user': {
        const state = getUserMessageDisplayState(msg);
        return state.expanded ? state.fullText : state.previewText;
      }
      case 'controller':
      case 'claude':
      case 'mdLine':
      case 'line':
      case 'shell':
      case 'error':
      case 'banner':
        return String(msg.text || '');
      case 'toolCall':
        return String(msg.text || '');
      case 'stop':
        return 'STOP';
      case 'chatScreenshot':
        return VISIBLE_HISTORY_SCREENSHOT_PLACEHOLDER;
      case 'mcpCardStart':
      case 'mcpCardComplete':
        return [msg.text || '', msg.detail || ''].filter(Boolean).join(' ').trim() || VISIBLE_HISTORY_CARD_PLACEHOLDER;
      case 'mcpCard':
      case 'testCard':
      case 'bugCard':
      case 'taskCard':
      case 'qaReportCard':
        return visibleCardSummary(msg);
      default:
        return String(msg.text || msg.detail || '');
    }
  }

  function buildVisibleHistoryTail(messages, options) {
    const maxChars = options && Number.isFinite(options.maxChars)
      ? Math.max(0, Number(options.maxChars))
      : VISIBLE_HISTORY_MAX_CHARS;
    const baseMessages = (Array.isArray(messages) ? messages : []).filter((msg) => !isVisibleHistoryTruncationBanner(msg));
    if (baseMessages.length === 0) {
      return { messages: [], truncated: false, totalChars: 0 };
    }

    let start = baseMessages.length - 1;
    let totalChars = 0;
    for (let index = baseMessages.length - 1; index >= 0; index -= 1) {
      totalChars += visibleHistoryText(baseMessages[index]).length;
      start = index;
      if (totalChars >= maxChars) break;
    }

    const truncated = start > 0;
    const tail = baseMessages.slice(start);
    return {
      messages: truncated
        ? [{ type: 'banner', text: VISIBLE_HISTORY_TRUNCATION_BANNER }, ...tail]
        : tail,
      truncated,
      totalChars,
    };
  }

  function resetChatView() {
    teardownSplitVnc(false);
    teardownSplitChrome(false);
    streamingEntry = null;
    removeLiveEntityCardSlot();
    removeLiveQaReportCardSlot();
    closeQaReportOverlay();
    closeSection();
    messagesEl.innerHTML = '';
  }

  function replayVisibleHistory(messages) {
    resetChatView();
    messageLog = [];
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    suppressUiLog = true;
    try {
      withSuppressedCelebrationEffects(() => {
        for (const entry of messages) {
          const handler = handlers[entry.type];
          if (handler) {
            handler(entry);
            messageLog.push(entry);
          }
        }
      });
    } finally {
      suppressUiLog = false;
    }
  }

  function shouldDeferVisibleHistoryTrim() {
    return !!(isRunning && (splitVncWrapper || splitChromeWrapper));
  }

  function maybeTrimVisibleHistory() {
    const tail = buildVisibleHistoryTail(messageLog, { maxChars: VISIBLE_HISTORY_MAX_CHARS });
    if (!tail.truncated) {
      pendingVisibleHistoryTrim = false;
      return;
    }
    if (shouldDeferVisibleHistoryTrim()) {
      pendingVisibleHistoryTrim = true;
      return;
    }
    replayVisibleHistory(tail.messages);
    pendingVisibleHistoryTrim = false;
  }

  // ── Progress bubble helpers ───────────────────────────────────────
  function showProgressBubble() {
    if (progressBubble) progressBubble.classList.remove('hidden');
  }

  function hideProgressBubble() {
    if (progressBubble) progressBubble.classList.add('hidden');
    if (progressBody) progressBody.innerHTML = '';
  }

  function setProgressContent(text) {
    if (!progressBody) return;
    if (!text) {
      hideProgressBubble();
      return;
    }
    progressBody.innerHTML = '';
    for (const line of text.split('\n')) {
      if (line.trim()) appendProgressLine(line);
    }
  }

  function appendProgressLine(line) {
    if (!progressBody) return;
    const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)$/);
    const entry = document.createElement('div');
    entry.className = 'progress-entry';
    if (match) {
      entry.innerHTML = '<span class="progress-time">' + escapeHtml(match[1]) + '</span> ' + escapeHtml(match[2]);
    } else {
      entry.textContent = line;
    }
    progressBody.appendChild(entry);
    showProgressBubble();
    progressBody.scrollTop = progressBody.scrollHeight;
  }

  function getConfig() {
    var selectedProvider = cfgApiProvider ? cfgApiProvider.value : 'openrouter';
    return {
      controllerModel: cfgControllerModel.value === '_custom' && cfgControllerCustomModel ? cfgControllerCustomModel.value : cfgControllerModel.value,
      workerModel: cfgWorkerModel.value === '_custom' && cfgWorkerCustomModel ? cfgWorkerCustomModel.value : cfgWorkerModel.value,
      controllerThinking: cfgControllerThinking.value,
      workerThinking: cfgWorkerThinking.value,
      loopMode: loopToggle ? loopToggle.checked : false,
      loopObjective: loopObjectiveInput ? loopObjectiveInput.value : '',
      waitDelay: cfgWaitDelay ? cfgWaitDelay.value : '',
      chatTarget: cfgChatTarget ? cfgChatTarget.value : 'controller',
      controllerCli: cfgControllerCli ? cfgControllerCli.value : 'codex',
      codexMode: cfgCodexMode ? cfgCodexMode.value : 'app-server',
      workerCli: cfgWorkerCli ? cfgWorkerCli.value : 'codex',
      apiProvider: selectedProvider,
      apiBaseURL: selectedProvider === 'custom' && cfgApiBaseURL ? cfgApiBaseURL.value.trim() : '',
    };
  }

  function setSelectWithCustomValue(selectEl, customInputEl, value) {
    if (!selectEl || value === undefined) return;
    if (value === '_custom') {
      selectEl.value = '_custom';
      if (customInputEl) customInputEl.classList.toggle('visible', true);
      return;
    }
    const hasExactOption = Array.from(selectEl.options || []).some((option) => option.value === value);
    const hasCustomOption = Array.from(selectEl.options || []).some((option) => option.value === '_custom');

    if (value && !hasExactOption && hasCustomOption && customInputEl) {
      selectEl.value = '_custom';
      customInputEl.value = value;
      customInputEl.classList.toggle('visible', true);
      return;
    }

    selectEl.value = value;
    if (customInputEl && selectEl.value !== '_custom') customInputEl.classList.toggle('visible', false);
  }

  function setConfig(config) {
    if (!config) return;
    // Set CLI selectors first so updateControllerDropdowns repopulates with the right option sets
    if (config.controllerCli !== undefined && cfgControllerCli) cfgControllerCli.value = config.controllerCli;
    if (config.codexMode !== undefined && cfgCodexMode) cfgCodexMode.value = config.codexMode;
    if (config.workerCli !== undefined && cfgWorkerCli) cfgWorkerCli.value = config.workerCli;
    // Set API fields before repopulating dropdowns (provider affects model list)
    if (config.apiProvider !== undefined && cfgApiProvider) {
      repopulateProviderSelect(cfgApiProvider, config.apiProvider);
      cfgApiProvider.value = config.apiProvider;
    }
    if (config.apiBaseURL !== undefined && cfgApiBaseURL) cfgApiBaseURL.value = config.apiBaseURL || '';
    // Repopulate model/thinking options based on selected CLIs, preserving current values where possible
    updateControllerDropdowns();
    // Now set the model/thinking values (options exist after repopulate)
    var selectedProviderMeta = currentProviderMeta(cfgApiProvider ? cfgApiProvider.value : 'openrouter');
    if (config.controllerModel !== undefined && !(selectedProviderMeta && selectedProviderMeta.custom && !config.controllerModel)) {
      setSelectWithCustomValue(cfgControllerModel, cfgControllerCustomModel, config.controllerModel);
    }
    if (config.workerModel !== undefined && !(selectedProviderMeta && selectedProviderMeta.custom && !config.workerModel)) {
      setSelectWithCustomValue(cfgWorkerModel, cfgWorkerCustomModel, config.workerModel);
    }
    if (config.controllerThinking !== undefined) cfgControllerThinking.value = config.controllerThinking;
    if (config.workerThinking !== undefined) cfgWorkerThinking.value = config.workerThinking;
    if (config.loopMode !== undefined && loopToggle) loopToggle.checked = !!config.loopMode;
    if (config.loopObjective !== undefined && loopObjectiveInput) loopObjectiveInput.value = config.loopObjective || '';
    if (config.waitDelay !== undefined && cfgWaitDelay) cfgWaitDelay.value = config.waitDelay;
    const configTarget = config.chatTarget !== undefined
      ? (config.chatTarget || 'controller')
      : (cfgChatTarget ? cfgChatTarget.value : 'controller');
    if (config.agentBrowserEnabled !== undefined) {
      const agentId = agentIdForTarget(configTarget);
      if (agentId) rememberAgentBrowserOverride(agentId, !!config.agentBrowserEnabled);
    }
    syncClaudeUiVisibility(config);
    suppressTargetConfirm = true;
    if (config.chatTarget !== undefined && cfgChatTarget) {
      const desiredTarget = config.chatTarget || 'controller';
      const hasDesiredOption = Array.from(cfgChatTarget.options || []).some((option) => option.value === desiredTarget);
      if (!hasDesiredOption && desiredTarget && desiredTarget !== 'controller') {
        _pendingChatTarget = desiredTarget;
      }
      cfgChatTarget.value = config.chatTarget;
      if (config.chatTarget && config.chatTarget !== 'controller' && config.chatTarget !== 'claude') {
        hasExplicitChatTarget = true;
      }
    }
    suppressTargetConfirm = false;
    updateConfigBarForTarget(cfgChatTarget ? cfgChatTarget.value : 'controller');
    updateAgentBrowserToggle(cfgChatTarget ? cfgChatTarget.value : configTarget);
    updateLoopObjectiveVisibility();
    updateBrowserStatus();
  }

  const CODEX_MODELS = [
    { value: '', label: 'Model: default' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
    { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Spark' },
    { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
  ];
  const CODEX_THINKING = [
    { value: '', label: 'Thinking: default' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra High' },
  ];
  const CLAUDE_MODELS = [
    { value: '', label: 'Model: default' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ];
  const CLAUDE_THINKING = [
    { value: '', label: 'Thinking: default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
  ];

  // API provider model/thinking lists (loaded from extension initConfig)
  var API_PROVIDER_MODELS = {};
  var API_PROVIDER_THINKING = {};
  var API_PROVIDER_OPTIONS = [];
  var API_PROVIDER_META = {};

  function cloneCatalogOptions(options) {
    return Array.isArray(options) ? options.map(function(option) { return { value: option.value, label: option.label }; }) : [];
  }

  function defaultApiProviderOptions() {
    return [
      { id: 'openrouter', name: 'OpenRouter', catalogKey: 'openrouter', builtIn: true, custom: false, apiKeyOptional: false },
      { id: 'openai', name: 'OpenAI', catalogKey: 'openai', builtIn: true, custom: false, apiKeyOptional: false },
      { id: 'anthropic', name: 'Anthropic', catalogKey: 'anthropic', builtIn: true, custom: false, apiKeyOptional: false },
      { id: 'gemini', name: 'Google Gemini', catalogKey: 'gemini', builtIn: true, custom: false, apiKeyOptional: false },
    ];
  }

  function legacyCustomProviderMeta() {
    return {
      id: 'custom',
      name: 'Custom (legacy)',
      catalogKey: 'custom',
      builtIn: true,
      custom: false,
      legacy: true,
      apiKeyOptional: true,
    };
  }

  function withCustomModelOption(options) {
    var list = cloneCatalogOptions(options);
    if (!list.some(function(entry) { return entry && entry.value === '_custom'; })) {
      list.push({ value: '_custom', label: 'Custom...' });
    }
    return list;
  }

  function applyApiCatalog(catalog) {
    var models = (catalog && catalog.models) || {};
    var thinking = (catalog && catalog.thinking) || {};
    var providers = Array.isArray(catalog && catalog.providers) && catalog.providers.length
      ? catalog.providers
      : defaultApiProviderOptions();
    API_PROVIDER_MODELS = {};
    API_PROVIDER_THINKING = {};
    API_PROVIDER_OPTIONS = providers.map(function(provider) {
      return {
        id: provider.id,
        name: provider.name,
        catalogKey: provider.catalogKey || provider.id,
        builtIn: !!provider.builtIn,
        custom: !!provider.custom,
        apiKeyOptional: !!provider.apiKeyOptional,
      };
    });
    API_PROVIDER_META = {};
    API_PROVIDER_OPTIONS.forEach(function(provider) {
      API_PROVIDER_META[provider.id] = provider;
    });
    Object.keys(models).forEach(function(provider) {
      API_PROVIDER_MODELS[provider] = withCustomModelOption(models[provider]);
    });
    Object.keys(thinking).forEach(function(provider) {
      API_PROVIDER_THINKING[provider] = cloneCatalogOptions(thinking[provider]);
    });
    if (!API_PROVIDER_MODELS.custom) API_PROVIDER_MODELS.custom = [{ value: '_custom', label: 'Custom...' }];
    if (!API_PROVIDER_THINKING.custom) {
      API_PROVIDER_THINKING.custom = [
        { value: '', label: 'Thinking: off' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ];
    }
  }

  var cfgApiProvider = document.getElementById('cfg-api-provider');
  var cfgApiBaseURL = document.getElementById('cfg-api-base-url');
  var cfgControllerCustomModel = document.getElementById('cfg-controller-custom-model');
  var cfgWorkerCustomModel = document.getElementById('cfg-worker-custom-model');
  var cfgApiKeyWarning = document.getElementById('cfg-api-key-warning');
  var _apiKeys = {};  // { openai: '...', anthropic: '...', ... } loaded from settings
  var _customProviders = [];

  function repopulateSelect(el, options, currentValue) {
    if (!el) return;
    el.innerHTML = '';
    (options || []).forEach(function(option) {
      var opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      el.appendChild(opt);
    });
    // Restore previous value if it still exists, otherwise select first option
    if (currentValue && options.some(o => o.value === currentValue)) {
      el.value = currentValue;
    } else if (options.length > 0) {
      el.value = options[0].value;
    }
  }

  function currentProviderMeta(providerId) {
    if (providerId === 'custom') return legacyCustomProviderMeta();
    return API_PROVIDER_META[providerId] || null;
  }

  function providerLabel(providerId) {
    var meta = currentProviderMeta(providerId);
    if (meta && meta.name) return meta.name;
    return providerId || 'Provider';
  }

  function repopulateProviderSelect(selectEl, currentValue) {
    if (!selectEl) return;
    var options = API_PROVIDER_OPTIONS.length ? API_PROVIDER_OPTIONS.slice() : defaultApiProviderOptions();
    var nextValue = currentValue || '';
    selectEl.innerHTML = '';
    options.forEach(function(provider) {
      var opt = document.createElement('option');
      opt.value = provider.id;
      opt.textContent = provider.name;
      selectEl.appendChild(opt);
    });
    if (nextValue === 'custom') {
      var legacy = document.createElement('option');
      legacy.value = 'custom';
      legacy.textContent = 'Custom (legacy manual)';
      selectEl.appendChild(legacy);
    } else if (nextValue && !options.some(function(provider) { return provider.id === nextValue; })) {
      var missing = document.createElement('option');
      missing.value = nextValue;
      missing.textContent = nextValue + ' (missing)';
      selectEl.appendChild(missing);
    }
    if (nextValue) {
      selectEl.value = nextValue;
    } else if (selectEl.options.length > 0) {
      selectEl.value = selectEl.options[0].value;
    }
  }

  function effectiveModelValue(selectEl, customInputEl) {
    if (!selectEl) return '';
    if (selectEl.value === '_custom') {
      return customInputEl && customInputEl.value.trim() ? customInputEl.value.trim() : '_custom';
    }
    return selectEl.value || '';
  }

  function ensureCustomModelSelection(selectEl, customInputEl) {
    if (!selectEl) return;
    selectEl.value = '_custom';
    if (customInputEl) customInputEl.classList.toggle('visible', true);
  }

  function _modelsForCli(cli) {
    if (cli === 'api') {
      var provider = cfgApiProvider ? cfgApiProvider.value : 'openrouter';
      var providerMeta = currentProviderMeta(provider);
      var catalogKey = providerMeta && providerMeta.catalogKey ? providerMeta.catalogKey : provider;
      return API_PROVIDER_MODELS[catalogKey] || API_PROVIDER_MODELS.openrouter;
    }
    return cli === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
  }
  function _thinkingForCli(cli) {
    if (cli === 'api') {
      var provider = cfgApiProvider ? cfgApiProvider.value : 'openrouter';
      var providerMeta = currentProviderMeta(provider);
      var catalogKey = providerMeta && providerMeta.catalogKey ? providerMeta.catalogKey : provider;
      return API_PROVIDER_THINKING[catalogKey] || API_PROVIDER_THINKING.openrouter;
    }
    return cli === 'claude' ? CLAUDE_THINKING : CODEX_THINKING;
  }

  function updateControllerDropdowns() {
    const controllerCli = cfgControllerCli ? cfgControllerCli.value : 'codex';
    const workerCli = cfgWorkerCli ? cfgWorkerCli.value : 'codex';
    const selectedProvider = cfgApiProvider ? (cfgApiProvider.value || 'openrouter') : 'openrouter';
    const providerMeta = currentProviderMeta(selectedProvider);
    const previousControllerModel = effectiveModelValue(cfgControllerModel, cfgControllerCustomModel);
    const previousWorkerModel = effectiveModelValue(cfgWorkerModel, cfgWorkerCustomModel);
    const previousControllerThinking = cfgControllerThinking ? cfgControllerThinking.value : '';
    const previousWorkerThinking = cfgWorkerThinking ? cfgWorkerThinking.value : '';

    repopulateProviderSelect(cfgApiProvider, selectedProvider);

    repopulateSelect(cfgControllerModel, _modelsForCli(controllerCli), '');
    repopulateSelect(cfgControllerThinking, _thinkingForCli(controllerCli), previousControllerThinking);
    repopulateSelect(cfgWorkerModel, _modelsForCli(workerCli), '');
    repopulateSelect(cfgWorkerThinking, _thinkingForCli(workerCli), previousWorkerThinking);
    setSelectWithCustomValue(cfgControllerModel, cfgControllerCustomModel, previousControllerModel);
    setSelectWithCustomValue(cfgWorkerModel, cfgWorkerCustomModel, previousWorkerModel);
    if (controllerCli === 'api' && providerMeta && providerMeta.custom && !previousControllerModel) {
      ensureCustomModelSelection(cfgControllerModel, cfgControllerCustomModel);
    }
    if (workerCli === 'api' && providerMeta && providerMeta.custom && !previousWorkerModel) {
      ensureCustomModelSelection(cfgWorkerModel, cfgWorkerCustomModel);
    }

    // Show/hide Codex Mode dropdown based on controller CLI
    document.querySelectorAll('.cfg-codex-only').forEach(el => {
      el.classList.toggle('tab-hidden', controllerCli !== 'codex');
    });
    // Show/hide API config fields
    var useApi = controllerCli === 'api' || workerCli === 'api';
    document.querySelectorAll('.cfg-api-only').forEach(el => {
      el.classList.toggle('tab-hidden', !useApi);
    });
    var baseUrlGroup = cfgApiBaseURL ? cfgApiBaseURL.closest('.config-group') : null;
    if (baseUrlGroup) {
      baseUrlGroup.classList.toggle('tab-hidden', !useApi || !(providerMeta && providerMeta.legacy));
    }
    // Show/hide custom model text inputs
    if (cfgControllerCustomModel) {
      cfgControllerCustomModel.classList.toggle('visible', cfgControllerModel && cfgControllerModel.value === '_custom');
    }
    if (cfgWorkerCustomModel) {
      cfgWorkerCustomModel.classList.toggle('visible', cfgWorkerModel && cfgWorkerModel.value === '_custom');
    }
    // Show warning if no API key for selected provider
    if (cfgApiKeyWarning) {
      var provider = cfgApiProvider ? cfgApiProvider.value : 'openrouter';
      if (useApi && providerMeta && providerMeta.legacy && !(cfgApiBaseURL && cfgApiBaseURL.value.trim())) {
        cfgApiKeyWarning.textContent = '\u26A0\uFE0F Custom provider requires a Base URL.';
        cfgApiKeyWarning.style.display = '';
      } else if (useApi && (!providerMeta || !providerMeta.apiKeyOptional) && !_apiKeys[provider]) {
        cfgApiKeyWarning.textContent = '\u26A0\uFE0F No API key for ' + providerLabel(provider) + '. Set it in Settings \u2192 API Keys.';
        cfgApiKeyWarning.style.display = '';
      } else {
        cfgApiKeyWarning.style.display = 'none';
      }
    }
  }

  function labelForTarget(target) {
    if (!target || target === 'controller') return 'QA Panda';
    if (target === 'claude') return 'Worker (Default)';
    if (target.startsWith('agent-')) {
      const agentId = target.slice('agent-'.length);
      const allAgents = { ...agentsSystem, ...agentsGlobal, ...agentsProject };
      const agent = allAgents[agentId];
      return agent ? agent.name : agentId;
    }
    return 'QA Panda';
  }

  function updateConfigBarForTarget(target) {
    const isController = !target || target === 'controller';
    const isAgent = target && target.startsWith('agent-');
    document.querySelectorAll('.cfg-controller-only').forEach(el => el.classList.toggle('tab-hidden', !isController));
    // Worker dropdowns visible for controller + default worker, hidden for agents
    document.querySelectorAll('.cfg-worker-only').forEach(el => el.classList.toggle('tab-hidden', isAgent));
    updateAgentBrowserToggle(target);
  }

  // Saved chatTarget from vscode.getState — used to restore after dropdown is populated
  let _pendingChatTarget = null;

  function ensureSelectOption(selectEl, value, label) {
    if (!selectEl) return;
    const existing = Array.from(selectEl.options || []).find((option) => option.value === value);
    if (existing) {
      if (label) existing.textContent = label;
      return;
    }
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label || value;
    selectEl.appendChild(option);
  }

  function syncClaudeUiVisibility(desired) {
    desired = desired || {};
    const claudeEnabled = !!(_featureFlags && _featureFlags.enableClaudeCli);
    const desiredTarget = desired.chatTarget;
    const desiredControllerCli = desired.controllerCli;
    const desiredWorkerCli = desired.workerCli;

    if (cfgChatTarget) {
      const keepClaudeTarget = claudeEnabled || desiredTarget === 'claude' || _pendingChatTarget === 'claude' || cfgChatTarget.value === 'claude';
      if (keepClaudeTarget) {
        ensureSelectOption(cfgChatTarget, 'claude', 'Worker (Default)');
      } else {
        const claudeOpt = cfgChatTarget.querySelector('option[value="claude"]');
        if (claudeOpt) claudeOpt.remove();
        if (cfgChatTarget.value === 'claude') cfgChatTarget.value = 'controller';
      }
    }

    [
      { select: document.getElementById('cfg-controller-cli'), desiredValue: desiredControllerCli },
      { select: document.getElementById('cfg-worker-cli'), desiredValue: desiredWorkerCli },
    ].forEach(({ select, desiredValue }) => {
      if (!select) return;
      const keepClaude = claudeEnabled || desiredValue === 'claude' || select.value === 'claude';
      if (keepClaude) {
        ensureSelectOption(select, 'claude', 'Claude');
      } else {
        const claudeOpt = select.querySelector('option[value="claude"]');
        if (claudeOpt) claudeOpt.remove();
        if (select.value === 'claude') select.value = 'codex';
      }
    });
  }

  function refreshTargetDropdown() {
    if (!cfgChatTarget) return;
    syncClaudeUiVisibility();
    clearUnknownAgentBrowserOverrides();
    const currentValue = cfgChatTarget.value;
    // Remove existing agent options
    Array.from(cfgChatTarget.options).forEach(opt => {
      if (opt.value.startsWith('agent-')) cfgChatTarget.removeChild(opt);
    });
    // Add enabled agents (system < global < project for display, project wins for duplicates)
    const allAgents = { ...agentsSystem, ...agentsGlobal, ...agentsProject };
    for (const [id, agent] of Object.entries(allAgents)) {
      if (agent && agent.enabled !== false) {
        const opt = document.createElement('option');
        opt.value = 'agent-' + id;
        opt.textContent = agent.name || id;
        cfgChatTarget.appendChild(opt);
      }
    }
    // Restore: prefer pending saved target (from vscode.getState), then current value,
    // then QA-Browser if available, otherwise controller.
    const validValues = Array.from(cfgChatTarget.options).map(o => o.value);
    const preferred = _pendingChatTarget || currentValue;
    const defaultTarget = validValues.includes('agent-QA-Browser') ? 'agent-QA-Browser' : 'controller';
    if (_pendingChatTarget && !validValues.includes(_pendingChatTarget)) {
      hasExplicitChatTarget = false;
    }
    suppressTargetConfirm = true;
    cfgChatTarget.value = validValues.includes(preferred) ? preferred : defaultTarget;
    suppressTargetConfirm = false;
    _pendingChatTarget = null; // consumed
    updateConfigBarForTarget(cfgChatTarget.value);
    updateBrowserStatus();
  }

  function onConfigChange() {
    updateControllerDropdowns();
    const target = cfgChatTarget ? cfgChatTarget.value : 'controller';
    updateConfigBarForTarget(target);
    updateBrowserStatus();
    const config = getConfig();
    vscode.postMessage({ type: 'configChanged', config });
    vscode.postMessage({ type: 'setPanelTitle', title: labelForTarget(target) });
    saveState();
  }

  cfgControllerModel.addEventListener('change', function() {
    if (cfgControllerCustomModel) cfgControllerCustomModel.classList.toggle('visible', cfgControllerModel.value === '_custom');
    // Don't call onConfigChange (which repopulates) — just send config directly
    var config = getConfig();
    vscode.postMessage({ type: 'configChanged', config: config });
    saveState();
  });
  cfgControllerThinking.addEventListener('change', onConfigChange);
  cfgWorkerModel.addEventListener('change', function() {
    if (cfgWorkerCustomModel) cfgWorkerCustomModel.classList.toggle('visible', cfgWorkerModel.value === '_custom');
    var config = getConfig();
    vscode.postMessage({ type: 'configChanged', config: config });
    saveState();
  });
  cfgWorkerThinking.addEventListener('change', onConfigChange);
  if (cfgApiProvider) cfgApiProvider.addEventListener('change', onConfigChange);
  if (cfgApiBaseURL) cfgApiBaseURL.addEventListener('change', onConfigChange);
  if (cfgControllerCustomModel) cfgControllerCustomModel.addEventListener('change', onConfigChange);
  if (cfgWorkerCustomModel) cfgWorkerCustomModel.addEventListener('change', onConfigChange);
  if (cfgWaitDelay) cfgWaitDelay.addEventListener('change', onConfigChange);
  if (cfgChatTarget) {
    let prevTarget = cfgChatTarget.value;
    cfgChatTarget.addEventListener('change', () => {
      const newTarget = cfgChatTarget.value;
      hasExplicitChatTarget = true;
      if (suppressTargetConfirm || newTarget === prevTarget) {
        prevTarget = newTarget;
        onConfigChange();
        return;
      }
      prevTarget = newTarget;
      onConfigChange();
    });
  }
  if (agentBrowserToggle) {
    agentBrowserToggle.addEventListener('change', () => {
      const target = cfgChatTarget ? cfgChatTarget.value : 'controller';
      const agentId = agentIdForTarget(target);
      if (!agentId) return;
      rememberAgentBrowserOverride(agentId, !!agentBrowserToggle.checked);
      updateBrowserStatus();
      vscode.postMessage({
        type: 'configChanged',
        config: {
          chatTarget: target,
          agentBrowserEnabled: !!agentBrowserToggle.checked,
        },
      });
      saveState();
    });
  }
  if (cfgControllerCli) cfgControllerCli.addEventListener('change', onConfigChange);
  if (cfgCodexMode) cfgCodexMode.addEventListener('change', onConfigChange);
  if (cfgWorkerCli) cfgWorkerCli.addEventListener('change', onConfigChange);

  let currentActor = null;
  let currentSection = null;
  let hasContent = false;
  let streamingEntry = null;
  let isRunning = false;
  var lastPendingCard = null;
  let activeLiveEntitySlot = null;
  let activeLiveQaReportSlot = null;
  let qaReportOverlay = null;
  let suppressUiLog = false;
  const entryRawTextStore = new WeakMap();

  // ── Thinking indicator ────────────────────────────────────────────
  const pandaMessages = [
    'Munching bamboo',
    'Climbing a tree',
    'Rolling around',
    'Inspecting the code',
    'Checking for bugs',
    'Sniffing out issues',
    'Thinking deeply',
    'Reviewing changes',
    'Taking notes',
    'Stretching paws',
    'Sharpening claws',
    'Scanning the forest',
  ];
  const spinnerChars = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
  let thinkingEl = null;
  let thinkingInterval = null;
  let thinkingTick = 0;
  let thinkingMsgIndex = 0;
  let thinkingDots = 0;
  let pandaMascotEl = null;
  let pandaIdleTicks = 0;
  let lastRunOutcome = null;

  function showThinking() {
    hideThinking();
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking-standalone';
    pandaMascotEl = createPandaMascot('thinking');
    thinkingEl.appendChild(pandaMascotEl);
    const content = document.createElement('div');
    content.className = 'thinking-content';
    thinkingEl.appendChild(content);
    const target = splitVncLeft || splitChromeLeft || messagesEl;
    target.appendChild(thinkingEl);
    thinkingTick = 0;
    pandaIdleTicks = 0;
    thinkingMsgIndex = Math.floor(Math.random() * pandaMessages.length);
    thinkingDots = 0;
    updateThinkingText(content);
    thinkingInterval = setInterval(() => updateThinkingText(content), 200);
    autoScroll();
  }

  function updateThinkingText(el) {
    const spinner = spinnerChars[thinkingTick % spinnerChars.length];
    const dots = '.'.repeat((thinkingDots % 3) + 1);
    const msg = pandaMessages[thinkingMsgIndex % pandaMessages.length];
    el.textContent = spinner + ' ' + msg + dots;
    thinkingTick++;
    thinkingDots++;
    pandaIdleTicks++;
    if (thinkingTick % 8 === 0) {
      thinkingMsgIndex++;
    }
    // Switch to sleeping panda after ~30s with no external messages
    if (pandaIdleTicks >= 150 && pandaMascotEl &&
        !pandaMascotEl.classList.contains('panda-mascot--idle')) {
      setPandaMascotState(pandaMascotEl, 'idle');
    }
  }

  function hideThinking() {
    if (thinkingInterval) {
      clearInterval(thinkingInterval);
      thinkingInterval = null;
    }
    if (thinkingEl && thinkingEl.parentNode) {
      thinkingEl.parentNode.removeChild(thinkingEl);
    }
    thinkingEl = null;
    pandaMascotEl = null;
    pandaIdleTicks = 0;
  }

  function createPandaMascot(state) {
    var el = document.createElement('span');
    el.className = 'panda-mascot';
    setPandaMascotState(el, state || 'thinking');
    return el;
  }

  function setPandaMascotState(el, state) {
    if (!el) return;
    el.classList.remove('panda-mascot--thinking', 'panda-mascot--happy',
                         'panda-mascot--sad', 'panda-mascot--idle');
    switch (state) {
      case 'happy':
        el.innerHTML = PANDA_HAPPY;
        el.classList.add('panda-mascot--happy');
        break;
      case 'sad':
        el.innerHTML = PANDA_SAD;
        el.classList.add('panda-mascot--sad');
        break;
      case 'idle':
        el.innerHTML = PANDA_SLEEPING;
        el.classList.add('panda-mascot--idle');
        break;
      case 'thinking':
      default:
        el.innerHTML = PANDA_THINKING;
        el.classList.add('panda-mascot--thinking');
        break;
    }
  }

  function flashPandaMascot(state) {
    var container = document.createElement('div');
    container.className = 'panda-flash';
    var mascot = createPandaMascot(state);
    container.appendChild(mascot);
    var target = splitVncLeft || splitChromeLeft || messagesEl;
    target.appendChild(container);
    autoScroll();
    setTimeout(function() { container.classList.add('fade-out'); }, 1200);
    setTimeout(function() { if (container.parentNode) container.parentNode.removeChild(container); }, 1700);
  }

  function maybeShowThinking() {
    if (isRunning) {
      showThinking();
    }
  }

  // ── Persistent panda buddy ──────────────────────────────────────────
  var pandaBuddyEl = null;
  var buddyState = 'idle';
  var buddyIdleTimer = null;

  function initPandaBuddy() {
    pandaBuddyEl = document.getElementById('panda-buddy');
    if (!pandaBuddyEl) return;
    setBuddyState('idle');
    pandaBuddyEl.addEventListener('click', petPanda);
  }

  function setBuddyState(state) {
    if (!pandaBuddyEl) return;
    buddyState = state;
    pandaBuddyEl.className = 'panda-buddy panda-buddy--' + state;
    var svgs = {
      idle: BUDDY_IDLE, thinking: BUDDY_THINKING,
      working: BUDDY_WORKING, happy: BUDDY_HAPPY,
      sad: BUDDY_SAD, sleeping: BUDDY_SLEEPING
    };
    pandaBuddyEl.innerHTML = svgs[state] || svgs.idle;
    clearTimeout(buddyIdleTimer);
    if (state === 'idle') {
      startBuddyAmbient();
      buddyIdleTimer = setTimeout(function() { setBuddyState('sleeping'); }, 60000);
    } else {
      stopBuddyAmbient();
      if (state !== 'sleeping') {
        buddyIdleTimer = setTimeout(function() { setBuddyState('idle'); }, 60000);
      }
    }
  }

  function petPanda() {
    var prev = buddyState;
    stopBuddyAmbient();
    pandaBuddyEl.className = 'panda-buddy panda-buddy--pet';
    pandaBuddyEl.innerHTML = BUDDY_HAPPY;
    clearTimeout(buddyIdleTimer);
    setTimeout(function() { setBuddyState(prev === 'pet' ? 'idle' : prev); }, 1500);
  }

  // ── Ambient idle behaviors ──────────────────────────────────────────
  var buddyAmbientTimer = null;

  function startBuddyAmbient() {
    stopBuddyAmbient();
    scheduleNextAmbient();
  }

  function stopBuddyAmbient() {
    clearTimeout(buddyAmbientTimer);
    buddyAmbientTimer = null;
  }

  function scheduleNextAmbient() {
    var delay = 3000 + Math.random() * 5000;
    buddyAmbientTimer = setTimeout(doAmbientAction, delay);
  }

  function doAmbientAction() {
    if (!pandaBuddyEl || (buddyState !== 'idle' && buddyState !== 'sleeping')) return;
    var actions = ['look', 'blink', 'hop', 'wave'];
    var action = actions[Math.floor(Math.random() * actions.length)];
    var durations = { look: 2000, blink: 400, hop: 500, wave: 1200 };
    pandaBuddyEl.className = 'panda-buddy panda-buddy--' + action;
    setTimeout(function() {
      if (pandaBuddyEl && (buddyState === 'idle' || buddyState === 'sleeping')) {
        pandaBuddyEl.className = 'panda-buddy panda-buddy--' + buddyState;
      }
      scheduleNextAmbient();
    }, durations[action] || 1000);
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  function roleClass(label) {
    if (!label) return '';
    const l = label.toLowerCase();
    if (l.includes('user')) return 'role-user';
    if (l.includes('orchestrator')) return 'role-orchestrator';
    if (l === 'continue') return 'role-continue';
    if (l.includes('controller')) return 'role-orchestrator';
    if (l.includes('developer')) return 'role-agent-dev';
    if (l.includes('qa')) return 'role-agent-qa';
    if (l.includes('setup')) return 'role-agent-setup';
    if (l.includes('delegation')) return 'role-delegation';
    if (l.includes('worker') || l.includes('claude')) return 'role-claude';
    if (l.includes('shell')) return 'role-shell';
    if (l.includes('error')) return 'role-error';
    return 'role-default';
  }

  function agentAvatar(label) {
    if (!label) return '';
    const l = label.toLowerCase();
    if (l.includes('developer')) return '\uD83D\uDEE0\uFE0F';
    if (l.includes('qa') && l.includes('browser')) return '\uD83D\uDD0D';
    if (l.includes('qa')) return '\uD83D\uDDA5\uFE0F';
    if (l.includes('setup')) return '\u2699\uFE0F';
    if (l.includes('orchestrator')) return '\uD83C\uDFAF';
    if (l === 'continue') return '\u25B6\uFE0F';
    if (l.includes('delegation')) return '\uD83D\uDD00';
    return '';
  }

  function shouldAutoScroll() {
    // Use a generous threshold — when large chunks arrive the container
    // can grow significantly between scroll checks.
    const threshold = 200;
    const scrollEl = splitVncLeft || splitChromeLeft;
    if (scrollEl) {
      return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < threshold;
    }
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  }

  function scrollToBottom() {
    const scrollEl = splitVncLeft || splitChromeLeft;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function autoScroll() {
    if (shouldAutoScroll()) {
      // First pass: scroll after current DOM update
      requestAnimationFrame(() => {
        scrollToBottom();
        // Second pass: catch any layout shifts from large multi-line chunks
        // that may not have fully rendered in the first frame
        requestAnimationFrame(scrollToBottom);
      });
    }
  }

  // ── Lightweight Markdown → HTML ─────────────────────────────────────

  // Panda SVGs for test cards — 4 expressions based on pass/fail ratio
  var PANDA_HAPPY = '<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="20" cy="15" r="12" fill="#7B8EC8"/><circle cx="60" cy="15" r="12" fill="#7B8EC8"/>' +
    '<ellipse cx="40" cy="50" rx="30" ry="28" fill="white"/>' +
    '<ellipse cx="28" cy="42" rx="9" ry="7" fill="#7B8EC8"/><ellipse cx="52" cy="42" rx="9" ry="7" fill="#7B8EC8"/>' +
    '<circle cx="28" cy="42" r="4" fill="white"/><circle cx="52" cy="42" r="4" fill="white"/>' +
    '<circle cx="29" cy="41" r="2" fill="#3B4A7A"/><circle cx="53" cy="41" r="2" fill="#3B4A7A"/>' +
    '<circle cx="31" cy="39" r="1" fill="white"/><circle cx="55" cy="39" r="1" fill="white"/>' +
    '<ellipse cx="40" cy="55" rx="5" ry="3" fill="#7B8EC8"/>' +
    '<path d="M32 60 Q40 68 48 60" stroke="#7B8EC8" stroke-width="2" fill="none"/>' +
    '<line x1="12" y1="75" x2="5" y2="55" stroke="#7B8EC8" stroke-width="4" stroke-linecap="round"/>' +
    '<line x1="68" y1="75" x2="75" y2="55" stroke="#7B8EC8" stroke-width="4" stroke-linecap="round"/>' +
    '<text x="15" y="18" font-size="8" fill="#4caf50">✦</text><text x="60" y="18" font-size="8" fill="#4caf50">✦</text>' +
    '</svg>';

  var PANDA_THINKING = '<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="20" cy="15" r="12" fill="#7B8EC8"/><circle cx="60" cy="15" r="12" fill="#7B8EC8"/>' +
    '<ellipse cx="40" cy="50" rx="30" ry="28" fill="white"/>' +
    '<ellipse cx="28" cy="42" rx="9" ry="7" fill="#7B8EC8"/><ellipse cx="52" cy="42" rx="9" ry="7" fill="#7B8EC8"/>' +
    '<circle cx="28" cy="42" r="4" fill="white"/><circle cx="52" cy="42" r="4" fill="white"/>' +
    '<circle cx="29" cy="41" r="2" fill="#3B4A7A"/><circle cx="53" cy="41" r="2" fill="#3B4A7A"/>' +
    '<ellipse cx="40" cy="55" rx="5" ry="3" fill="#7B8EC8"/>' +
    '<path d="M33 62 Q40 58 47 62" stroke="#7B8EC8" stroke-width="2" fill="none"/>' +
    '<line x1="68" y1="75" x2="58" y2="58" stroke="#7B8EC8" stroke-width="4" stroke-linecap="round"/>' +
    '<circle cx="58" cy="57" r="3" fill="#7B8EC8"/>' +
    '</svg>';

  var PANDA_SAD = '<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="20" cy="18" rx="12" ry="10" fill="#7B8EC8"/><ellipse cx="60" cy="18" rx="12" ry="10" fill="#7B8EC8"/>' +
    '<ellipse cx="40" cy="50" rx="30" ry="28" fill="white"/>' +
    '<ellipse cx="28" cy="42" rx="9" ry="7" fill="#7B8EC8"/><ellipse cx="52" cy="42" rx="9" ry="7" fill="#7B8EC8"/>' +
    '<circle cx="28" cy="43" r="4" fill="white"/><circle cx="52" cy="43" r="4" fill="white"/>' +
    '<circle cx="28" cy="44" r="2" fill="#3B4A7A"/><circle cx="52" cy="44" r="2" fill="#3B4A7A"/>' +
    '<ellipse cx="40" cy="55" rx="5" ry="3" fill="#7B8EC8"/>' +
    '<path d="M33 65 Q40 60 47 65" stroke="#7B8EC8" stroke-width="2" fill="none"/>' +
    '</svg>';

  var PANDA_CRYING = '<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="20" cy="20" rx="12" ry="9" fill="#7B8EC8"/><ellipse cx="60" cy="20" rx="12" ry="9" fill="#7B8EC8"/>' +
    '<ellipse cx="40" cy="52" rx="30" ry="28" fill="white"/>' +
    '<ellipse cx="28" cy="44" rx="9" ry="7" fill="#7B8EC8"/><ellipse cx="52" cy="44" rx="9" ry="7" fill="#7B8EC8"/>' +
    '<line x1="24" y1="44" x2="32" y2="44" stroke="white" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="48" y1="44" x2="56" y2="44" stroke="white" stroke-width="2" stroke-linecap="round"/>' +
    '<ellipse cx="40" cy="57" rx="5" ry="3" fill="#7B8EC8"/>' +
    '<path d="M33 66 Q40 62 47 66" stroke="#7B8EC8" stroke-width="2" fill="none"/>' +
    '<ellipse cx="22" cy="55" rx="2" ry="4" fill="#569cd6" opacity="0.5"/>' +
    '<ellipse cx="58" cy="55" rx="2" ry="4" fill="#569cd6" opacity="0.5"/>' +
    '<ellipse cx="20" cy="62" rx="1.5" ry="3" fill="#569cd6" opacity="0.3"/>' +
    '<ellipse cx="60" cy="62" rx="1.5" ry="3" fill="#569cd6" opacity="0.3"/>' +
    '</svg>';

  var PANDA_SLEEPING = '<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="20" cy="15" r="12" fill="#7B8EC8"/><circle cx="60" cy="15" r="12" fill="#7B8EC8"/>' +
    '<ellipse cx="40" cy="50" rx="30" ry="28" fill="white"/>' +
    '<ellipse cx="28" cy="42" rx="9" ry="7" fill="#7B8EC8"/><ellipse cx="52" cy="42" rx="9" ry="7" fill="#7B8EC8"/>' +
    '<line x1="24" y1="42" x2="32" y2="42" stroke="white" stroke-width="2" stroke-linecap="round"/>' +
    '<line x1="48" y1="42" x2="56" y2="42" stroke="white" stroke-width="2" stroke-linecap="round"/>' +
    '<ellipse cx="40" cy="55" rx="5" ry="3" fill="#7B8EC8"/>' +
    '<path d="M34 62 Q40 66 46 62" stroke="#7B8EC8" stroke-width="1.5" fill="none"/>' +
    '<text x="62" y="28" font-size="7" fill="#888" font-weight="bold">z</text>' +
    '<text x="67" y="22" font-size="9" fill="#888" font-weight="bold">z</text>' +
    '<text x="73" y="15" font-size="11" fill="#888" font-weight="bold">z</text>' +
    '</svg>';

      // ── Standing buddy panda SVGs (viewBox 0 0 100 120) ────
  // Panda is standing bipedal, facing slightly right or forward, looking very cute.

  var BUDDY_BASE_DEFS = '<defs><radialGradient id="pd-blsh" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#ff9999" stop-opacity="0.6"/><stop offset="100%" stop-color="#ff9999" stop-opacity="0"/></radialGradient></defs>';

  var BUDDY_IDLE = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 15 75, 10 90, 20 95 C 28 98, 30 80, 32 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 85 75, 90 90, 80 95 C 72 98, 70 80, 68 70 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<circle cx="33" cy="50" r="6" fill="#fff"/><circle cx="67" cy="50" r="6" fill="#fff"/>' +
    '<circle cx="34" cy="50" r="3.5" fill="#3B4A7A"/><circle cx="66" cy="50" r="3.5" fill="#3B4A7A"/>' +
    '<circle cx="35" cy="48" r="1.5" fill="#fff"/><circle cx="65" cy="48" r="1.5" fill="#fff"/>' +
    '<path d="M 46 60 Q 50 57, 54 60 Q 55 62, 50 64 Q 45 62, 46 60 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 64 L 50 69" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M 45 69 Q 50 73, 55 69" stroke="#3B4A7A" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '<circle cx="20" cy="62" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="62" r="8" fill="url(#pd-blsh)"/>' +
    '</svg>';

  var BUDDY_THINKING = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 15 75, 10 90, 20 95 C 28 98, 30 80, 32 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 85 70, 80 50, 72 50 C 68 50, 65 55, 62 65 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<circle cx="33" cy="50" r="6" fill="#fff"/><circle cx="67" cy="50" r="6" fill="#fff"/>' +
    '<circle cx="36" cy="46" r="3.5" fill="#3B4A7A"/><circle cx="70" cy="46" r="3.5" fill="#3B4A7A"/>' +
    '<circle cx="37" cy="44" r="1.5" fill="#fff"/><circle cx="71" cy="44" r="1.5" fill="#fff"/>' +
    '<path d="M 46 60 Q 50 57, 54 60 Q 55 62, 50 64 Q 45 62, 46 60 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 64 L 50 67" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="20" cy="62" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="62" r="8" fill="url(#pd-blsh)"/>' +
    '<circle cx="88" cy="20" r="3" fill="#888" opacity="0.4"/>' +
    '<circle cx="95" cy="14" r="2" fill="#888" opacity="0.3"/>' +
    '<text x="82" y="10" font-size="20" fill="#888" font-family="sans-serif" opacity="0.6">?</text>' +
    '</svg>';

  var BUDDY_WORKING = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 10 70, 20 85, 38 82 C 32 75, 25 70, 28 65 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 90 70, 80 85, 62 82 C 68 75, 75 70, 72 65 Z" fill="#7B8EC8"/>' +
    '<rect x="30" y="80" width="40" height="10" rx="3" fill="#4a5568"/>' +
    '<rect x="33" y="82" width="34" height="6" rx="1" fill="#a0aec0"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<rect x="23" y="42" width="22" height="16" rx="6" fill="#fff" stroke="#3B4A7A" stroke-width="2.5"/>' +
    '<rect x="55" y="42" width="22" height="16" rx="6" fill="#fff" stroke="#3B4A7A" stroke-width="2.5"/>' +
    '<path d="M 45 50 L 55 50" stroke="#3B4A7A" stroke-width="2.5"/>' +
    '<circle cx="34" cy="50" r="3.5" fill="#3B4A7A"/><circle cx="66" cy="50" r="3.5" fill="#3B4A7A"/>' +
    '<circle cx="35" cy="48" r="1.5" fill="#fff"/><circle cx="67" cy="48" r="1.5" fill="#fff"/>' +
    '<path d="M 46 60 Q 50 57, 54 60 Q 55 62, 50 64 Q 45 62, 46 60 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 64 L 50 67" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M 45 67 Q 50 71, 55 67" stroke="#3B4A7A" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '<circle cx="20" cy="62" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="62" r="8" fill="url(#pd-blsh)"/>' +
    '<path d="M 20 80 L 25 75 M 80 80 L 75 75 M 25 90 L 20 95 M 75 90 L 80 95" stroke="#3498db" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_HAPPY = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<g transform="translate(0, -5)">' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 55 C 10 35, 5 20, 20 20 C 30 20, 35 45, 30 55 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 55 C 90 35, 95 20, 80 20 C 70 20, 65 45, 70 55 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="30" r="14" fill="#7B8EC8"/><circle cx="80" cy="30" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<path d="M 28 50 Q 33 42, 38 50" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>' +
    '<path d="M 62 50 Q 67 42, 72 50" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>' +
    '<path d="M 45 61 Q 50 78, 55 61 Z" fill="#ff7675"/>' +
    '<circle cx="20" cy="60" r="10" fill="url(#pd-blsh)"/><circle cx="80" cy="60" r="10" fill="url(#pd-blsh)"/>' +
    '</g>' +
    '<path d="M 15 35 L 20 40 M 85 35 L 80 40 M 15 20 L 25 25 M 85 20 L 75 25" stroke="#f1c40f" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_SAD = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<path d="M 35 110 C 35 115, 25 118, 25 110 C 25 90, 40 85, 45 90 Z" fill="#7B8EC8"/>' +
    '<path d="M 65 110 C 65 115, 75 118, 75 110 C 75 90, 60 85, 55 90 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="85" rx="32" ry="28" fill="#fff"/>' +
    '<path d="M 18 70 C 50 85, 82 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 25 60 C 15 75, 15 95, 20 100 C 28 100, 30 80, 28 70 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 60 C 85 75, 85 95, 80 100 C 72 100, 70 80, 72 70 Z" fill="#7B8EC8"/>' +
    '<circle cx="15" cy="45" r="14" fill="#7B8EC8"/><circle cx="85" cy="45" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 50 C 10 15, 90 15, 90 50 C 90 75, 70 85, 50 85 C 30 85, 10 75, 10 50 Z" fill="#fff"/>' +
    '<path d="M 25 40 C 15 55, 25 65, 38 60 C 48 56, 45 35, 35 32 C 30 30, 28 30, 25 40 Z" fill="#7B8EC8" transform="rotate(-15 32 46)"/>' +
    '<path d="M 75 40 C 85 55, 75 65, 62 60 C 52 56, 55 35, 65 32 C 70 30, 72 30, 75 40 Z" fill="#7B8EC8" transform="rotate(15 68 46)"/>' +
    '<path d="M 28 48 Q 33 43, 38 52" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 62 52 Q 67 43, 72 48" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 33 55 Q 36 62, 33 65 Q 30 62, 33 55 Z" fill="#74b9ff"/>' +
    '<path d="M 46 62 Q 50 59, 54 62 Q 55 64, 50 66 Q 45 64, 46 62 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 66 L 50 69" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<path d="M 45 73 Q 50 69, 55 73" stroke="#3B4A7A" stroke-width="1.5" fill="none" stroke-linecap="round"/>' +
    '</svg>';

  var BUDDY_SLEEPING = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg">' + BUDDY_BASE_DEFS +
    '<ellipse cx="50" cy="115" rx="35" ry="5" fill="#000" opacity="0.1"/>' +
    '<g transform="translate(0, 15)">' +
    '<path d="M 25 100 C 15 100, 15 90, 25 85 C 40 85, 45 95, 35 100 Z" fill="#7B8EC8"/>' +
    '<path d="M 75 100 C 85 100, 85 90, 75 85 C 60 85, 55 95, 65 100 Z" fill="#7B8EC8"/>' +
    '<ellipse cx="50" cy="75" rx="36" ry="28" fill="#fff"/>' +
    '<path d="M 12 70 C 50 95, 88 70, 80 50 C 50 60, 20 50, 20 70 Z" fill="#7B8EC8"/>' +
    '<circle cx="20" cy="40" r="14" fill="#7B8EC8"/><circle cx="80" cy="40" r="14" fill="#7B8EC8"/>' +
    '<path d="M 10 55 C 10 25, 90 25, 90 55 C 90 80, 70 85, 50 85 C 30 85, 10 80, 10 55 Z" fill="#fff"/>' +
    '<path d="M 25 45 C 15 60, 25 70, 38 65 C 48 61, 45 40, 35 37 C 30 35, 28 35, 25 45 Z" fill="#7B8EC8" transform="rotate(-20 32 51)"/>' +
    '<path d="M 75 45 C 85 60, 75 70, 62 65 C 52 61, 55 40, 65 37 C 70 35, 72 35, 75 45 Z" fill="#7B8EC8" transform="rotate(20 68 51)"/>' +
    '<path d="M 28 55 Q 33 60, 38 55" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 62 55 Q 67 60, 72 55" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M 46 64 Q 50 61, 54 64 Q 55 66, 50 68 Q 45 66, 46 64 Z" fill="#3B4A7A"/>' +
    '<path d="M 50 68 L 50 71" stroke="#3B4A7A" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="56" cy="74" r="5" fill="#81ecec" opacity="0.6"/>' +
    '<circle cx="20" cy="65" r="8" fill="url(#pd-blsh)"/><circle cx="80" cy="65" r="8" fill="url(#pd-blsh)"/>' +
    '</g>' +
    '<text x="82" y="30" font-size="16" fill="#888" font-family="sans-serif" font-weight="bold">Z</text>' +
    '<text x="92" y="15" font-size="12" fill="#888" font-family="sans-serif" font-weight="bold">z</text>' +
    '</svg>\n\n'


  function triggerConfetti() {
    var canvas = document.createElement('canvas');
    canvas.className = 'confetti-canvas';
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    var particles = [];
    var colors = ['#4caf50', '#81c784', '#ffeb3b', '#ff9800', '#e91e63', '#2196f3', '#9c27b0'];
    for (var i = 0; i < 60; i++) {
      particles.push({
        x: canvas.width / 2 + (Math.random() - 0.5) * 200,
        y: canvas.height / 2,
        vx: (Math.random() - 0.5) * 12,
        vy: Math.random() * -14 - 4,
        size: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 10,
      });
    }
    var frame = 0;
    function animate() {
      if (frame > 80) { canvas.remove(); return; }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.vy += 0.3;
        p.y += p.vy;
        p.rotation += p.rotSpeed;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation * Math.PI / 180);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, 1 - frame / 80);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
      frame++;
      requestAnimationFrame(animate);
    }
    animate();
  }

  function withSuppressedCelebrationEffects(fn) {
    suppressCelebrationEffects += 1;
    try {
      return fn();
    } finally {
      suppressCelebrationEffects = Math.max(0, suppressCelebrationEffects - 1);
    }
  }

  function buildTestCardCelebrationKey(msg) {
    const data = (msg && msg.data) || {};
    const steps = Array.isArray(data.steps)
      ? data.steps.map((step) => {
          const stepId = step && (step.id || step.name || '');
          const status = step && step.status ? String(step.status) : '';
          return `${stepId}:${status}`;
        }).join('|')
      : '';
    return [
      data.test_id || '',
      data.title || '',
      Number(data.passed) || 0,
      Number(data.failed) || 0,
      Number(data.skipped) || 0,
      steps,
    ].join('::');
  }

  function pruneRecentCelebratedTestCards(now) {
    for (const [key, ts] of recentCelebratedTestCards.entries()) {
      if ((now - ts) >= TEST_CARD_CONFETTI_DEDUPE_MS) {
        recentCelebratedTestCards.delete(key);
      }
    }
  }

  function shouldCelebrateTestCard(msg) {
    if (suppressCelebrationEffects > 0) return false;
    const data = (msg && msg.data) || {};
    const passed = Number(data.passed) || 0;
    const failed = Number(data.failed) || 0;
    if (!(failed === 0 && passed > 0)) return false;
    const now = Date.now();
    pruneRecentCelebratedTestCards(now);
    const key = buildTestCardCelebrationKey(msg);
    const lastSeen = recentCelebratedTestCards.get(key);
    if (lastSeen && (now - lastSeen) < TEST_CARD_CONFETTI_DEDUPE_MS) {
      return false;
    }
    recentCelebratedTestCards.set(key, now);
    return true;
  }

  function _formatRelativeTime(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return days + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  function escapeHtml(str) {
    if (typeof str !== 'string') str = JSON.stringify(str) || '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderDecisionCard(d) {
    let html = '<div class="decision">';
    html += '<div class="decision-action">' + escapeHtml(d.action || '?');
    if (d.action === 'delegate' && d.agent_id) html += ' → ' + escapeHtml(d.agent_id);
    html += '</div>';
    if (d.controller_messages && d.controller_messages.length) {
      for (const m of d.controller_messages) {
        html += '<div class="decision-msg">' + escapeHtml(m) + '</div>';
      }
    }
    if (d.claude_message) {
      html += '<div class="decision-task">' + escapeHtml(d.claude_message) + '</div>';
    }
    if (d.stop_reason) {
      html += '<div class="decision-stop">Stop: ' + escapeHtml(d.stop_reason) + '</div>';
    }
    if (d.progress_updates && d.progress_updates.length) {
      html += '<div class="decision-progress">' + d.progress_updates.map(p => escapeHtml(p)).join(' · ') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderInlineMarkdown(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return html;
  }

  function renderMarkdown(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    const out = [];
    let inCode = false;
    let codeLang = '';
    let codeLines = [];

    for (const line of lines) {
      if (line.match(/^```/)) {
        if (inCode) {
          out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
          codeLines = [];
          inCode = false;
          continue;
        }
        inCode = true;
        codeLang = line.slice(3).trim();
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }

      // Headings
      const hMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (hMatch) {
        const level = hMatch[1].length;
        out.push(`<h${level}>${renderInlineMarkdown(hMatch[2])}</h${level}>`);
        continue;
      }

      // Bullet points
      const bMatch = line.match(/^(\s*[-*+])\s+(.*)/);
      if (bMatch) {
        out.push(`<li>${renderInlineMarkdown(bMatch[2])}</li>`);
        continue;
      }

      // Numbered lists
      const nMatch = line.match(/^(\s*\d+\.)\s+(.*)/);
      if (nMatch) {
        out.push(`<li>${renderInlineMarkdown(nMatch[2])}</li>`);
        continue;
      }

      // Empty line
      if (line.trim() === '') {
        out.push('');
        continue;
      }

      // Regular line
      out.push(renderInlineMarkdown(line));
    }

    // Close unclosed code block
    if (inCode) {
      out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    }

    return out.join('\n');
  }

  function normalizeTaskCopySource(data) {
    const id = data && (data.task_id || data.id);
    const boardTask = id ? (kanbanTasks || []).find((task) => task.id === id) : null;
    const source = boardTask ? { ...boardTask, ...data } : (data || {});
    return {
      id: source.task_id || source.id || '',
      title: source.title || '',
      status: source.status || '',
      description: source.description || '',
      detail_text: source.detail_text || '',
      comments: Array.isArray(source.comments) ? source.comments : [],
      progress_updates: Array.isArray(source.progress_updates) ? source.progress_updates : [],
      comments_count: source.comments_count != null ? source.comments_count : ((source.comments || []).length || 0),
      progress_updates_count: source.progress_updates_count != null ? source.progress_updates_count : ((source.progress_updates || []).length || 0),
    };
  }

  function normalizeTestCopySource(data) {
    const id = data && (data.test_id || data.id);
    const boardTest = id ? (testBoardData || []).find((test) => test.id === id) : null;
    const source = boardTest ? { ...boardTest, ...data } : (data || {});
    const steps = Array.isArray(source.steps) ? source.steps : [];
    return {
      id: source.test_id || source.id || '',
      title: source.title || '',
      environment: source.environment || '',
      status: source.status || '',
      description: source.description || '',
      linkedTaskIds: Array.isArray(source.linkedTaskIds) ? source.linkedTaskIds : [],
      steps: steps.map((step) => ({
        description: step.description || step.name || '',
        expectedResult: step.expectedResult || '',
        actualResult: step.actualResult || '',
        status: step.status || '',
      })),
    };
  }

  function artifactRawId(value) {
    return String(value || '').trim();
  }

  function artifactNumericSuffix(value) {
    const match = artifactRawId(value).match(/(\d+)(?!.*\d)/);
    return match ? match[1] : '';
  }

  function artifactShortBadge(value) {
    const raw = artifactRawId(value);
    if (!raw) return '';
    const suffix = artifactNumericSuffix(raw);
    return suffix ? `#${suffix}` : raw;
  }

  function artifactKindLabel(kind) {
    return kind === 'test' ? 'Test' : 'Issue';
  }

  function artifactKindPluralLabel(kind) {
    return kind === 'test' ? 'Tests' : 'Issues';
  }

  function artifactItemTypeLabel(itemType) {
    return itemType === 'bug' ? 'bug' : 'issue';
  }

  function formatArtifactReference(value) {
    const raw = artifactRawId(value);
    if (!raw) return '';
    const badge = artifactShortBadge(raw);
    return badge && badge !== raw ? `${badge} (${raw})` : raw;
  }

  function formatArtifactHeader(kind, id, title, fallbackTitle) {
    const raw = artifactRawId(id);
    const badge = artifactShortBadge(raw);
    const label = artifactKindLabel(kind);
    const heading = title || fallbackTitle || `untitled ${label.toLowerCase()}`;
    if (raw && badge && badge !== raw) return `[${label} ${badge} | ${raw}] ${heading}`;
    if (raw) return `[${label}: ${raw}] ${heading}`;
    return `[${label}] ${heading}`;
  }

  function renderArtifactBadgeHtml(value, extraClass) {
    const badge = artifactShortBadge(value);
    if (!badge) return '';
    return '<span class="artifact-id-badge' + (extraClass ? ' ' + extraClass : '') + '">' + escapeHtml(badge) + '</span>';
  }

  function renderArtifactHeaderHtml(kind, id, title, options) {
    const raw = artifactRawId(id);
    const opts = options || {};
    const extraMeta = opts.extraMeta ? String(opts.extraMeta) : '';
    let html = '<div class="artifact-title-row">';
    html += renderArtifactBadgeHtml(raw);
    if (opts.icon) html += '<span class="artifact-title-icon">' + escapeHtml(opts.icon) + '</span>';
    html += '<span class="artifact-title-text">' + escapeHtml(title || artifactKindLabel(kind)) + '</span>';
    html += '</div>';
    if (raw || extraMeta) {
      html += '<div class="artifact-id-raw">';
      if (raw) html += escapeHtml(raw);
      if (raw && extraMeta) html += ' · ';
      if (extraMeta) html += escapeHtml(extraMeta);
      html += '</div>';
    }
    return html;
  }

  function formatTaskCopyText(data) {
    const task = normalizeTaskCopySource(data);
    const lines = [
      formatArtifactHeader('task', task.id || 'unknown', task.title, '(untitled issue)'),
      `Status: ${task.status || 'unknown'}`,
      `Description: ${task.description || '(none)'}`,
      `Details: ${task.detail_text || '(none)'}`,
      `Comments: ${task.comments_count || 0}`,
      `Progress Updates: ${task.progress_updates_count || 0}`,
    ];
    return lines.join('\n');
  }

  function formatTestCopyText(data) {
    const test = normalizeTestCopySource(data);
    const lines = [
      formatArtifactHeader('test', test.id || 'unknown', test.title, '(untitled test)'),
      `Environment: ${test.environment || 'unknown'}`,
      `Status: ${test.status || 'unknown'}`,
      `Description: ${test.description || '(none)'}`,
    ];
    if (test.linkedTaskIds.length) {
      lines.push(`Linked Issues: ${test.linkedTaskIds.map(formatArtifactReference).join(', ')}`);
    }
    lines.push('Steps:');
    if (!test.steps.length) {
      lines.push('  (none)');
    } else {
      test.steps.forEach((step, index) => {
        lines.push(`  ${index + 1}. ${step.description || '(unnamed step)'}`);
        lines.push(`     Expected: ${step.expectedResult || '(none)'}`);
        lines.push(`     Actual: ${step.actualResult || '(none)'}`);
        lines.push(`     Status: ${step.status || 'unknown'}`);
      });
    }
    return lines.join('\n');
  }

  function formatBugCopyText(data) {
    const task = data && data.task_id ? (kanbanTasks || []).find((item) => item.id === data.task_id) : null;
    const lines = [
      formatArtifactHeader('task', data && data.task_id, (data && data.title) || '(untitled bug)', '(untitled bug)').replace('[Issue', '[Bug'),
      `Severity: ${(data && data.severity) || 'unknown'}`,
      `Description: ${(data && data.description) || '(none)'}`,
    ];
    if (task) {
      lines.push(`Issue Status: ${task.status || 'unknown'}`);
      lines.push(`Issue Details: ${task.detail_text || '(none)'}`);
    }
    return lines.join('\n');
  }

  function copyTextToClipboard(text, button) {
    const value = text == null ? '' : String(text);
    function markCopied() {
      if (!button) return;
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1200);
    }
    function fallbackCopy() {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(area);
      markCopied();
      return Promise.resolve();
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(value).then(() => {
        markCopied();
      }).catch(fallbackCopy);
    }
    return fallbackCopy();
  }

  function wireCopyButton(button, getText) {
    if (!button) return;
    button.addEventListener('click', function(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      copyTextToClipboard(getText(), button);
    });
  }

  function renderEntityToolbar(options) {
    const showCopy = options && options.includeCopy;
    const live = options && options.live;
    if (!showCopy && !live) return '';
    let html = '<div class="entity-card-toolbar">';
    if (live) html += '<span class="entity-live-badge">Live</span>';
    if (showCopy) html += '<button type="button" class="entity-card-copy">Copy</button>';
    html += '</div>';
    return html;
  }

  function renderTestCardHtml(data, options) {
    const d = data || {};
    const opts = options || {};
    const testId = d.test_id || d.id;
    var passed = d.passed || 0;
    var failed = d.failed || 0;
    var skipped = d.skipped || 0;
    var total = passed + failed + skipped;
    var panda = (failed === 0 && total > 0) ? '\uD83D\uDC3C\u2728'
      : (failed <= 1 && passed > 0) ? '\uD83D\uDC3C\uD83D\uDE0A'
      : (passed > failed) ? '\uD83D\uDC3C\uD83E\uDD14'
      : '\uD83D\uDC3C\uD83D\uDE1F';
    var allPassMsgs = ['All tests passing! The panda is proud \uD83C\uDF8B', 'Perfect score! Time for bamboo \uD83C\uDF8D', 'Clean sweep! The panda approves \u2728', 'Flawless! Ship it! \uD83D\uDE80'];
    var someFailMsgs = ['Almost there \u2014 just a few fixes to go!', 'Getting closer! Keep pushing \uD83D\uDCAA', 'Good progress \u2014 the panda believes in you!'];
    var mostlyFailMsgs = ["Don't worry \u2014 every bug fixed is progress!", 'The panda is rooting for you \uD83D\uDC3C', "One step at a time \u2014 you've got this!"];
    var encourageMsg = '';
    if (total > 0) {
      if (failed === 0) encourageMsg = allPassMsgs[Math.floor(Math.random() * allPassMsgs.length)];
      else if (passed >= failed) encourageMsg = someFailMsgs[Math.floor(Math.random() * someFailMsgs.length)];
      else encourageMsg = mostlyFailMsgs[Math.floor(Math.random() * mostlyFailMsgs.length)];
    }
    var pandaSvg = (failed === 0 && total > 0) ? PANDA_HAPPY
      : (passed > failed) ? PANDA_THINKING
      : (passed > 0) ? PANDA_SAD
      : PANDA_CRYING;

    let html = '<div class="test-result-card' + (opts.live ? ' live-entity-card' : '') + '">';
    html += renderEntityToolbar(opts);
    html += '<div class="test-card-time">' + (opts.live ? 'Updating now' : new Date().toLocaleTimeString()) + '</div>';
    html += '<div class="test-card-title">' + renderArtifactHeaderHtml('test', testId, d.title || 'Test Results', { icon: panda }) + '</div>';
    if (d.steps && d.steps.length) {
      for (const s of d.steps) {
        const st = (s.status || '').toLowerCase();
        const isPassed = st === 'pass' || st === 'passed' || st === 'passing';
        const isFailed = st === 'fail' || st === 'failed' || st === 'failing';
        const icon = isPassed ? '\u2705' : isFailed ? '\u274C' : '\u2B1C';
        const cls = isPassed ? 'pass' : isFailed ? 'fail' : 'skip';
        html += '<div class="test-step ' + cls + '">' + icon + ' ' + escapeHtml(s.name || s.description || '') + '</div>';
      }
    }
    html += '<div class="test-card-summary">';
    if (d.passed != null) html += '<span class="pass">' + d.passed + ' passed</span> ';
    if (d.failed != null) html += '<span class="fail">' + d.failed + ' failed</span> ';
    if (d.skipped != null) html += '<span class="skip">' + d.skipped + ' skipped</span>';
    html += '</div>';
    if (encourageMsg) html += '<div class="test-card-encourage">' + encourageMsg + '</div>';
    html += '<div class="test-card-panda-svg">' + pandaSvg + '</div>';
    html += '</div>';
    return html;
  }

  function renderBugCardHtml(data, options) {
    const d = data || {};
    const opts = options || {};
    const severityColors = { critical: '#f44336', high: '#ff5722', medium: '#ff9800', low: '#ffc107' };
    const color = severityColors[d.severity] || '#f44336';
    let html = '<div class="bug-card' + (opts.live ? ' live-entity-card' : '') + '" style="border-left-color:' + color + '">';
    html += renderEntityToolbar(opts);
    html += '<div class="bug-card-header">' + renderArtifactHeaderHtml('task', d.task_id || d.id, d.title || 'Bug Report', { icon: '\uD83D\uDC1B' }) + '</div>';
    if (d.description) html += '<div class="bug-card-body">' + escapeHtml(d.description) + '</div>';
    if (d.severity) html += '<div class="bug-card-severity" style="color:' + color + '">' + escapeHtml(d.severity.toUpperCase()) + '</div>';
    html += '</div>';
    return html;
  }

  function renderTaskCardHtml(data, options) {
    const d = data || {};
    const opts = options || {};
    const statusColors = { todo: '#569cd6', in_progress: '#e5a04b', review: '#c586c0', testing: '#d9a0d4', done: '#4caf50', backlog: '#888' };
    const color = statusColors[d.status] || '#569cd6';
    let html = '<div class="task-card' + (opts.live ? ' live-entity-card' : '') + '" style="border-left-color:' + color + '">';
    html += renderEntityToolbar(opts);
    html += '<div class="task-card-header">' + renderArtifactHeaderHtml('task', d.task_id || d.id, d.title || 'Issue', { icon: '\uD83D\uDCCB' }) + '</div>';
    if (d.status) html += '<div class="task-card-status" style="color:' + color + '">' + escapeHtml(d.status.toUpperCase().replace(/_/g, ' ')) + '</div>';
    if (d.description) html += '<div class="task-card-body">' + escapeHtml(d.description) + '</div>';
    if (d.detail_text) html += '<div class="task-card-body task-card-detail">' + escapeHtml(d.detail_text) + '</div>';
    html += '</div>';
    return html;
  }

  function escapeAttr(str) {
    return escapeHtml(str).replace(/'/g, '&#39;');
  }

  function qaReportStatusTone(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'pass' || normalized === 'passed' || normalized === 'passing' || normalized === 'done') return 'pass';
    if (normalized === 'fail' || normalized === 'failed' || normalized === 'failing' || normalized === 'review') return 'fail';
    if (normalized === 'in_progress' || normalized === 'partial' || normalized === 'running' || normalized === 'testing') return 'progress';
    return 'neutral';
  }

  function formatQaTimestamp(value) {
    if (!value) return '';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return '';
    }
  }

  const QA_REPORT_COPY_SEPARATOR = '\n\n==========\n\n';

  function getQaReportSection(payload, scope) {
    return scope === 'session'
      ? ((payload && payload.session) || {})
      : ((payload && payload.run) || {});
  }

  function isQaReportFailingTest(item) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.failed === 'number') return item.failed > 0;
    const normalized = String(item.status || '').toLowerCase();
    return normalized === 'fail' || normalized === 'failed' || normalized === 'failing';
  }

  function formatQaReportCollection(items, kind, options) {
    const opts = options || {};
    const list = Array.isArray(items) ? items : [];
    let filtered = list;
    if (kind === 'test' && opts.failingOnly) {
      filtered = filtered.filter(isQaReportFailingTest);
    }
    const formatter = kind === 'task' ? formatTaskCopyText : formatTestCopyText;
    return filtered.map((item) => formatter(item && (item.detail || item))).join(QA_REPORT_COPY_SEPARATOR);
  }

  function renderQaReportActionsHtml() {
    return (
      '<div class="qa-report-actions">' +
        '<button type="button" class="entity-card-copy qa-report-action" data-qa-action="copy-all-tests">Copy all tests</button>' +
        '<button type="button" class="entity-card-copy qa-report-action" data-qa-action="copy-failing-tests">Copy failing tests</button>' +
        '<button type="button" class="entity-card-copy qa-report-action" data-qa-action="copy-all-tasks">Copy all issues</button>' +
        '<button type="button" class="entity-card-copy qa-report-action" data-qa-action="download-pdf">Export PDF</button>' +
      '</div>'
    );
  }

  function renderQaReportRows(items, scope, kind) {
    if (!Array.isArray(items) || items.length === 0) {
      return '<div class="qa-report-empty">None yet.</div>';
    }
    return items.map((item) => {
      const tone = qaReportStatusTone(item && item.status);
      if (kind === 'test') {
        const passed = item && item.passed ? item.passed : 0;
        const failed = item && item.failed ? item.failed : 0;
        const skipped = item && item.skipped ? item.skipped : 0;
        return (
          '<div class="qa-report-row" data-qa-kind="test" data-qa-scope="' + escapeAttr(scope) + '" data-qa-id="' + escapeAttr(item && item.id) + '">' +
            '<span class="qa-report-row-main">' +
              renderArtifactHeaderHtml('test', item && item.id, item && item.title || 'Test', { extraMeta: item && item.environment ? item.environment : '' }) +
            '</span>' +
            '<span class="qa-report-row-side">' +
              '<span class="qa-report-pill tone-' + tone + '">' + escapeHtml(String((item && item.status) || 'untested').replace(/_/g, ' ')) + '</span>' +
              '<span class="qa-report-counts">' + passed + ' passed · ' + failed + ' failed · ' + skipped + ' skipped</span>' +
            '</span>' +
            '<button type="button" class="entity-card-copy qa-report-row-copy" data-qa-copy-kind="test" data-qa-copy-scope="' + escapeAttr(scope) + '" data-qa-copy-id="' + escapeAttr(item && item.id) + '">Copy</button>' +
          '</div>'
        );
      }
      return (
        '<div class="qa-report-row" data-qa-kind="task" data-qa-scope="' + escapeAttr(scope) + '" data-qa-id="' + escapeAttr(item && item.id) + '">' +
          '<span class="qa-report-row-main">' +
            renderArtifactHeaderHtml('task', item && item.id, item && item.title || 'Issue') +
          '</span>' +
          '<span class="qa-report-row-side">' +
            '<span class="qa-report-pill type-' + escapeAttr(item && item.itemType || 'task') + '">' + escapeHtml(artifactItemTypeLabel(item && item.itemType)) + '</span>' +
            '<span class="qa-report-pill tone-' + tone + '">' + escapeHtml(String((item && item.status) || 'todo').replace(/_/g, ' ')) + '</span>' +
          '</span>' +
          '<button type="button" class="entity-card-copy qa-report-row-copy" data-qa-copy-kind="task" data-qa-copy-scope="' + escapeAttr(scope) + '" data-qa-copy-id="' + escapeAttr(item && item.id) + '">Copy</button>' +
        '</div>'
      );
    }).join('');
  }

  function renderQaReportSectionHtml(section, scope) {
    const tests = (section && section.tests) || [];
    const tasks = (section && section.tasks) || [];
    return (
      '<div class="qa-report-summary-grid">' +
        '<div class="qa-report-summary-box"><span class="qa-report-summary-count">' + tests.length + '</span><span class="qa-report-summary-label">Tests</span></div>' +
        '<div class="qa-report-summary-box"><span class="qa-report-summary-count">' + tasks.length + '</span><span class="qa-report-summary-label">Issues</span></div>' +
      '</div>' +
      '<div class="qa-report-group">' +
        '<div class="qa-report-group-title">Tests</div>' +
        renderQaReportRows(tests, scope, 'test') +
      '</div>' +
      '<div class="qa-report-group">' +
        '<div class="qa-report-group-title">Issues</div>' +
        renderQaReportRows(tasks, scope, 'task') +
      '</div>'
    );
  }

  function renderQaReportCardHtml(data, options) {
    const d = data || {};
    const opts = options || {};
    const updatedAt = formatQaTimestamp(d.updatedAt);
    return (
      '<div class="qa-report-card' + (opts.live ? ' qa-report-card-live' : '') + '">' +
        renderEntityToolbar({ live: opts.live }) +
        '<div class="qa-report-card-header">' +
          '<div>' +
            '<div class="qa-report-card-title">QA Report</div>' +
            '<div class="qa-report-card-subtitle">' + (updatedAt ? 'Updated ' + escapeHtml(updatedAt) : 'Summary of tests and issues in this chat') + '</div>' +
          '</div>' +
          renderQaReportActionsHtml() +
        '</div>' +
        '<div class="qa-report-tabs">' +
          '<button type="button" class="qa-report-tab is-active" data-qa-tab="run">This Run</button>' +
          '<button type="button" class="qa-report-tab" data-qa-tab="session">This Session</button>' +
        '</div>' +
        '<div class="qa-report-panel is-active" data-qa-panel="run">' + renderQaReportSectionHtml(d.run || {}, 'run') + '</div>' +
        '<div class="qa-report-panel" data-qa-panel="session">' + renderQaReportSectionHtml(d.session || {}, 'session') + '</div>' +
      '</div>'
    );
  }

  function findQaReportItem(payload, scope, kind, id) {
    const section = scope === 'session' ? payload && payload.session : payload && payload.run;
    const items = kind === 'task' ? ((section && section.tasks) || []) : ((section && section.tests) || []);
    return items.find((item) => item && String(item.id) === String(id)) || null;
  }

  function renderReadonlyTestDetailHtml(item) {
    const detail = normalizeTestCopySource(item && (item.detail || item));
    const raw = item && item.detail ? item.detail : {};
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const runs = Array.isArray(raw.runs) ? raw.runs : [];
    let html = '<div class="agent-report-detail agent-report-detail-test">';
    html += '<div class="agent-report-detail-header"><div class="agent-report-detail-heading">' + renderArtifactHeaderHtml('test', detail.id, detail.title || 'Test') + '</div><div class="agent-report-detail-actions"><button type="button" class="entity-card-copy agent-report-overlay-copy">Copy</button><button type="button" class="agent-report-overlay-close">×</button></div></div>';
    html += '<div class="agent-report-detail-meta">';
    if (detail.environment) html += '<span class="qa-report-pill tone-progress">' + escapeHtml(detail.environment) + '</span>';
    if (detail.status) html += '<span class="qa-report-pill tone-' + qaReportStatusTone(detail.status) + '">' + escapeHtml(String(detail.status).replace(/_/g, ' ')) + '</span>';
    html += '</div>';
    if (detail.description) html += '<div class="agent-report-detail-body">' + escapeHtml(detail.description) + '</div>';
    if (tags.length) {
      html += '<div class="test-tags">' + tags.map((tag) => '<span class="test-tag">' + escapeHtml(tag) + '</span>').join(' ') + '</div>';
    }
    if (detail.linkedTaskIds.length) {
      html += '<h4>Linked Issues</h4><div class="test-linked-tasks">' + detail.linkedTaskIds.map((taskId) => '<span class="test-linked-task">' + escapeHtml(formatArtifactReference(taskId)) + '</span>').join(' ') + '</div>';
    }
    html += '<h4>Steps</h4>';
    if (!detail.steps.length) {
      html += '<div class="qa-report-empty">No steps recorded.</div>';
    } else {
      for (const step of detail.steps) {
        const icon = step.status === 'pass' ? '✅' : step.status === 'fail' ? '❌' : '⬜';
        html += '<div class="test-step-item">';
        html += '<span class="test-step-icon">' + icon + '</span>';
        html += '<div class="test-step-body">';
        html += '<div class="test-step-desc">' + escapeHtml(step.description || '(unnamed step)') + '</div>';
        html += '<div class="test-step-expected">Expected: ' + escapeHtml(step.expectedResult || '(none)') + '</div>';
        html += '<div class="test-step-actual">Actual: ' + escapeHtml(step.actualResult || '(none)') + '</div>';
        html += '<div class="test-step-expected">Status: ' + escapeHtml(step.status || 'unknown') + '</div>';
        html += '</div></div>';
      }
    }
    if (runs.length) {
      html += '<h4>Recent Runs</h4><div class="test-run-history">';
      for (const run of runs.slice(-5).reverse()) {
        html += '<div class="test-run-item">' +
          escapeHtml(String(run.status || 'unknown')) +
          (run.date ? ' — ' + escapeHtml(formatQaTimestamp(run.date)) : '') +
          (run.agent ? ' — ' + escapeHtml(run.agent) : '') +
          (run.notes ? ' — ' + escapeHtml(run.notes) : '') +
          '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderReadonlyTaskDetailHtml(item) {
    const detail = normalizeTaskCopySource(item && (item.detail || item));
    const comments = Array.isArray(detail.comments) ? detail.comments : [];
    const progressUpdates = Array.isArray(detail.progress_updates) ? detail.progress_updates : [];
    let html = '<div class="agent-report-detail agent-report-detail-task">';
    html += '<div class="agent-report-detail-header"><div class="agent-report-detail-heading">' + renderArtifactHeaderHtml('task', detail.id, detail.title || 'Issue') + '</div><div class="agent-report-detail-actions"><button type="button" class="entity-card-copy agent-report-overlay-copy">Copy</button><button type="button" class="agent-report-overlay-close">×</button></div></div>';
    html += '<div class="agent-report-detail-meta">';
    if (detail.status) html += '<span class="qa-report-pill tone-' + qaReportStatusTone(detail.status) + '">' + escapeHtml(String(detail.status).replace(/_/g, ' ')) + '</span>';
    html += '</div>';
    if (detail.description) html += '<div class="agent-report-detail-body">' + escapeHtml(detail.description) + '</div>';
    if (detail.detail_text) html += '<div class="agent-report-detail-body agent-report-detail-pre">' + escapeHtml(detail.detail_text) + '</div>';
    html += '<h4>Comments</h4>';
    if (!comments.length) {
      html += '<div class="qa-report-empty">No comments.</div>';
    } else {
      html += '<div class="task-entry-list">';
      for (const comment of comments) {
        html += '<div class="task-entry"><div class="task-entry-meta"><strong>' + escapeHtml(comment.author || 'Agent') + '</strong>' + (comment.created_at ? ' · ' + escapeHtml(formatQaTimestamp(comment.created_at)) : '') + '</div><div class="task-entry-text">' + escapeHtml(comment.text || '') + '</div></div>';
      }
      html += '</div>';
    }
    html += '<h4>Progress Updates</h4>';
    if (!progressUpdates.length) {
      html += '<div class="qa-report-empty">No progress updates.</div>';
    } else {
      html += '<div class="task-entry-list">';
      for (const update of progressUpdates) {
        html += '<div class="task-entry"><div class="task-entry-meta"><strong>' + escapeHtml(update.author || 'Agent') + '</strong>' + (update.created_at ? ' · ' + escapeHtml(formatQaTimestamp(update.created_at)) : '') + '</div><div class="task-entry-text">' + escapeHtml(update.text || '') + '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function closeQaReportOverlay() {
    if (qaReportOverlay && qaReportOverlay.parentNode) {
      qaReportOverlay.parentNode.removeChild(qaReportOverlay);
    }
    qaReportOverlay = null;
  }

  function ensureQaReportOverlay() {
    if (qaReportOverlay && qaReportOverlay.parentNode) return qaReportOverlay;
    const overlay = document.createElement('div');
    overlay.className = 'agent-report-overlay';
    overlay.innerHTML = '<div class="agent-report-overlay-backdrop"></div><div class="agent-report-overlay-panel"></div>';
    overlay.querySelector('.agent-report-overlay-backdrop').addEventListener('click', closeQaReportOverlay);
    document.body.appendChild(overlay);
    qaReportOverlay = overlay;
    return overlay;
  }

  function openQaReportItemOverlay(kind, item) {
    if (!item) return;
    const overlay = ensureQaReportOverlay();
    const panel = overlay.querySelector('.agent-report-overlay-panel');
    if (!panel) return;
    panel.innerHTML = kind === 'task'
      ? renderReadonlyTaskDetailHtml(item)
      : renderReadonlyTestDetailHtml(item);
    const closeBtn = panel.querySelector('.agent-report-overlay-close');
    if (closeBtn) closeBtn.addEventListener('click', closeQaReportOverlay);
    const copyBtn = panel.querySelector('.agent-report-overlay-copy');
    if (copyBtn) {
      wireCopyButton(copyBtn, () => kind === 'task'
        ? formatTaskCopyText(item && (item.detail || item))
        : formatTestCopyText(item && (item.detail || item)));
    }
  }

  function updateQaReportActionState(container, payload, scope) {
    if (!container) return;
    const section = getQaReportSection(payload, scope);
    const tests = Array.isArray(section.tests) ? section.tests : [];
    const tasks = Array.isArray(section.tasks) ? section.tasks : [];
    const failingTests = tests.filter(isQaReportFailingTest);
    const setDisabled = (selector, disabled) => {
      const button = container.querySelector(selector);
      if (button) button.disabled = !!disabled;
    };
    setDisabled('.qa-report-action[data-qa-action="copy-all-tests"]', tests.length === 0);
    setDisabled('.qa-report-action[data-qa-action="copy-failing-tests"]', failingTests.length === 0);
    setDisabled('.qa-report-action[data-qa-action="copy-all-tasks"]', tasks.length === 0);
  }

  function activeQaReportScope(container) {
    const activeTab = container && container.querySelector('.qa-report-tab.is-active');
    return (activeTab && activeTab.dataset.qaTab) || 'run';
  }

  function wireQaReportCard(container, payload) {
    if (!container) return;
    updateQaReportActionState(container, payload, activeQaReportScope(container));
    container.querySelectorAll('.qa-report-tab').forEach((tab) => {
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        const target = tab.dataset.qaTab || 'run';
        container.querySelectorAll('.qa-report-tab').forEach((node) => node.classList.toggle('is-active', node === tab));
        container.querySelectorAll('.qa-report-panel').forEach((panel) => {
          panel.classList.toggle('is-active', panel.dataset.qaPanel === target);
        });
        updateQaReportActionState(container, payload, target);
      });
    });
    container.querySelectorAll('.qa-report-row').forEach((row) => {
      row.addEventListener('click', (event) => {
        event.preventDefault();
        const kind = row.dataset.qaKind || 'test';
        const scope = row.dataset.qaScope || 'run';
        const id = row.dataset.qaId || '';
        const item = findQaReportItem(payload, scope, kind, id);
        openQaReportItemOverlay(kind, item);
      });
    });
    container.querySelectorAll('.qa-report-row-copy').forEach((button) => {
      wireCopyButton(button, () => {
        const kind = button.dataset.qaCopyKind || 'test';
        const scope = button.dataset.qaCopyScope || 'run';
        const id = button.dataset.qaCopyId || '';
        const item = findQaReportItem(payload, scope, kind, id);
        return kind === 'task'
          ? formatTaskCopyText(item && (item.detail || item))
          : formatTestCopyText(item && (item.detail || item));
      });
    });
    container.querySelectorAll('.qa-report-action').forEach((button) => {
      const action = button.dataset.qaAction || '';
      if (action === 'download-pdf') {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const scope = activeQaReportScope(container);
          vscode.postMessage({
            type: 'qaReportExportPdf',
            label: payload && payload.label ? payload.label : '',
            scope,
            updatedAt: payload && payload.updatedAt ? payload.updatedAt : '',
            section: getQaReportSection(payload, scope),
          });
        });
        return;
      }
      wireCopyButton(button, () => {
        const scope = activeQaReportScope(container);
        const section = getQaReportSection(payload, scope);
        if (action === 'copy-all-tests') return formatQaReportCollection(section.tests, 'test');
        if (action === 'copy-failing-tests') return formatQaReportCollection(section.tests, 'test', { failingOnly: true });
        if (action === 'copy-all-tasks') return formatQaReportCollection(section.tasks, 'task');
        return '';
      });
    });
  }

  // ── Section / Entry management ──────────────────────────────────────

  function closeSection() {
    currentActor = null;
    currentSection = null;
    hasContent = false;
    streamingEntry = null;
  }

  function ensureSection(label) {
    if (currentActor === label) return;
    // If split view is active and the actor is changing away from the worker,
    // teardown the split view now (places "Show Desktop" right after the worker's output)
    if (splitVncWrapper && currentActor && currentActor !== label) {
      teardownSplitVnc(true);
    }
    if (splitChromeWrapper && currentActor && currentActor !== label) {
      teardownSplitChrome(true);
    }
    closeSection();

    currentActor = label;
    const section = document.createElement('div');
    section.className = 'section';

    const header = document.createElement('div');
    header.className = `section-header ${roleClass(label)}`;
    const avatar = agentAvatar(label);
    header.textContent = avatar ? `${avatar} ${label}` : label;
    section.appendChild(header);

    // During split-view, new sections go into the left column
    const target = splitVncLeft || splitChromeLeft || messagesEl;
    target.appendChild(section);
    currentSection = section;
    hasContent = false;
  }

  function addPipe(role) {
    if (!currentSection) return;
    const pipe = document.createElement('div');
    pipe.className = `pipe ${roleClass(role)}`;
    currentSection.appendChild(pipe);
  }

  function stopPendingCard() {
    if (lastPendingCard) {
      lastPendingCard.classList.remove('mcp-card-pending');
      lastPendingCard = null;
    }
  }

  function setEntryRawText(entry, rawText) {
    if (!entry) return;
    if (rawText == null) {
      entryRawTextStore.delete(entry);
      return;
    }
    entryRawTextStore.set(entry, String(rawText));
  }

  function appendEntryRawText(entry, rawText) {
    if (!entry || rawText == null) return;
    const value = String(rawText);
    if (!value) return;
    const current = entryRawTextStore.get(entry) || '';
    entryRawTextStore.set(entry, current ? `${current}\n${value}` : value);
  }

  function getEntryRawText(entry) {
    if (!entry) return '';
    return entryRawTextStore.get(entry) || '';
  }

  function removeLiveEntityCardSlot() {
    if (activeLiveEntitySlot && activeLiveEntitySlot.parentNode) {
      activeLiveEntitySlot.parentNode.removeChild(activeLiveEntitySlot);
    }
    activeLiveEntitySlot = null;
  }

  function removeLiveQaReportCardSlot() {
    if (activeLiveQaReportSlot && activeLiveQaReportSlot.parentNode) {
      activeLiveQaReportSlot.parentNode.removeChild(activeLiveQaReportSlot);
    }
    activeLiveQaReportSlot = null;
  }

  function ensureLiveEntitySlot(role) {
    ensureSection(role);
    if (
      activeLiveEntitySlot &&
      activeLiveEntitySlot.parentNode === currentSection &&
      activeLiveEntitySlot.dataset.role === role
    ) {
      currentSection.appendChild(activeLiveEntitySlot);
      if (
        activeLiveQaReportSlot &&
        activeLiveQaReportSlot.parentNode === currentSection &&
        activeLiveQaReportSlot.dataset.role === role
      ) {
        currentSection.appendChild(activeLiveQaReportSlot);
      }
      return activeLiveEntitySlot;
    }
    removeLiveEntityCardSlot();
    const slot = document.createElement('div');
    slot.className = 'section-live-slot';
    slot.dataset.role = role;
    if (currentSection) {
      currentSection.appendChild(slot);
    }
    activeLiveEntitySlot = slot;
    return slot;
  }

  function ensureLiveQaReportSlot(role) {
    ensureSection(role);
    if (
      activeLiveQaReportSlot &&
      activeLiveQaReportSlot.parentNode === currentSection &&
      activeLiveQaReportSlot.dataset.role === role
    ) {
      currentSection.appendChild(activeLiveQaReportSlot);
      return activeLiveQaReportSlot;
    }
    removeLiveQaReportCardSlot();
    const slot = document.createElement('div');
    slot.className = 'section-live-slot section-live-qa-slot';
    slot.dataset.role = role;
    if (currentSection) {
      currentSection.appendChild(slot);
    }
    activeLiveQaReportSlot = slot;
    return slot;
  }

  function addEntry(role, html, extraClass, rawText) {
    stopPendingCard();
    clearWelcome();
    hideThinking();
    ensureSection(role);
    if (hasContent) {
      addPipe(role);
    }

    const entry = document.createElement('div');
    entry.className = `entry ${roleClass(role)}${extraClass ? ' ' + extraClass : ''}`;

    const content = document.createElement('div');
    content.className = 'entry-content';
    content.innerHTML = html;
    setEntryRawText(entry, rawText);

    // Copy button (hidden, shows on hover)
    var copyBtn = document.createElement('button');
    copyBtn.className = 'entry-copy';
    copyBtn.textContent = '\uD83D\uDCCB';
    copyBtn.title = 'Copy';
    wireCopyButton(copyBtn, function() {
      return getEntryRawText(entry) || content.textContent;
    });

    entry.appendChild(content);
    entry.appendChild(copyBtn);
    currentSection.appendChild(entry);
    hasContent = true;
    autoScroll();
    maybeShowThinking();
    return entry;
  }

  function renderUserEntryContent(entry, msg) {
    if (!entry || !msg) return;
    const content = entry.querySelector('.entry-content');
    if (!content) return;

    const state = getUserMessageDisplayState(msg);
    const body = document.createElement('div');
    body.className = `user-message-body${state.isLong ? ' is-long' : ''}${state.expanded ? ' is-expanded' : ' is-collapsed'}`;
    body.textContent = state.expanded ? state.fullText : state.previewText;

    content.replaceChildren(body);

    if (!state.isLong) return;

    const actions = document.createElement('div');
    actions.className = 'user-message-actions';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'user-message-toggle';
    toggle.textContent = state.expanded ? 'Collapse' : 'Expand';
    toggle.setAttribute('aria-expanded', state.expanded ? 'true' : 'false');
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      msg._userMessageExpanded = !state.expanded;
      renderUserEntryContent(entry, msg);
    });

    actions.appendChild(toggle);
    content.appendChild(actions);
  }

  function addBanner(text) {
    closeSection();
    const el = document.createElement('div');
    el.className = 'banner';
    el.textContent = text;
    messagesEl.appendChild(el);
    autoScroll();
  }

  // ── Streaming support ──────────────────────────────────────────────

  function streamLine(label, text) {
    hideThinking();
    const role = label || 'Worker';
    ensureSection(role);

    if (!streamingEntry) {
      // First streamed line — create a new entry (skip maybeShowThinking via addEntry)
      const savedRunning = isRunning;
      isRunning = false;
      streamingEntry = addEntry(role, renderInlineMarkdown(text), '', text);
      isRunning = savedRunning;
    } else {
      // Append to existing streaming entry
      const content = streamingEntry.querySelector('.entry-content');
      if (content) {
        content.innerHTML += '\n' + renderInlineMarkdown(text);
      }
      appendEntryRawText(streamingEntry, text);
    }
    autoScroll();
    maybeShowThinking();
  }

  // ── Message handlers ───────────────────────────────────────────────

  // ── Feature flags ──────────────────────────────────────────────────
  let _featureFlags = {};
  function applyFeatureFlags(flags) {
    _featureFlags = flags || {};
    // Hide Instances and Computer tabs when remote desktop is disabled
    if (!flags.enableRemoteDesktop) {
      const tabBtns = tabBar.querySelectorAll('.tab-btn');
      tabBtns.forEach(btn => {
        if (btn.dataset.tab === 'instances' || btn.dataset.tab === 'computer') {
          btn.style.display = 'none';
        }
      });
    }
    // Hide Skip Setup button when there's nothing to skip (no CLI choice)
    if (!flags.enableClaudeCli) {
      const skipBtn = document.getElementById('onboard-skip');
      if (skipBtn) skipBtn.style.display = 'none';
    }
    // Hide Claude UI when the feature is disabled, but preserve active/imported Claude selections.
    syncClaudeUiVisibility();
  }

  const handlers = {
    user(msg) {
      streamingEntry = null;
      const entry = addEntry('User', '', '', msg.text);
      renderUserEntryContent(entry, msg);
    },

    controller(msg) {
      streamingEntry = null;
      setBuddyState('thinking');
      const text = msg.text || '';
      const label = msg.label || 'Orchestrator';
      // Parse JSON decisions into a formatted card
      if (text.startsWith('{') && text.includes('"action"')) {
        try {
          const d = JSON.parse(text);
          addEntry(label, renderDecisionCard(d), 'decision-card', text);
          return;
        } catch {}
      }
      // Dim status/progress lines
      const statusPatterns = ['Started controller session', 'Thinking about', 'Finished the current controller'];
      if (statusPatterns.some(p => text.startsWith(p))) {
        addEntry(label, escapeHtml(text), 'status-line', text);
        return;
      }
      addEntry(label, renderInlineMarkdown(text), '', text);
    },

    claude(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Worker', renderInlineMarkdown(msg.text), '', msg.text);
      maybeShowThinking();
    },

    shell(msg) {
      streamingEntry = null;
      addEntry('Shell', renderInlineMarkdown(msg.text), '', msg.text);
    },

    error(msg) {
      streamingEntry = null;
      lastRunOutcome = 'error';
      setBuddyState('sad');
      addEntry(msg.label || 'Error', escapeHtml(msg.text), 'role-error', msg.text);
    },

    banner(msg) {
      streamingEntry = null;
      addBanner(msg.text);
    },

    qaReportExported(msg) {
      if (!msg || !msg.url) return;
      const link = document.createElement('a');
      link.href = msg.url;
      if (msg.fileName) link.download = msg.fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
      }
    },

    line(msg) {
      streamingEntry = null;
      addEntry(msg.label, renderInlineMarkdown(msg.text), '', msg.text);
    },

    mdLine(msg) {
      streamingEntry = null;
      addEntry(msg.label, renderMarkdown(msg.text), '', msg.text);
    },

    streamLine(msg) {
      streamLine(msg.label, msg.text);
    },

    flushStream() {
      streamingEntry = null;
      maybeShowThinking();
    },

    toolCall(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Worker', escapeHtml(msg.text), 'tool-call', msg.text);
      // Show the correct widget based on the active agent's CLI backend
      if (msg.isComputerUse || msg.isChromeDevtools) {
        if (_isCurrentAgentRemote() && novncPort && !splitVncWrapper) {
          showSplitVnc();
        } else if (!_isCurrentAgentRemote() && chromePort && !splitChromeWrapper) {
          showSplitChrome();
        }
      }
      maybeShowThinking();
    },

    testCard(msg) {
      streamingEntry = null;
      const d = msg.data || {};
      const entry = addEntry(msg.label || 'QA', renderTestCardHtml(d, { includeCopy: true }), 'test-card-entry');
      const copyBtn = entry.querySelector('.entity-card-copy');
      if (copyBtn) wireCopyButton(copyBtn, () => formatTestCopyText(d));
      if (!suppressUiLog) {
        vscode.postMessage({ type: 'logChatEntry', entry: { type: 'testCard', label: msg.label || 'QA', data: d } });
      }
      if (shouldCelebrateTestCard(msg)) triggerConfetti();
    },

    bugCard(msg) {
      streamingEntry = null;
      const d = msg.data || {};
      const entry = addEntry(msg.label || 'QA', renderBugCardHtml(d, { includeCopy: true }), 'bug-card-entry');
      const copyBtn = entry.querySelector('.entity-card-copy');
      if (copyBtn) wireCopyButton(copyBtn, () => formatBugCopyText(d));
      if (!suppressUiLog) {
        vscode.postMessage({ type: 'logChatEntry', entry: { type: 'bugCard', label: msg.label || 'QA', data: d } });
      }
    },

    taskCard(msg) {
      streamingEntry = null;
      const d = msg.data || {};
      const entry = addEntry(msg.label || 'Worker', renderTaskCardHtml(d, { includeCopy: true }), 'task-card-entry');
      const copyBtn = entry.querySelector('.entity-card-copy');
      if (copyBtn) wireCopyButton(copyBtn, () => formatTaskCopyText(d));
      if (!suppressUiLog) {
        vscode.postMessage({ type: 'logChatEntry', entry: { type: 'taskCard', label: msg.label || 'Worker', data: d } });
      }
    },

    liveEntityCard(msg) {
      streamingEntry = null;
      const role = msg.label || 'Worker';
      const slot = ensureLiveEntitySlot(role);
      const entityType = msg.entityType || 'task';
      const data = msg.data || {};
      slot.innerHTML = entityType === 'test'
        ? renderTestCardHtml(data, { live: true, includeCopy: true })
        : renderTaskCardHtml(data, { live: true, includeCopy: true });
      const copyBtn = slot.querySelector('.entity-card-copy');
      if (copyBtn) {
        wireCopyButton(copyBtn, () => (
          entityType === 'test'
            ? formatTestCopyText(data)
            : formatTaskCopyText(data)
        ));
      }
      autoScroll();
    },

    clearLiveEntityCard() {
      removeLiveEntityCardSlot();
    },

    liveQaReportCard(msg) {
      streamingEntry = null;
      const role = msg.label || 'QA';
      const slot = ensureLiveQaReportSlot(role);
      const data = msg.data || {};
      const payload = { ...data, label: msg.label || 'QA' };
      slot.innerHTML = renderQaReportCardHtml(payload, { live: true });
      wireQaReportCard(slot, payload);
      autoScroll();
    },

    clearLiveQaReportCard() {
      removeLiveQaReportCardSlot();
    },

    qaReportCard(msg) {
      streamingEntry = null;
      const data = msg.data || {};
      const payload = { ...data, label: msg.label || 'QA' };
      const entry = addEntry(msg.label || 'QA', renderQaReportCardHtml(payload, {}), 'qa-report-card-entry');
      wireQaReportCard(entry, payload);
      if (!suppressUiLog) {
        vscode.postMessage({ type: 'logChatEntry', entry: { type: 'qaReportCard', label: msg.label || 'QA', data } });
      }
    },

    mcpCardStart(msg) {
      // Pending card — pulsing, dimmed, with "..." text
      var d = msg;
      var html = '<div class="mcp-card mcp-card-pending" id="' + escapeHtml(d.id || '') + '">';
      if (d.template === 'command') {
        html += '<span class="mcp-card-icon">\u25B6\uFE0F</span> <code>' + escapeHtml(d.detail || '...') + '</code>';
      } else {
        html += '<span class="mcp-card-icon">' + (d.icon || '') + '</span> <span class="mcp-card-text">' + escapeHtml(d.text || '...') + (d.detail ? ' <span class="mcp-card-detail">' + escapeHtml(d.detail) + '</span>' : '') + '</span>';
      }
      html += '</div>';
      addEntry(msg.label || 'Worker', html, 'mcp-card-entry');
      if (msg.isComputerUse || msg.isChromeDevtools) {
        if (_isCurrentAgentRemote() && novncPort && !splitVncWrapper) {
          showSplitVnc();
        } else if (!_isCurrentAgentRemote() && chromePort && !splitChromeWrapper) {
          showSplitChrome();
        }
      }
      // Track this as the last pending card — next addEntry will stop it
      var newCard = d.id ? document.getElementById(d.id) : null;
      if (!newCard) { var pending = messagesEl.querySelectorAll('.mcp-card-pending'); newCard = pending[pending.length - 1]; }
      lastPendingCard = newCard || null;
    },

    mcpCardComplete(msg) {
      // Find the pending card and update it
      var pending = msg.id ? document.getElementById(msg.id) : null;
      if (pending) {
        if (msg.remove) {
          // For cards that get replaced by a full card (testSuite, comment, etc.)
          pending.closest('.entry').remove();
          return;
        }
        pending.classList.remove('mcp-card-pending');
        if (msg.template === 'command') {
          pending.innerHTML = '<span class="mcp-card-icon">\u25B6\uFE0F</span> <code>' + escapeHtml(msg.detail || '') + '</code>';
        } else {
          pending.innerHTML = '<span class="mcp-card-icon">' + (msg.icon || '') + '</span> <span class="mcp-card-text"><strong>' + escapeHtml(msg.text || '') + '</strong>' + (msg.detail ? ' <span class="mcp-card-detail">' + escapeHtml(msg.detail) + '</span>' : '') + '</span>';
        }
        return;
      }
      // Fallback: no pending card found, create a completed card directly
      var html = '<div class="mcp-card">';
      if (msg.template === 'command') {
        html += '<span class="mcp-card-icon">\u25B6\uFE0F</span> <code>' + escapeHtml(msg.detail || '') + '</code>';
      } else {
        html += '<span class="mcp-card-icon">' + (msg.icon || '') + '</span> <strong>' + escapeHtml(msg.text || '') + '</strong>';
        if (msg.detail) html += ' <span class="mcp-card-detail">' + escapeHtml(msg.detail) + '</span>';
      }
      html += '</div>';
      addEntry(msg.label || 'Worker', html, 'mcp-card-entry');
    },

    mcpCard(msg) {
      var d = msg.data || {};
      var c = msg.card;
      var html = '';

      // Generic action card (most tools use this)
      if (c === 'action') {
        html = '<div class="mcp-card"><span class="mcp-card-icon">' + (d.icon || '') + '</span> <strong>' + escapeHtml(d.text || '') + '</strong>';
        if (d.detail) html += ' <span class="mcp-card-detail">' + escapeHtml(d.detail) + '</span>';
        html += '</div>';
      }
      // Command execution
      else if (c === 'command') {
        html = '<div class="mcp-card command"><span class="mcp-card-icon">\u25B6\uFE0F</span> <code>' + escapeHtml(d.command || '') + '</code></div>';
      }
      // Test suite summary
      else if (c === 'testSuite') {
        html = '<div class="mcp-card test-suite"><span class="mcp-card-icon">\uD83D\uDC3C\uD83D\uDCCA</span> <strong>Test Suite:</strong> <span class="pass">' + (d.passing || 0) + ' passing</span> \u00B7 <span class="fail">' + (d.failing || 0) + ' failing</span> \u00B7 ' + (d.total || 0) + ' total</div>';
      }
      // Task status change
      else if (c === 'taskStatus') {
        html = '<div class="mcp-card task-status"><span class="mcp-card-icon">\uD83D\uDCCB</span> ' + escapeHtml(d.title || '') + ' \u2192 <span class="mcp-card-badge">' + escapeHtml(d.status || '') + '</span></div>';
      }
      // Task comment
      else if (c === 'taskComment') {
        html = '<div class="mcp-card task-comment"><span class="mcp-card-icon">\uD83D\uDCAC</span> <strong>' + escapeHtml(d.author || 'agent') + ':</strong> ' + escapeHtml(d.text || '') + '</div>';
      }

      if (html) addEntry(msg.label || 'QA', html, 'mcp-card-entry');
    },

    stop(msg) {
      streamingEntry = null;
      addEntry((msg && msg.label) || 'Controller', 'STOP', '', 'STOP');
    },

    chatScreenshot(msg) {
      // Inline screenshot thumbnail (from Chrome/VNC teardown or restored from chat.jsonl)
      if (msg.data && msg.data.startsWith('data:')) {
        clearWelcome();
        hideThinking();
        const thumb = document.createElement('img');
        thumb.src = msg.data;
        thumb.className = 'chat-screenshot';
        thumb.alt = msg.alt || 'Screenshot';
        const target = currentSection || messagesEl;
        target.appendChild(thumb);
        if (currentSection) {
          hasContent = true;
        }
        autoScroll();
      }
    },

    requestStarted(msg) {
      streamingEntry = null;
      setBuddyState('working');
      removeLiveQaReportCardSlot();
      closeQaReportOverlay();
      addBanner(`Attached run ${msg.runId}`);
    },

    requestFinished(msg) {
      streamingEntry = null;
      setBuddyState('happy');
      if (msg.message) {
        addBanner(msg.message);
      }
    },

    clear() {
      resetChatView();
      messageLog = [];
      pendingVisibleHistoryTrim = false;
      currentRunId = null;
      resetAgentBrowserOverrides();
      updateAgentBrowserToggle();
      updateBrowserStatus();
      renderUsageSummary(null);
      hideProgressBubble();
      saveState();
    },

    close() {
      teardownSplitVnc(false);
      teardownSplitChrome(false);
      streamingEntry = null;
      removeLiveEntityCardSlot();
      removeLiveQaReportCardSlot();
      closeQaReportOverlay();
      closeSection();
    },

    running(msg) {
      if (msg.value) {
        isRunning = true;
        lastRunOutcome = null;
        setBuddyState('working');
        hideReviewMenu();
        btnSend.style.display = 'none';
        if (btnContinue) btnContinue.style.display = 'none';
        if (reviewSplit) reviewSplit.style.display = 'none';
        if (btnOrchestrate) btnOrchestrate.style.display = 'none';
        btnStop.style.display = msg.showStop === false ? 'none' : 'inline-block';
        textarea.disabled = true;
        showThinking();
      } else {
        isRunning = false;
        hideThinking();
        flashPandaMascot(lastRunOutcome === 'error' ? 'sad' : 'happy');
        setBuddyState(lastRunOutcome === 'error' ? 'sad' : 'happy');
        lastRunOutcome = null;
        // Split VNC is torn down by ensureSection() when the actor changes.
        // As a fallback, teardown here too in case no new section was created.
        if (splitVncWrapper) teardownSplitVnc(true);
        if (splitChromeWrapper) teardownSplitChrome(true);
        btnSend.style.display = 'inline-block';
        if (btnContinue) btnContinue.style.display = 'inline-block';
        if (btnOrchestrate) btnOrchestrate.style.display = 'inline-block';
        btnStop.style.display = 'none';
        textarea.disabled = false;
        renderReviewControls();
        if (pendingVisibleHistoryTrim) {
          maybeTrimVisibleHistory();
        }
        textarea.focus();
      }
    },

    initConfig(msg) {
      initConfigReceived = true;
      if (readyRetryTimer) {
        clearInterval(readyRetryTimer);
        readyRetryTimer = null;
      }
      _dbg('initConfig received: panelId=' + (msg.panelId || ''));
      if (msg.apiCatalog) {
        applyApiCatalog(msg.apiCatalog);
      }
      cloudBootstrap = msg.cloud || cloudBootstrap;
      cloudSessionState = msg.cloudSession || cloudSessionState;
      cloudStatusState = msg.cloudStatus || cloudStatusState;
      if (msg.cloudStatus) syncCloudContextDraftFromRuntime();
      cloudPendingAction = '';
      cloudNoticeText = '';
      renderCloudAccount();
      renderCloudEntryScreen();
      setConfig(msg.config);
      if (msg.workspace !== undefined) currentWorkspace = msg.workspace || null;
      if (msg.resume !== undefined) currentResumeToken = msg.resume || null;
      if (msg.rootIdentity !== undefined) currentRootIdentity = msg.rootIdentity || null;
      if (msg.panelId && msg.panelId !== panelId) {
        panelId = msg.panelId;
        saveState();
      }
      if (msg.mcpServers) {
        mcpGlobal = msg.mcpServers.global || {};
        mcpProject = msg.mcpServers.project || {};
        renderMcpList('global');
        renderMcpList('project');
      }
      if (msg.agents) {
        agentsSystem = msg.agents.system || {};
        agentsSystemMeta = msg.agents.systemMeta || {};
        agentsGlobal = msg.agents.global || {};
        agentsProject = msg.agents.project || {};
        renderAgentList('system');
        renderAgentList('global');
        renderAgentList('project');
        refreshTargetDropdown();
        // Sync restored chatTarget to session manager (dropdown now has agent options)
        if (cfgChatTarget) {
          vscode.postMessage({ type: 'configChanged', config: { chatTarget: cfgChatTarget.value } });
        }
      }
      if (msg.modes) {
        modesSystem = msg.modes.system || {};
        modesSystemMeta = msg.modes.systemMeta || {};
        modesGlobal = msg.modes.global || {};
        modesProject = msg.modes.project || {};
        renderModeList('system');
        renderModeList('global');
        renderModeList('project');
      }
      // Set onboarding state from extension host
      if (msg.onboarding) {
        onboardingComplete = !!msg.onboarding.complete;
        _dbg('initConfig: onboardingComplete=' + onboardingComplete);
      }
      // Apply feature flags — hide tabs and options for disabled features
      if (msg.featureFlags) applyFeatureFlags(msg.featureFlags);
      // If onboarding is done (or has a saved chatTarget), go straight to chat.
      // Otherwise show onboarding detection wizard.
      _dbg('initConfig DECISION: onboardingComplete=' + onboardingComplete);
      if (onboardingComplete) {
        goToChat();
      } else {
        showInitWizard();
      }
      renderCloudEntryScreen();
      saveState();
    },

    panelContext(msg) {
      const context = msg && msg.context ? msg.context : {};
      currentWorkspace = context.workspace || null;
      currentResumeToken = context.resume || null;
      currentRootIdentity = context.rootIdentity || null;
      saveState();
    },

    agentsData(msg) {
      if (msg.agents) {
        agentsSystem = msg.agents.system || {};
        agentsSystemMeta = msg.agents.systemMeta || {};
        agentsGlobal = msg.agents.global || {};
        agentsProject = msg.agents.project || {};
        renderAgentList('system');
        renderAgentList('global');
        renderAgentList('project');
        refreshTargetDropdown();
      }
    },

    readyAck(msg) {
      if (msg && msg.readySessionId && msg.readySessionId !== readySessionId) {
        return;
      }
      if (readyRetryTimer) {
        clearInterval(readyRetryTimer);
        readyRetryTimer = null;
      }
    },

    modesData(msg) {
      if (msg.modes) {
        modesSystem = msg.modes.system || {};
        modesSystemMeta = msg.modes.systemMeta || {};
        modesGlobal = msg.modes.global || {};
        modesProject = msg.modes.project || {};
        renderModeList('system');
        renderModeList('global');
        renderModeList('project');
      }
    },

    syncConfig(msg) {
      setConfig(msg.config);
      saveState();
    },

    usageStats(msg) {
      renderUsageSummary(msg.summary || null);
    },

    reviewState(msg) {
      reviewState = {
        visible: !!(msg.reviewState && msg.reviewState.visible),
        isGitRepo: !!(msg.reviewState && msg.reviewState.isGitRepo),
        hasUnstaged: !!(msg.reviewState && msg.reviewState.hasUnstaged),
        hasStaged: !!(msg.reviewState && msg.reviewState.hasStaged),
        defaultScope: msg.reviewState ? msg.reviewState.defaultScope || null : null,
        unstagedCount: msg.reviewState ? Number(msg.reviewState.unstagedCount || 0) : 0,
        stagedCount: msg.reviewState ? Number(msg.reviewState.stagedCount || 0) : 0,
      };
      renderReviewControls();
    },

    instancesData(msg) {
      instancesList = msg.instances || [];
      if (msg.useSnapshot !== undefined) {
        useSnapshot = msg.useSnapshot;
        const cb = document.getElementById('use-snapshot-checkbox');
        if (cb) cb.checked = useSnapshot;
      }
      if (msg.snapshotExists !== undefined) {
        workspaceSnapshotExists = msg.snapshotExists;
        workspaceSnapshotTag = msg.snapshotTag || '';
      }
      setInstancesLoading(false, msg._actionId);
      renderInstances();
    },

    instanceSettings(msg) {
      useSnapshot = msg.useSnapshot;
      const cb = document.getElementById('use-snapshot-checkbox');
      if (cb) cb.checked = useSnapshot;
      setInstancesLoading(false, msg._actionId);
      renderInstances();
    },

    desktopReady(msg) {
      novncPort = msg.novncPort || null;
      updateComputerTab();
      saveState();
    },

    desktopGone() {
      novncPort = null;
      updateComputerTab();
      teardownSplitVnc(false);
      saveState();
    },

    computerUseDetected() {
      if (novncPort && !splitVncWrapper) {
        showSplitVnc();
      }
    },

    chromeReady(msg) {
      chromePort = msg.chromePort || null;
      _dbg(`chromeReady: chromePort=${chromePort || 'null'}`);
      updateBrowserStatus();
      updateBrowserTab();
      saveState();
    },

    chromeFrame(msg) {
      chromeFrameDebugCount += 1;
      if (msg.metadata) {
        chromeMeta = {
          deviceWidth: msg.metadata.deviceWidth || 1280,
          deviceHeight: msg.metadata.deviceHeight || 720,
          offsetTop: msg.metadata.offsetTop || 0,
          pageScaleFactor: msg.metadata.pageScaleFactor || 1,
        };
      }
      if (chromeFrameDebugCount <= 3 || chromeFrameDebugCount % 100 === 0) {
        _dbg(`chromeFrame: count=${chromeFrameDebugCount} chromePort=${chromePort || 'null'} meta=${JSON.stringify(chromeMeta)}`);
      }
      const dataUrl = 'data:image/jpeg;base64,' + msg.data;
      const splitImg = chromeImgEl || document.querySelector('.chrome-screencast-img');
      if (splitImg) splitImg.src = dataUrl;
      const tabImg = document.getElementById('browser-chrome-frame');
      if (tabImg) {
        tabImg.src = dataUrl;
        tabImg.style.display = 'block';
      }
      const ph = document.getElementById('browser-placeholder');
      if (ph) ph.style.display = 'none';
      showBrowserNav();
    },

    chromeUrl(msg) {
      const urlInput = document.getElementById('browser-url');
      if (urlInput && msg.url) urlInput.value = msg.url;
      _dbg(`chromeUrl: chromePort=${chromePort || 'null'} url=${msg.url || ''}`);
    },

    chromeGone() {
      _dbg(`chromeGone: previousChromePort=${chromePort || 'null'}`);
      chromePort = null;
      chromeImgEl = null;
      chromeFrameDebugCount = 0;
      updateBrowserStatus();
      updateBrowserTab();
      hideBrowserNav();
      teardownSplitChrome(false);
      saveState();
    },

    tasksData(msg) {
      _dbg('tasksData received: count=' + ((msg.tasks && msg.tasks.length) || 0));
      kanbanTasks = msg.tasks || [];
      // If we're viewing a task detail, refresh it; otherwise refresh board
      if (taskDetail.style.display !== 'none') {
        const openId = taskDetail.dataset.taskId;
        const updated = kanbanTasks.find(t => t.id === openId);
        if (updated) showTaskForm(updated);
        else renderKanban();
      } else {
        renderKanban();
      }
    },

    testsData(msg) {
      _dbg('testsData received: count=' + ((msg.tests && msg.tests.length) || 0));
      testBoardData = msg.tests || [];
      if (testDetailEl && testDetailEl.style.display !== 'none') {
        // If detail is open, refresh it
        const openId = testDetailEl.dataset && testDetailEl.dataset.testId;
        const updated = testBoardData.find(t => t.id === openId);
        if (updated) showTestForm(updated);
        else { testDetailEl.style.display = 'none'; testDetailEl.innerHTML = ''; if (testBoardEl) testBoardEl.style.display = ''; renderTestBoard(); }
      } else {
        renderTestBoard();
      }
    },

    setRunId(msg) {
      currentRunId = msg.runId || null;
      if (currentRunId && !currentResumeToken) {
        currentResumeToken = currentRunId;
      }
      saveState();
    },

    clearRunId() {
      _dbg('clearRunId: before runId=' + (currentRunId || 'null') + ' resume=' + (currentResumeToken || 'null'));
      currentRunId = null;
      resetAgentBrowserOverrides();
      updateAgentBrowserToggle();
      updateBrowserStatus();
      renderUsageSummary(null);
      removeLiveQaReportCardSlot();
      hideProgressBubble();
      saveState();
      _dbg('clearRunId: after runId=' + (currentRunId || 'null') + ' resume=' + (currentResumeToken || 'null'));
    },

    progressFull(msg) {
      setProgressContent(msg.text || '');
    },

    progressLine(msg) {
      appendProgressLine(msg.text || '');
    },

    transcriptHistory(msg) {
      // Rebuild chat from transcript on disk — clear existing UI and messageLog.
      // Do NOT call saveState() here: the transcript is authoritative on disk,
      // so there is nothing to persist back into webview state.
      resetChatView();
      messageLog = [];
      pendingVisibleHistoryTrim = false;

      if (Array.isArray(msg.messages)) {
        suppressUiLog = true;
        try {
          withSuppressedCelebrationEffects(() => {
            for (const entry of msg.messages) {
              const handler = handlers[entry.type];
              if (handler) {
                handler(entry);
                messageLog.push(entry);
              }
            }
          });
        } finally {
          suppressUiLog = false;
        }
      }
    },

    waitStatus() {
      // Handled via banners; no additional UI needed
    },

    runHistory(msg) {
      clearWelcome();
      var old = messagesEl.querySelector('.run-history');
      if (old) old.remove();

      var runs = msg.runs || [];
      var pageSize = 5;
      var shown = 0;

      var container = document.createElement('div');
      container.className = 'run-history';

      // Header with close button
      var header = document.createElement('div');
      header.className = 'run-history-header';
      var headerText = document.createElement('span');
      headerText.textContent = 'Recent Sessions';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'run-history-close';
      closeBtn.textContent = '\u2715';
      closeBtn.addEventListener('click', function() { container.remove(); });
      header.appendChild(headerText);
      header.appendChild(closeBtn);
      container.appendChild(header);

      if (runs.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'run-history-empty';
        empty.textContent = 'No previous sessions found.';
        container.appendChild(empty);
      } else {
        var list = document.createElement('div');
        list.className = 'run-history-list';
        container.appendChild(list);

        var moreBtn = null;

        function createCard(run) {
          var card = document.createElement('div');
          card.className = 'run-history-card';
          var titleEl = document.createElement('div');
          titleEl.className = 'run-history-title';
          titleEl.textContent = run.title || run.runId;
          var metaEl = document.createElement('div');
          metaEl.className = 'run-history-meta';
          metaEl.textContent = _formatRelativeTime(run.updatedAt) + (run.status !== 'idle' ? ' \u2022 ' + run.status : '');
          card.appendChild(titleEl);
          card.appendChild(metaEl);
          card.setAttribute('data-run-id', run.runId);
          card.addEventListener('click', function() {
            var rid = this.getAttribute('data-run-id');
            container.remove();
            vscode.postMessage({ type: 'userInput', text: '/resume ' + rid });
          });
          return card;
        }

        function showMore() {
          var end = Math.min(shown + pageSize, runs.length);
          for (var i = shown; i < end; i++) {
            list.appendChild(createCard(runs[i]));
          }
          shown = end;
          if (shown < runs.length) {
            if (!moreBtn) {
              moreBtn = document.createElement('button');
              moreBtn.className = 'run-history-more';
              moreBtn.addEventListener('click', showMore);
              container.appendChild(moreBtn);
            }
            moreBtn.textContent = 'Show more (' + (runs.length - shown) + ' remaining)';
          } else if (moreBtn) {
            moreBtn.remove();
            moreBtn = null;
          }
        }

        showMore();
      }

      messagesEl.appendChild(container);
      autoScroll();
    },

    importChatHistory(msg) {
      clearWelcome();
      if (msg.requestId && !importChatPickerState) {
        return;
      }
      if (msg.requestId && importChatPickerState && importChatPickerState.lastRequestId && msg.requestId !== importChatPickerState.lastRequestId) {
        return;
      }

      var state = importChatPickerState;
      if (!state || !state.container || !state.container.isConnected) {
        var old = messagesEl.querySelector('.run-history');
        if (old) old.remove();
        state = {
          container: document.createElement('div'),
          provider: null,
          query: '',
          lastRequestId: null,
          searchInput: null,
          searchStatusEl: null,
          searching: false,
        };
        state.container.className = 'run-history run-history-import';
        importChatPickerState = state;
      }

      if (Object.prototype.hasOwnProperty.call(msg, 'provider')) {
        state.provider = msg.provider || null;
      }
      if (typeof msg.query === 'string') {
        state.query = msg.query;
      }
      if (msg.requestId) {
        state.lastRequestId = msg.requestId;
      }
      state.searching = false;
      var sessions = Array.isArray(msg.sessions) ? msg.sessions : [];
      var pageSize = 5;
      var shown = 0;
      var hadSearchFocus = !!(state.searchInput && document.activeElement === state.searchInput);
      var container = state.container;
      container.innerHTML = '';

      var header = document.createElement('div');
      header.className = 'run-history-header';
      var headerText = document.createElement('span');
      headerText.textContent = 'Import Existing Chat';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'run-history-close';
      closeBtn.textContent = '\u2715';
      closeBtn.addEventListener('click', function() { closeImportChatPicker(); });
      header.appendChild(headerText);
      header.appendChild(closeBtn);
      container.appendChild(header);

      var searchWrap = document.createElement('div');
      searchWrap.className = 'run-history-search';
      var searchInput = document.createElement('input');
      searchInput.className = 'run-history-search-input';
      searchInput.type = 'search';
      searchInput.placeholder = importChatSearchPlaceholder(state.provider);
      searchInput.value = state.query || '';
      searchInput.setAttribute('aria-label', 'Search imported chat messages');
      searchInput.addEventListener('input', function() {
        state.query = this.value;
        state.searching = true;
        if (state.searchStatusEl) {
          state.searchStatusEl.textContent = state.query
            ? 'Searching chat messages...'
            : 'Loading recent chats...';
        }
        queueImportChatSearch(state, state.query);
      });
      searchWrap.appendChild(searchInput);
      var searchStatus = document.createElement('div');
      searchStatus.className = 'run-history-search-status';
      if (state.searching) {
        searchStatus.textContent = state.query
          ? 'Searching chat messages...'
          : 'Loading recent chats...';
      }
      searchWrap.appendChild(searchStatus);
      container.appendChild(searchWrap);
      state.searchInput = searchInput;
      state.searchStatusEl = searchStatus;

      if (sessions.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'run-history-empty';
        empty.textContent = state.query
          ? 'No chat messages matched "' + state.query + '".'
          : 'No importable chats found.';
        container.appendChild(empty);
      } else {
        var list = document.createElement('div');
        list.className = 'run-history-list';
        container.appendChild(list);

        var moreBtn = null;

        function createCard(session) {
          var card = document.createElement('div');
          card.className = 'run-history-card';
          var titleEl = document.createElement('div');
          titleEl.className = 'run-history-title';
          titleEl.textContent = session.title || (session.provider + ' ' + session.sessionId);
          var metaEl = document.createElement('div');
          metaEl.className = 'run-history-meta';
          var relative = _formatRelativeTime(session.updatedAt);
          metaEl.textContent = session.provider + ' \u2022 ' + session.sessionId + (relative ? ' \u2022 ' + relative : '');
          card.appendChild(titleEl);
          card.appendChild(metaEl);
          if (session.preview) {
            var previewEl = document.createElement('div');
            previewEl.className = 'run-history-meta';
            previewEl.textContent = session.preview;
            card.appendChild(previewEl);
          }
          if (session.matchPreview) {
            var matchEl = document.createElement('div');
            matchEl.className = 'run-history-match';
            matchEl.textContent = 'Match: ' + session.matchPreview;
            card.appendChild(matchEl);
          }
          card.setAttribute('data-provider', session.provider);
          card.setAttribute('data-session-id', session.sessionId);
          card.addEventListener('click', function() {
            var selectedProvider = this.getAttribute('data-provider');
            var selectedSessionId = this.getAttribute('data-session-id');
            closeImportChatPicker();
            vscode.postMessage({ type: 'userInput', text: '/import-chat ' + selectedProvider + ' ' + selectedSessionId });
          });
          return card;
        }

        function showMore() {
          var end = Math.min(shown + pageSize, sessions.length);
          for (var i = shown; i < end; i++) {
            list.appendChild(createCard(sessions[i]));
          }
          shown = end;
          if (shown < sessions.length) {
            if (!moreBtn) {
              moreBtn = document.createElement('button');
              moreBtn.className = 'run-history-more';
              moreBtn.addEventListener('click', showMore);
              container.appendChild(moreBtn);
            }
            moreBtn.textContent = 'Show more (' + (sessions.length - shown) + ' remaining)';
          } else if (moreBtn) {
            moreBtn.remove();
            moreBtn = null;
          }
        }

        showMore();
      }

      if (!container.isConnected) {
        messagesEl.appendChild(container);
      }
      if (hadSearchFocus) {
        searchInput.focus();
      }
      autoScroll();
    },

    rawEvent() {
      // Ignored in UI
    },

    onboardingDetected(msg) {
      _dbg('onboardingDetected received');
      if (msg.detected) {
        renderOnboardingDetected(msg.detected);
      }
    },

    onboardingFixProgress(msg) {
      var el = document.getElementById('fix-output-' + msg.step);
      if (el) { el.textContent += msg.text; el.scrollTop = el.scrollHeight; }
    },

    onboardingFixDone(msg) {
      var outputEl = document.getElementById('fix-output-' + msg.step);
      if (outputEl) {
        outputEl.textContent += msg.success ? '\n✅ Done!\n' : '\n❌ Failed: ' + (msg.error || 'unknown error') + '\n';
        outputEl.scrollTop = outputEl.scrollHeight;
      }
      // Auto re-check after a short delay
      if (msg.success) {
        setTimeout(function () { renderOnboardingStep(); }, 1500);
      }
    },

    onboardingComplete(msg) {
      _dbg('onboardingComplete received');
      onboardingComplete = true;
      if (msg.onboarding && msg.onboarding.data && msg.onboarding.data.defaults) {
        // Apply defaults to config dropdowns
        const defaults = msg.onboarding.data.defaults;
        if (defaults.controllerCli) {
          vscode.postMessage({ type: 'configChanged', config: { controllerCli: defaults.controllerCli, workerCli: defaults.workerCli } });
        }
      }
    },

    settingsData(msg) {
      if (!msg.settings) return;
      if (msg.cloudStatus) {
        cloudStatusState = msg.cloudStatus;
      }
      if (msg.cloudSession) {
        cloudSessionState = msg.cloudSession;
        cloudPendingAction = '';
        cloudNoticeText = '';
      }
      renderCloudAccount();
      renderCloudEntryScreen();
      const selfTestToggle = document.getElementById('setting-self-testing');
      if (selfTestToggle) {
        selfTestToggle.checked = !!msg.settings.selfTesting;
      }
      if (lazyMcpToolsToggle) {
        lazyMcpToolsToggle.checked = !!msg.settings.lazyMcpToolsEnabled;
      }
      if (learnedApiToolsToggle) {
        learnedApiToolsToggle.checked = !!msg.settings.learnedApiToolsEnabled;
      }
      learnedApiToolEntries = Array.isArray(msg.learnedApiTools) ? msg.learnedApiTools : [];
      renderLearnedToolsModal();
      // Populate prompt textareas (custom value or default)
      const defaults = msg.defaults || {};
      if (settingPromptController) {
        settingPromptController.value = msg.settings.selfTestPromptController || defaults.controller || '';
      }
      if (settingPromptQaBrowser) {
        settingPromptQaBrowser.value = msg.settings.selfTestPromptQaBrowser || defaults['qa-browser'] || '';
      }
      if (settingPromptAgent) {
        settingPromptAgent.value = msg.settings.selfTestPromptAgent || defaults.agent || '';
      }
      updatePromptsVisibility();
      if (msg.apiCatalog) {
        applyApiCatalog(msg.apiCatalog);
        repopulateProviderSelect(cfgApiProvider, cfgApiProvider ? cfgApiProvider.value : 'openrouter');
      }
      // Populate API keys
      _apiKeys = (msg.settings && msg.settings.apiKeys) || {};
      _customProviders = (msg.settings && msg.settings.customProviders) || [];
      document.querySelectorAll('.settings-api-key-input').forEach(el => {
        const provider = el.dataset.provider;
        if (provider && _apiKeys[provider]) el.value = _apiKeys[provider];
        else el.value = '';
      });
      renderCustomProviderSettings();
      if (customProviderStatus && customProviderStatus.textContent === 'Saving custom providers...') {
        setCustomProviderStatus('Custom providers saved.', false);
      }
      // Re-evaluate warnings
      updateControllerDropdowns();
    },

    cloudSessionNotice(msg) {
      cloudPendingAction = '';
      cloudNoticeText = msg.text || '';
      setCloudAccountStatus(cloudNoticeText);
      renderCloudAccount();
      renderCloudEntryScreen();
    },

    cloudStatusData(msg) {
      if (msg.cloudStatus) {
        cloudStatusState = msg.cloudStatus;
        syncCloudContextDraftFromRuntime();
      }
      renderCloudAccount();
      renderCloudEntryScreen();
    },

    cloudSessionData(msg) {
      if (msg.cloud) {
        cloudBootstrap = msg.cloud;
      }
      if (msg.cloudSession) {
        cloudSessionState = msg.cloudSession;
      }
      if (msg.cloudStatus) {
        cloudStatusState = msg.cloudStatus;
        syncCloudContextDraftFromRuntime();
      }
      renderCloudAccount();
      renderCloudEntryScreen();
    },

    appInfoData(msg) {
      if (appInfoText) appInfoText.value = msg.content || '';
      if (appInfoEnabled) appInfoEnabled.checked = msg.enabled !== false;
      setProjectDocStatus('appInfo', msg.saved ? 'Saved.' : '');
    },

    memoryData(msg) {
      if (memoryText) memoryText.value = msg.content || '';
      if (memoryEnabled) memoryEnabled.checked = msg.enabled !== false;
      setProjectDocStatus('memory', msg.saved ? 'Saved.' : '');
    },

    dependencyMissing(msg) {
      // Show a banner for missing dependencies
      const banner = document.createElement('div');
      banner.className = 'dependency-banner';
      banner.textContent = msg.message || ('Missing dependency: ' + msg.tool);
      const messagesEl = document.getElementById('messages');
      if (messagesEl) messagesEl.prepend(banner);
      setTimeout(() => { try { banner.remove(); } catch {} }, 15000);
    },
  };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    if (fatalRecoveryShown) {
      _dbg('MSG ignored while fatal recovery active: type=' + msg.type);
      return;
    }
    // Reset panda idle counter on any incoming message
    pandaIdleTicks = 0;
    if (pandaMascotEl && pandaMascotEl.classList.contains('panda-mascot--idle')) {
      setPandaMascotState(pandaMascotEl, 'thinking');
    }
    // Wake up buddy panda if sleeping
    if (pandaBuddyEl && buddyState === 'sleeping') {
      setBuddyState('idle');
    }
    _dbg('MSG received: type=' + msg.type + ' hasHandler=' + !!handlers[msg.type]);
    const handler = handlers[msg.type];
    if (handler) {
      try {
        handler(msg);
      } catch (e) {
        _dbg('MSG HANDLER ERROR: type=' + msg.type + ' error=' + (e && e.message || e));
      }
      logMessage(msg);
      maybeTrimVisibleHistory();
    }
  });

  // ── Restore persisted state on startup ────────────────────────────
  // Run ID and config are persisted per panel via vscode.setState/getState.
  // Chat history is rebuilt from transcript.jsonl on disk when the extension
  // host processes the 'ready' message and calls sendTranscript().
  const savedState = vscode.getState();
  const launchParams = parseWorkspaceLaunchFromUrl();
  _dbg('STATE: savedState=' + JSON.stringify(savedState ? { runId: savedState.runId, panelId: savedState.panelId } : null));
  const shouldIgnoreSavedState = Boolean(
    savedState &&
    (
      (launchParams.rootIdentity &&
        savedState.rootIdentity !== launchParams.rootIdentity) ||
      (launchParams.resume &&
        savedState.resume !== launchParams.resume)
    )
  );
  if (launchParams.workspace) {
    currentWorkspace = launchParams.workspace;
    currentRootIdentity = launchParams.rootIdentity;
  }
  if (launchParams.resume) {
    currentResumeToken = launchParams.resume;
  }
  if (launchParams.agent) {
    const launchTarget = normalizeLaunchTarget(launchParams.agent);
    if (launchTarget) {
      _pendingChatTarget = launchTarget;
      hasExplicitChatTarget = true;
    }
  }
  if (savedState) {
    if (!shouldIgnoreSavedState) {
      currentRunId = savedState.runId || null;
      if (savedState.resume && !currentResumeToken) currentResumeToken = savedState.resume;
      if (savedState.workspace && !currentWorkspace) currentWorkspace = savedState.workspace;
      if (savedState.rootIdentity && !currentRootIdentity) currentRootIdentity = savedState.rootIdentity;
    }
    if (!shouldIgnoreSavedState && savedState.config) {
      const restoredConfig = { ...savedState.config };
      // Save chatTarget for later — dropdown options aren't populated yet (agents arrive in initConfig)
      if (restoredConfig.chatTarget && !launchParams.agent) {
        _pendingChatTarget = restoredConfig.chatTarget;
        hasExplicitChatTarget = true;
      }
      if (launchParams.agent) {
        delete restoredConfig.chatTarget;
      }
      setConfig(restoredConfig);
    }
    if (!shouldIgnoreSavedState && savedState.panelId) {
      panelId = savedState.panelId;
    }
    if (!shouldIgnoreSavedState && savedState.novncPort) {
      novncPort = savedState.novncPort;
      updateComputerTab();
    }
    // Don't restore chromePort — Chrome process dies on reload and must be restarted
  }
  updateLoopObjectiveVisibility();
  renderCloudEntryScreen();

  // ── Suggestions / Autocomplete ────────────────────────────────────

  const suggestionsEl = document.getElementById('suggestions');

  const COMMANDS = [
    { cmd: '/help', desc: 'Show help' },
    { cmd: '/new', desc: 'Start a new run' },
    { cmd: '/resume', desc: 'Attach to an existing run or alias' },
    { cmd: '/import-chat', desc: 'Import a Codex or Claude chat into a new run' },
    { cmd: '/alias', desc: 'Save current run as an alias' },
    { cmd: '/unalias', desc: 'Remove a saved alias' },
    { cmd: '/aliases', desc: 'List saved aliases' },
    { cmd: '/run', desc: 'Continue interrupted request' },
    { cmd: '/status', desc: 'Show run status' },
    { cmd: '/list', desc: 'List saved runs' },
    { cmd: '/logs', desc: 'Show recent events' },
    { cmd: '/clear', desc: 'Clear chat and start fresh' },
    { cmd: '/compact', desc: 'Compact the current API session' },
    { cmd: '/detach', desc: 'Detach from current run' },
    { cmd: '/controller-model', desc: 'Set Codex model' },
    { cmd: '/worker-model', desc: 'Set Claude model' },
    { cmd: '/controller-thinking', desc: 'Set Codex thinking' },
    { cmd: '/worker-thinking', desc: 'Set Claude thinking' },
    { cmd: '/wait', desc: 'Set auto-pass delay' },
    { cmd: '/config', desc: 'Show current config' },
    { cmd: '/workflow', desc: 'List or run a workflow' },
  ];

  const SUBOPTIONS = {
    '/controller-model': [
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
    ],
    '/worker-model': [
      { value: 'sonnet', label: 'Sonnet (latest)' },
      { value: 'opus', label: 'Opus (latest)' },
      { value: 'haiku', label: 'Haiku' },
    ],
    '/controller-thinking': [
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High' },
    ],
    '/worker-thinking': [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    '/wait': [
      { value: 'none', label: 'None (disabled)' },
      { value: '1m', label: '1 min' },
      { value: '2m', label: '2 min' },
      { value: '3m', label: '3 min' },
      { value: '5m', label: '5 min' },
      { value: '10m', label: '10 min' },
      { value: '15m', label: '15 min' },
      { value: '30m', label: '30 min' },
      { value: '1h', label: '1 hour' },
      { value: '2h', label: '2 hours' },
      { value: '3h', label: '3 hours' },
      { value: '5h', label: '5 hours' },
      { value: '6h', label: '6 hours' },
      { value: '12h', label: '12 hours' },
      { value: '1d', label: '1 day' },
      { value: '2d', label: '2 days' },
      { value: '3d', label: '3 days' },
      { value: '4d', label: '4 days' },
      { value: '5d', label: '5 days' },
      { value: '6d', label: '6 days' },
      { value: '7d', label: '7 days' },
    ],
  };

  function updateSuggestions() {
    const text = textarea.value;
    suggestionsEl.innerHTML = '';

    // Only show suggestions when text starts with /
    if (!text.startsWith('/')) {
      suggestionsEl.style.display = 'none';
      return;
    }

    // Check if user typed a command with a trailing space -> show suboptions
    const spaceIdx = text.indexOf(' ');
    if (spaceIdx !== -1) {
      const cmd = text.slice(0, spaceIdx);
      const sub = text.slice(spaceIdx + 1);
      const options = SUBOPTIONS[cmd];
      if (options) {
        const filtered = sub
          ? options.filter(o => o.value.toLowerCase().includes(sub.toLowerCase()) || o.label.toLowerCase().includes(sub.toLowerCase()))
          : options;
        if (filtered.length > 0) {
          suggestionsEl.style.display = 'flex';
          for (const opt of filtered) {
            const chip = document.createElement('button');
            chip.className = 'suggestion-chip suboption';
            chip.textContent = opt.label;
            chip.title = opt.value;
            chip.addEventListener('click', () => {
              textarea.value = '';
              textarea.style.height = 'auto';
              suggestionsEl.style.display = 'none';
              vscode.postMessage({ type: 'userInput', text: `${cmd} ${opt.value}` });
              textarea.focus();
            });
            suggestionsEl.appendChild(chip);
          }
          return;
        }
      }
      suggestionsEl.style.display = 'none';
      return;
    }

    // Show matching commands
    const query = text.toLowerCase();
    const filtered = COMMANDS.filter(c => c.cmd.toLowerCase().startsWith(query));
    if (filtered.length === 0) {
      suggestionsEl.style.display = 'none';
      return;
    }

    suggestionsEl.style.display = 'flex';
    for (const item of filtered) {
      const chip = document.createElement('button');
      chip.className = 'suggestion-chip';
      chip.innerHTML = `<span class="chip-cmd">${escapeHtml(item.cmd)}</span> <span class="chip-desc">${escapeHtml(item.desc)}</span>`;
      chip.addEventListener('click', () => {
        if (SUBOPTIONS[item.cmd]) {
          // Has suboptions — fill command + space to show them
          textarea.value = item.cmd + ' ';
          textarea.focus();
          updateSuggestions();
        } else {
          // No suboptions — execute immediately
          textarea.value = '';
          textarea.style.height = 'auto';
          suggestionsEl.style.display = 'none';
          vscode.postMessage({ type: 'userInput', text: item.cmd });
          textarea.focus();
        }
      });
      suggestionsEl.appendChild(chip);
    }
  }

  // ── Input handling ─────────────────────────────────────────────────

  function sendInput() {
    const text = textarea.value.trim();
    if (!text) return;
    _dbg('sendInput: text=' + text.slice(0, 120));
    textarea.value = '';
    textarea.style.height = 'auto';
    suggestionsEl.style.display = 'none';
    vscode.postMessage({ type: 'userInput', text });
  }

  btnSend.addEventListener('click', sendInput);

  btnStop.addEventListener('click', () => {
    vscode.postMessage({ type: 'abort' });
  });

  // Continue button — sends to controller with optional guidance
  if (btnContinue) {
    btnContinue.addEventListener('click', () => {
      const text = textarea.value.trim();
      textarea.value = '';
      textarea.style.height = 'auto';
      vscode.postMessage({ type: 'continueInput', text });
    });
  }

  if (btnReview) {
    btnReview.addEventListener('click', () => {
      const scope = _defaultReviewScope();
      if (!scope) return;
      sendReviewRequest(scope);
    });
  }

  if (btnReviewMenu) {
    btnReviewMenu.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btnReviewMenu.disabled || !reviewMenu) return;
      const open = reviewMenu.style.display !== 'block';
      reviewMenu.style.display = open ? 'block' : 'none';
      if (reviewSplit) reviewSplit.classList.toggle('menu-open', open);
      btnReviewMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  if (reviewMenu) {
    reviewMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.split-action-item[data-scope]');
      if (!item || item.disabled) return;
      e.preventDefault();
      sendReviewRequest(item.getAttribute('data-scope'));
    });
  }

  // Orchestrate button — full controller orchestration with persistent session
  if (btnOrchestrate) {
    btnOrchestrate.addEventListener('click', () => {
      const text = textarea.value.trim();
      textarea.value = '';
      textarea.style.height = '';
      vscode.postMessage({ type: 'orchestrateInput', text });
    });
  }

  // Loop toggle — auto-continue after each agent response
  if (loopToggle) {
    loopToggle.addEventListener('change', () => {
      updateLoopObjectiveVisibility();
      onConfigChange();
    });
  }
  if (loopObjectiveInput) {
    loopObjectiveInput.addEventListener('input', () => {
      onConfigChange();
    });
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
    if (e.key === 'Escape') {
      suggestionsEl.style.display = 'none';
      hideReviewMenu();
    }
  });

  // Auto-resize textarea + update suggestions
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    updateSuggestions();
  });

  // Global ESC to stop running processes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isRunning) {
      vscode.postMessage({ type: 'abort' });
    }
  });

  document.addEventListener('click', (e) => {
    if (!reviewSplit || !reviewSplit.contains(e.target)) {
      hideReviewMenu();
    }
  });

  // Initialize panda buddy
  initPandaBuddy();

  // Focus input on load
  textarea.focus();
  window.addEventListener('focus', () => {
    vscode.postMessage({ type: 'reviewStateRequest' });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      vscode.postMessage({ type: 'reviewStateRequest' });
    }
  });

  // Request persisted config from extension host, include saved runId for reattach
  _dbg('PRE-READY DOM: wizard.display="' + (wizardEl ? wizardEl.style.display : 'null') + '"');
  _dbg('READY sent: runId=' + currentRunId + ' panelId=' + panelId + ' readySessionId=' + readySessionId);
  function postReady() {
    vscode.postMessage({
      type: 'ready',
      runId: currentRunId,
      panelId: panelId,
      readySessionId: readySessionId,
      workspace: currentWorkspace,
      resume: currentResumeToken,
      rootIdentity: currentRootIdentity,
      agent: currentAgentLaunchToken(),
    });
  }
  postReady();
  readyRetryTimer = setInterval(() => {
    if (initConfigReceived || readyRetryCount >= 10) {
      clearInterval(readyRetryTimer);
      readyRetryTimer = null;
      return;
    }
    readyRetryCount += 1;
    _dbg('READY retry #' + readyRetryCount + ': runId=' + currentRunId + ' panelId=' + panelId + ' readySessionId=' + readySessionId);
    postReady();
  }, 500);
})();
