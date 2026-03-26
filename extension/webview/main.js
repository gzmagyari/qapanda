(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // Debug logging — sends to extension host which writes to .cc-manager/wizard-debug.log
  function _dbg(text) { try { vscode.postMessage({ type: '_debugLog', text: String(text) }); } catch {} }

  const messagesEl = document.getElementById('messages');
  const textarea = document.getElementById('user-input');
  const btnSend = document.getElementById('btn-send');
  const btnContinue = document.getElementById('btn-continue');
  const btnOrchestrate = document.getElementById('btn-orchestrate');
  const btnStop = document.getElementById('btn-stop');
  const loopToggle = document.getElementById('loop-toggle');
  const progressBubble = document.getElementById('progress-bubble');
  const progressBody = progressBubble ? progressBubble.querySelector('.progress-body') : null;

  // ── Tab switching ───────────────────────────────────────────────────
  const tabBar = document.getElementById('tab-bar');
  const tabPanels = {
    agent: document.getElementById('tab-agent'),
    tasks: document.getElementById('tab-tasks'),
    tests: document.getElementById('tab-tests'),
    agents: document.getElementById('tab-agents'),
    mcp: document.getElementById('tab-mcp'),
    instances: document.getElementById('tab-instances'),
    computer: document.getElementById('tab-computer'),
    browser: document.getElementById('tab-browser'),
    modes: document.getElementById('tab-modes'),
  };

  tabBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    for (const [key, el] of Object.entries(tabPanels)) {
      if (key === tab) el.classList.remove('tab-hidden');
      else el.classList.add('tab-hidden');
    }
    if (tab === 'tasks') vscode.postMessage({ type: 'tasksLoad' });
    if (tab === 'tests') vscode.postMessage({ type: 'testsLoad' });
    if (tab === 'agents') vscode.postMessage({ type: 'agentsLoad' });
    if (tab === 'instances') {
      instancesActionId++;
      setInstancesLoading(true);
      vscode.postMessage({ type: 'instancesLoad', _actionId: instancesActionId });
    }
    if (tab === 'modes') vscode.postMessage({ type: 'modesLoad' });
    if (tab === 'browser') {
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
  });

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
  let agentEditingForm = null; // { scope, id } or null

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
    const existingModel = existing ? (existing.model || '') : '';
    const existingThinking = existing ? (existing.thinking || '') : '';
    const existingRunMode = existing ? (existing.runMode || '') : '';

    const cliOptions = ['', 'claude', 'codex', 'qa-remote-claude', 'qa-remote-codex'];
    const cliLabels = { '': 'Default (inherit from worker)', 'claude': 'claude', 'codex': 'codex', 'qa-remote-claude': 'qa-remote-claude', 'qa-remote-codex': 'qa-remote-codex' };
    const cliSelectHtml = '<select class="mcp-input" id="agent-f-cli">' +
      cliOptions.map(v => '<option value="' + v + '"' + (existingCli === v ? ' selected' : '') + '>' + cliLabels[v] + '</option>').join('') +
      '</select>';

    form.innerHTML =
      '<div class="agent-form-row"><label>ID</label><input class="mcp-input" id="agent-f-id" value="' + escapeHtml(editId || '') + '" ' + (editId ? 'disabled' : '') + ' placeholder="unique-id (e.g. qa, dev)"></div>' +
      '<div class="agent-form-row"><label>Name</label><input class="mcp-input" id="agent-f-name" value="' + escapeHtml(existing ? existing.name || '' : '') + '" placeholder="Display name"></div>' +
      '<div class="agent-form-row"><label>Description</label><input class="mcp-input" id="agent-f-desc" value="' + escapeHtml(existing ? existing.description || '' : '') + '" placeholder="Short description visible to the controller (what this agent does)"></div>' +
      '<div class="agent-form-row"><label>CLI Backend</label>' + cliSelectHtml + '</div>' +
      '<div class="agent-form-row"><label>Model</label><select class="mcp-input" id="agent-f-model"><option value="">Default</option></select>' +
      '<select class="mcp-input" id="agent-f-thinking"><option value="">Thinking: default</option></select></div>' +
      '<div class="agent-form-row" id="agent-f-runmode-row"><label>Run Mode</label><select class="mcp-input" id="agent-f-runmode">' +
      '<option value=""' + (existingRunMode === '' ? ' selected' : '') + '>Default (stream-json)</option>' +
      '<option value="interactive"' + (existingRunMode === 'interactive' ? ' selected' : '') + '>Interactive (terminal parser, experimental)</option>' +
      '</select></div>' +
      '<div class="agent-form-row"><label>Prompt</label><textarea class="mcp-input mcp-textarea" id="agent-f-prompt" placeholder="System prompt for this agent. Overrides the default worker prompt. NOT visible to the controller.">' + escapeHtml(existing ? existing.system_prompt || '' : '') + '</textarea></div>' +
      '<div class="agent-form-row"><label>MCPs</label><textarea class="mcp-input mcp-textarea-json" id="agent-f-mcps" placeholder="Optional additional MCP servers (JSON, same format as MCP tab)">' + escapeHtml(mcpsJson) + '</textarea></div>' +
      '<div id="agent-f-error" class="mcp-form-error"></div>' +
      '<div class="mcp-form-actions"><button class="mcp-btn mcp-btn-primary" id="agent-f-save">Save</button><button class="mcp-btn" id="agent-f-cancel">Cancel</button></div>';

    setTimeout(() => {
      const cliEl = document.getElementById('agent-f-cli');
      const modelEl = document.getElementById('agent-f-model');
      const thinkingEl = document.getElementById('agent-f-thinking');

      function isCodexCli(v) { return v === 'codex' || v === 'qa-remote-codex'; }

      function updateAgentModelOptions() {
        const cli = cliEl ? cliEl.value : '';
        const useCodex = isCodexCli(cli);
        const models = useCodex ? CODEX_MODELS : CLAUDE_MODELS;
        const thinkings = useCodex ? CODEX_THINKING : CLAUDE_THINKING;
        repopulateSelect(modelEl, models, modelEl ? modelEl.value : '');
        repopulateSelect(thinkingEl, thinkings, thinkingEl ? thinkingEl.value : '');
        if (modelEl) modelEl.options[0].text = 'Model: default';
        if (thinkingEl) thinkingEl.options[0].text = 'Thinking: default';
        // Run Mode only applies to claude CLI
        const runModeRow = document.getElementById('agent-f-runmode-row');
        if (runModeRow) {
          const isClaude = !cli || cli === 'claude';
          runModeRow.style.display = isClaude ? '' : 'none';
        }
      }

      // Populate on load with saved values
      updateAgentModelOptions();
      if (modelEl) modelEl.value = existingModel;
      if (thinkingEl) thinkingEl.value = existingThinking;

      if (cliEl) cliEl.addEventListener('change', updateAgentModelOptions);
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
    const model = (document.getElementById('agent-f-model') ? document.getElementById('agent-f-model').value : '') || null;
    const thinking = (document.getElementById('agent-f-thinking') ? document.getElementById('agent-f-thinking').value : '') || null;
    const runMode = (document.getElementById('agent-f-runmode') ? document.getElementById('agent-f-runmode').value : '') || null;
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

    const prevEnabled = editId && agents[editId] ? agents[editId].enabled : true;
    const agentData = { name: name || id, description, system_prompt: systemPrompt, mcps, enabled: prevEnabled !== false };
    if (cli) agentData.cli = cli;
    if (model) agentData.model = model;
    if (thinking) agentData.thinking = thinking;
    if (runMode) agentData.runMode = runMode;

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

        card.innerHTML = `
          <div class="kanban-card-title">${envBadge} ${escapeHtml(test.title)}</div>
          <div class="test-card-meta">
            <span class="test-steps-count">${stepsPassing}/${stepsTotal} steps passing</span>
            <span class="test-last-tested">Last: ${lastTested}</span>
          </div>
          ${tags ? '<div class="test-tags">' + tags + '</div>' : ''}
        `;

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
    if (testBoardEl) testBoardEl.style.display = 'none';

    const isEdit = !!editTest;
    let html = `<div class="task-form">`;
    html += `<div class="task-form-header"><h3>${isEdit ? 'Test: ' + escapeHtml(editTest.title) : 'New Test'}</h3>`;
    html += `<button class="task-form-close" id="test-form-close">✕</button></div>`;

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
        html += `<h4>Linked Bug Tickets</h4><div class="test-linked-tasks">`;
        for (const taskId of editTest.linkedTaskIds) {
          html += `<span class="test-linked-task">${escapeHtml(taskId)}</span> `;
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
    document.getElementById('test-form-close').addEventListener('click', () => {
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
          const prompt = `Re-test the following test case using the cc-tests MCP tools:\n\nTest: ${editTest.title} (${editTest.id})\nEnvironment: ${editTest.environment}\n\nSteps:\n${stepsText}\n\nInstructions:\n1. Call run_test with test_id "${editTest.id}"\n2. Execute each step and call update_step_result for each\n3. Call complete_test_run when done\n4. If any step fails, use create_bug_from_test to create a bug ticket`;

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
  let currentMode = null;
  let currentTestEnv = null;
  let setupInProgress = false;
  let suppressTargetConfirm = false;

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
  const wizardStep1 = document.getElementById('wizard-step-1');
  const wizardStep2 = document.getElementById('wizard-step-2');
  const wizardStep3 = document.getElementById('wizard-step-3');
  let selectedWizardMode = null;
  let onboardingDetected = null;
  let onboardingPreference = 'both';
  let onboardingComplete = false;
  _dbg('INIT: wizardEl=' + !!wizardEl + ' step1=' + !!wizardStep1 + ' step2=' + !!wizardStep2 + ' step3=' + !!wizardStep3);

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
    wizardEl.classList.remove('wizard-hidden');
    tabPanels.agent.classList.add('wizard-hidden');
    const indicator = document.getElementById('mode-indicator');
    if (indicator) indicator.style.display = 'none';
    if (!onboardingComplete) {
      renderOnboardingStep();
    } else {
      renderWizardStep1();
    }
  }

  // ── Onboarding Wizard ─────────────────────────────────────────────

  function hideAllWizardSteps() {
    if (wizardStepOnboard) wizardStepOnboard.classList.add('wizard-hidden');
    if (wizardStepOnboardSummary) wizardStepOnboardSummary.classList.add('wizard-hidden');
    wizardStep1.classList.add('wizard-hidden');
    wizardStep2.classList.add('wizard-hidden');
    wizardStep3.classList.add('wizard-hidden');
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
    const claudeOk = c.claude && c.claude.available;
    const codexOk = c.codex && c.codex.available;

    // Build detection results
    let html = '<div class="onboard-section-label">Detected on your system:</div>';

    html += makeOnboardItem(claudeOk ? 'ok' : 'fail', 'Claude Code CLI',
      claudeOk ? (c.claude.version || '').split('\n')[0] : 'Not found');
    html += makeOnboardItem(codexOk ? 'ok' : 'fail', 'Codex CLI',
      codexOk ? (c.codex.version || '').split('\n')[0] : 'Not found');
    html += makeOnboardItem(t.chrome && t.chrome.available ? 'ok' : 'warn', 'Google Chrome',
      t.chrome && t.chrome.available ? 'Available — browser testing enabled' : 'Not found — browser testing unavailable');

    const dockerRunning = t.docker && t.docker.available && t.docker.running;
    const qaDesktopOk = t.qaDesktop && t.qaDesktop.available;
    const desktopReady = dockerRunning && qaDesktopOk;
    const dockerOk = t.docker && t.docker.available && t.docker.running;
    html += makeOnboardItem(dockerOk ? 'ok' : 'warn', 'Desktop Testing',
      dockerOk ? 'Docker running — desktop testing available'
        : !t.docker || !t.docker.available ? 'Docker not found — install Docker Desktop for desktop testing'
        : 'Docker installed but not running — start Docker Desktop');

    statusEl.innerHTML = html;

    // Block if no CLI at all
    if (!claudeOk && !codexOk) {
      statusEl.innerHTML += '<div class="onboard-item fail"><span class="onboard-item-icon">&#128683;</span><span class="onboard-item-label"><span class="onboard-item-name">No AI CLI found</span><span class="onboard-item-detail">Install Claude Code or Codex CLI to get started.</span></span></div>';
      if (nextBtn) nextBtn.disabled = true;
      return;
    }

    // Show CLI preference section with clear heading
    if (prefEl) {
      prefEl.classList.remove('wizard-hidden');
      prefEl.innerHTML = '';

      const heading = document.createElement('div');
      heading.className = 'onboard-section-label';
      heading.textContent = 'Choose your preferred CLI setup:';
      prefEl.appendChild(heading);

      const cardsWrap = document.createElement('div');
      cardsWrap.className = 'wizard-cards';

      const options = [];
      if (claudeOk && codexOk) options.push({ id: 'both', icon: '&#9889;', title: 'Both (recommended)', desc: 'Codex as controller, Claude Code as worker — best results' });
      if (claudeOk) options.push({ id: 'claude-only', icon: '&#129302;', title: 'Claude Code only', desc: 'Use Claude Code for everything' });
      if (codexOk) options.push({ id: 'codex-only', icon: '&#128187;', title: 'Codex only', desc: 'Use Codex for everything' });

      // Auto-select
      if (claudeOk && codexOk) onboardingPreference = 'both';
      else if (claudeOk) onboardingPreference = 'claude-only';
      else onboardingPreference = 'codex-only';

      for (const opt of options) {
        const card = document.createElement('div');
        card.className = 'wizard-card' + (opt.id === onboardingPreference ? ' selected' : '');
        card.dataset.pref = opt.id;
        card.innerHTML = '<div class="wizard-card-icon">' + opt.icon + '</div><div class="wizard-card-title">' + opt.title + '</div><div class="wizard-card-desc">' + opt.desc + '</div>';
        card.addEventListener('click', () => {
          onboardingPreference = opt.id;
          cardsWrap.querySelectorAll('.wizard-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
        });
        cardsWrap.appendChild(card);
      }
      prefEl.appendChild(cardsWrap);
    }

    if (nextBtn) nextBtn.disabled = false;
  }

  function makeOnboardItem(status, name, detail) {
    const icons = { ok: '&#9679;', warn: '&#9679;', fail: '&#9679;' };
    const colors = { ok: '#4caf50', warn: '#ff9800', fail: '#f44336' };
    return '<div class="onboard-item ' + status + '">'
      + '<span class="onboard-item-icon" style="color:' + (colors[status] || '#999') + '">' + (icons[status] || '') + '</span>'
      + '<span class="onboard-item-label">'
      + '<span class="onboard-item-name">' + name + '</span>'
      + '<span class="onboard-item-detail">' + detail + '</span>'
      + '</span></div>';
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

    if (c.claude && c.claude.available) items.push(makeOnboardItem('ok', 'Claude Code', 'Available'));
    if (c.codex && c.codex.available) items.push(makeOnboardItem('ok', 'Codex', 'Available'));
    if (t.chrome && t.chrome.available) items.push(makeOnboardItem('ok', 'Chrome', 'Browser testing available'));
    else items.push(makeOnboardItem('warn', 'Chrome', 'Not available — browser testing disabled'));
    if (t.docker && t.docker.available && t.docker.running) items.push(makeOnboardItem('ok', 'Docker', 'Desktop testing available'));
    else items.push(makeOnboardItem('warn', 'Docker', 'Not available — desktop testing disabled'));

    summaryEl.innerHTML = items.join('');
  }

  // Wire up onboarding buttons
  const onboardNextBtn = document.getElementById('onboard-next');
  if (onboardNextBtn) {
    onboardNextBtn.addEventListener('click', () => renderOnboardingSummary());
  }
  const onboardSkipBtn = document.getElementById('onboard-skip');
  if (onboardSkipBtn) {
    onboardSkipBtn.addEventListener('click', () => {
      // Skip onboarding — mark as complete with defaults
      onboardingComplete = true;
      vscode.postMessage({ type: 'onboardingSave', preference: 'both', detected: onboardingDetected || { clis: {}, tools: {} } });
      renderWizardStep1();
    });
  }
  const onboardCompleteBtn = document.getElementById('onboard-complete');
  if (onboardCompleteBtn) {
    onboardCompleteBtn.addEventListener('click', () => {
      onboardingComplete = true;
      vscode.postMessage({ type: 'onboardingSave', preference: onboardingPreference, detected: onboardingDetected || { clis: {}, tools: {} } });
      renderWizardStep1();
    });
  }
  const onboardSummaryBackBtn = document.getElementById('onboard-summary-back');
  if (onboardSummaryBackBtn) {
    onboardSummaryBackBtn.addEventListener('click', () => renderOnboardingStep());
  }

  function hideInitWizard() {
    _dbg('hideInitWizard() called');
    if (!wizardEl) return;
    wizardEl.classList.add('wizard-hidden');
    tabPanels.agent.classList.remove('wizard-hidden');
    updateModeIndicator();
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

  function getAllEnabledModes() {
    const all = { ...modesSystem, ...modesGlobal, ...modesProject };
    const result = {};
    for (const [id, mode] of Object.entries(all)) {
      if (mode && mode.enabled !== false) result[id] = mode;
    }
    return result;
  }

  function renderWizardStep1() {
    _dbg('renderWizardStep1() called');
    hideAllWizardSteps();
    wizardStep1.classList.remove('wizard-hidden');

    // Add "Re-run Setup" button
    const rerunEl = document.getElementById('wizard-rerun-setup');
    if (rerunEl) {
      rerunEl.innerHTML = '<button class="wizard-rerun-btn" id="wizard-rerun-btn">Re-run Setup</button>';
      const rerunBtn = document.getElementById('wizard-rerun-btn');
      if (rerunBtn) {
        rerunBtn.addEventListener('click', () => {
          onboardingComplete = false;
          renderOnboardingStep();
        });
      }
    }

    const cardsEl = document.getElementById('wizard-mode-cards');
    cardsEl.innerHTML = '';

    const enabled = getAllEnabledModes();
    _dbg('renderWizardStep1: enabledModes=' + JSON.stringify(Object.keys(enabled)));
    const categories = { test: [], develop: [] };
    for (const [id, mode] of Object.entries(enabled)) {
      const cat = mode.category || 'test';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ id, ...mode });
    }

    const categoryLabels = { test: 'Testing', develop: 'Development' };
    for (const [cat, modes] of Object.entries(categories)) {
      if (modes.length === 0) continue;
      const label = document.createElement('div');
      label.className = 'wizard-card-category';
      label.textContent = categoryLabels[cat] || cat;
      label.style.width = '100%';
      cardsEl.appendChild(label);

      for (const mode of modes) {
        const card = document.createElement('div');
        card.className = 'wizard-card';
        card.innerHTML =
          '<div class="wizard-card-icon">' + (mode.icon || '') + '</div>' +
          '<div class="wizard-card-title">' + escapeHtml(mode.name) + '</div>' +
          '<div class="wizard-card-desc">' + escapeHtml(mode.description || '') + '</div>';
        card.addEventListener('click', () => {
          selectedWizardMode = mode.id;
          const m = enabled[mode.id];
          if (m && m.requiresTestEnv) {
            renderWizardStep2();
          } else {
            applyMode(mode.id, null);
          }
        });
        cardsEl.appendChild(card);
      }
    }
  }

  function renderWizardStep2() {
    _dbg('renderWizardStep2() called');
    wizardStep1.classList.add('wizard-hidden');
    wizardStep2.classList.remove('wizard-hidden');
    wizardStep3.classList.add('wizard-hidden');
  }

  function renderWizardStep3(env) {
    _dbg('renderWizardStep3(env=' + env + ') called');
    wizardStep1.classList.add('wizard-hidden');
    wizardStep2.classList.add('wizard-hidden');
    wizardStep3.classList.remove('wizard-hidden');

    const optionsEl = document.getElementById('wizard-setup-options');
    optionsEl.innerHTML = '';

    if (env === 'browser') {
      // Already running
      const card1 = document.createElement('div');
      card1.className = 'wizard-card';
      card1.innerHTML =
        '<div class="wizard-card-icon">✅</div>' +
        '<div class="wizard-card-title">It\'s already running</div>' +
        '<div class="wizard-card-desc">My app is already running — go straight to testing</div>';
      card1.addEventListener('click', () => { applyMode(selectedWizardMode, env); });
      optionsEl.appendChild(card1);

      // Auto setup
      const card2 = document.createElement('div');
      card2.className = 'wizard-card';
      card2.innerHTML =
        '<div class="wizard-card-icon">🤖</div>' +
        '<div class="wizard-card-title">Auto setup</div>' +
        '<div class="wizard-card-desc">Let the agent figure out how to set up and start the app automatically</div>';
      card2.addEventListener('click', () => { applyModeWithSetup(selectedWizardMode, env); });
      optionsEl.appendChild(card2);

      // Manual setup
      const card3 = document.createElement('div');
      card3.className = 'wizard-card';
      card3.innerHTML =
        '<div class="wizard-card-icon">🛠️</div>' +
        '<div class="wizard-card-title">Manual setup</div>' +
        '<div class="wizard-card-desc">Guide the setup agent step by step — you tell it what to do</div>';
      card3.addEventListener('click', () => { applyModeWithManualSetup(selectedWizardMode, env); });
      optionsEl.appendChild(card3);

      // Skip
      const card4 = document.createElement('div');
      card4.className = 'wizard-card';
      card4.innerHTML =
        '<div class="wizard-card-icon">⏩</div>' +
        '<div class="wizard-card-title">Skip</div>' +
        '<div class="wizard-card-desc">I\'ll handle setup myself in the chat</div>';
      card4.addEventListener('click', () => { applyMode(selectedWizardMode, env); });
      optionsEl.appendChild(card4);
    } else {
      // Desktop: Auto setup
      const card1 = document.createElement('div');
      card1.className = 'wizard-card';
      card1.innerHTML =
        '<div class="wizard-card-icon">🤖</div>' +
        '<div class="wizard-card-title">Auto setup</div>' +
        '<div class="wizard-card-desc">Start a container and let the agent set up the app automatically</div>';
      card1.addEventListener('click', () => { applyModeWithSetup(selectedWizardMode, env); });
      optionsEl.appendChild(card1);

      // Manual setup
      const card2 = document.createElement('div');
      card2.className = 'wizard-card';
      card2.innerHTML =
        '<div class="wizard-card-icon">🛠️</div>' +
        '<div class="wizard-card-title">Manual setup</div>' +
        '<div class="wizard-card-desc">Start a container and guide the setup step by step</div>';
      card2.addEventListener('click', () => { applyModeWithManualSetup(selectedWizardMode, env); });
      optionsEl.appendChild(card2);

      // Skip
      const card3 = document.createElement('div');
      card3.className = 'wizard-card';
      card3.innerHTML =
        '<div class="wizard-card-icon">⏩</div>' +
        '<div class="wizard-card-title">Skip</div>' +
        '<div class="wizard-card-desc">Container or snapshot already exists — go straight to testing</div>';
      card3.addEventListener('click', () => { applyMode(selectedWizardMode, env); });
      optionsEl.appendChild(card3);
    }
  }

  function applyMode(modeId, testEnv) {
    currentMode = modeId;
    currentTestEnv = testEnv;
    setupInProgress = false;
    hideInitWizard();

    const enabled = getAllEnabledModes();
    const mode = enabled[modeId];
    if (!mode) return;

    // Resolve environment-aware fields (can be string or { browser: X, computer: Y })
    function resolveByEnv(val, env) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return val[env] || val['browser'] || Object.values(val)[0];
      }
      return val;
    }

    // Apply the mode config via the normal config change path
    const config = { mode: modeId, testEnv: testEnv };
    if (!mode.useController) {
      const agent = resolveByEnv(mode.defaultAgent, testEnv) || 'QA-Browser';
      config.chatTarget = 'agent-' + agent;
    } else {
      config.chatTarget = 'controller';
    }
    // Update the UI dropdown to reflect the mode's target
    suppressTargetConfirm = true;
    if (cfgChatTarget) {
      cfgChatTarget.value = config.chatTarget;
      updateConfigBarForTarget(config.chatTarget);
    }
    // Set loop mode from mode's default
    if (mode.autoDefault) {
      config.loopMode = true;
      if (loopToggle) loopToggle.checked = true;
    } else {
      config.loopMode = false;
      if (loopToggle) loopToggle.checked = false;
    }

    suppressTargetConfirm = false;
    vscode.postMessage({ type: 'configChanged', config });
    updateModeIndicator();
    saveState();
  }

  function applyModeWithSetup(modeId, env) {
    currentMode = modeId;
    currentTestEnv = env;
    setupInProgress = true;
    hideInitWizard();

    const enabled = getAllEnabledModes();
    const mode = enabled[modeId];
    if (!mode || !mode.setupAgent) { applyMode(modeId, env); return; }

    const setupAgentId = mode.setupAgent[env];
    if (!setupAgentId) { applyMode(modeId, env); return; }

    // Set target to setup agent
    const config = { mode: modeId, testEnv: env, chatTarget: 'agent-' + setupAgentId };
    suppressTargetConfirm = true;
    if (cfgChatTarget) {
      cfgChatTarget.value = config.chatTarget;
      updateConfigBarForTarget(config.chatTarget);
    }
    suppressTargetConfirm = false;
    vscode.postMessage({ type: 'configChanged', config });

    // Show setup banner
    showSetupBanner(modeId, env);

    // Auto-send setup message
    const setupMsg = env === 'browser'
      ? 'Please set up this project for browser testing. Install dependencies, start the app, and confirm the URL when ready.'
      : 'Please set up this project for desktop testing. Install dependencies, start the app, and confirm when ready.';
    vscode.postMessage({ type: 'userInput', text: setupMsg });
    saveState();
  }

  function applyModeWithManualSetup(modeId, env) {
    currentMode = modeId;
    currentTestEnv = env;
    setupInProgress = true;
    hideInitWizard();

    const enabled = getAllEnabledModes();
    const mode = enabled[modeId];
    if (!mode || !mode.setupAgent) { applyMode(modeId, env); return; }

    const setupAgentId = mode.setupAgent[env];
    if (!setupAgentId) { applyMode(modeId, env); return; }

    // Set target to setup agent
    const config = { mode: modeId, testEnv: env, chatTarget: 'agent-' + setupAgentId };
    suppressTargetConfirm = true;
    if (cfgChatTarget) {
      cfgChatTarget.value = config.chatTarget;
      updateConfigBarForTarget(config.chatTarget);
    }
    suppressTargetConfirm = false;
    vscode.postMessage({ type: 'configChanged', config });

    // Show setup banner
    showSetupBanner(modeId, env);

    // Show guidance message instead of auto-sending
    const guidance = env === 'browser'
      ? 'Setup agent selected. Tell me how to set up and start your app — for example:\n• "Run npm install and npm start"\n• "Start the Python backend with python app.py"\n• "The app needs a database, set it up first"'
      : 'Setup agent selected. Tell me how to set up your app in the container — for example:\n• "Install Python deps and start the Flask server"\n• "Run npm install, build the frontend, then start"\n• "Set up the database and start all services"';
    addBanner(guidance);
    saveState();
  }

  function showSetupBanner(modeId, env) {
    let banner = document.getElementById('setup-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'setup-banner';
      banner.className = 'setup-banner';
      const parent = tabPanels.agent;
      parent.insertBefore(banner, parent.firstChild);
    }
    banner.innerHTML = '⚙️ Setup in progress — <strong>Click here when ready to start testing →</strong>';
    banner.style.display = '';
    banner.onclick = () => {
      setupInProgress = false;
      banner.style.display = 'none';
      // Clear chat — we're switching from setup agent to the actual agent (different session)
      vscode.postMessage({ type: 'userInput', text: '/clear' });
      messagesEl.innerHTML = '';
      messageLog = [];
      applyMode(modeId, env);
    };
  }

  function updateModeIndicator() {
    let indicator = document.getElementById('mode-indicator');
    if (!currentMode) {
      if (indicator) indicator.style.display = 'none';
      return;
    }
    const enabled = getAllEnabledModes();
    const mode = enabled[currentMode];
    if (!mode) {
      if (indicator) indicator.style.display = 'none';
      return;
    }

    if (!indicator) {
      indicator = document.createElement('span');
      indicator.id = 'mode-indicator';
      indicator.className = 'mode-indicator';
      const inputArea = document.getElementById('input-area');
      if (inputArea) inputArea.appendChild(indicator);
    }
    const envLabel = currentTestEnv ? ' (' + (currentTestEnv === 'browser' ? 'Browser' : 'Desktop') + ')' : '';
    indicator.textContent = (mode.icon || '') + ' ' + mode.name + envLabel;
    indicator.style.display = '';
    indicator.onclick = () => {
      // Don't show confirm if wizard is already visible
      if (wizardEl && !wizardEl.classList.contains('wizard-hidden')) return;
      const doSwitch = () => {
        if (messageLog.length > 0) vscode.postMessage({ type: 'userInput', text: '/clear' });
        currentMode = null;
        currentTestEnv = null;
        showInitWizard();
      };
      if (messageLog.length > 0) {
        showConfirm('Switching modes will clear the current conversation. Continue?', doSwitch);
      } else {
        doSwitch();
      }
    };
  }

  // Wire up wizard step 2 buttons
  if (wizardStep2) {
    wizardStep2.querySelectorAll('.wizard-card').forEach(card => {
      card.addEventListener('click', () => {
        const env = card.dataset.env;
        _dbg('wizard step2 card clicked: env=' + env);
        if (env) {
          currentTestEnv = env;
          renderWizardStep3(env);
        }
      });
    });
    const backBtn2 = document.getElementById('wizard-back-2');
    if (backBtn2) backBtn2.addEventListener('click', () => renderWizardStep1());
    const skipBtn2 = document.getElementById('wizard-skip-2');
    if (skipBtn2) skipBtn2.addEventListener('click', () => applyMode(selectedWizardMode, null));
  }
  // Wire up wizard step 3 buttons
  if (wizardStep3) {
    const backBtn3 = document.getElementById('wizard-back-3');
    if (backBtn3) backBtn3.addEventListener('click', () => renderWizardStep2());
    const skipBtn3 = document.getElementById('wizard-skip-3');
    if (skipBtn3) skipBtn3.addEventListener('click', () => applyMode(selectedWizardMode, currentTestEnv));
  }

  // ── Tasks / Kanban ───────────────────────────────────────────────────
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

    // New task button row
    const toolbar = document.createElement('div');
    toolbar.className = 'kanban-toolbar';
    const addBtn = document.createElement('button');
    addBtn.className = 'mcp-btn mcp-btn-primary';
    addBtn.textContent = '+ New Task';
    addBtn.addEventListener('click', () => showTaskForm(null));
    toolbar.appendChild(addBtn);
    kanbanBoard.appendChild(toolbar);

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

        const title = document.createElement('div');
        title.className = 'kanban-card-title';
        title.textContent = task.title;

        const desc = document.createElement('div');
        desc.className = 'kanban-card-desc';
        desc.textContent = (task.description || '').slice(0, 80);

        const meta = document.createElement('div');
        meta.className = 'kanban-card-meta';
        const cc = (task.comments || []).length;
        const pc = (task.progress_updates || []).length;
        if (cc) meta.innerHTML += '<span>' + cc + ' comment' + (cc > 1 ? 's' : '') + '</span>';
        if (pc) meta.innerHTML += '<span>' + pc + ' update' + (pc > 1 ? 's' : '') + '</span>';

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
      '<div class="mcp-form">' +
        '<div class="mcp-form-row"><label>Title</label><input class="mcp-input" id="task-f-title" value="' + escapeHtml(t.title) + '"></div>' +
        '<div class="mcp-form-row"><label>Status</label><select class="mcp-input" id="task-f-status">' +
          TASK_COLUMNS.map(c => '<option value="' + c.key + '"' + (c.key === t.status ? ' selected' : '') + '>' + escapeHtml(c.label) + '</option>').join('') +
        '</select></div>' +
        '<div class="mcp-form-row"><label>Description</label><input class="mcp-input" id="task-f-desc" value="' + escapeHtml(t.description || '') + '" placeholder="Short summary"></div>' +
        '<div class="mcp-form-row"><label>Details</label><textarea class="mcp-input mcp-textarea" id="task-f-detail" placeholder="Detailed notes / acceptance criteria">' + escapeHtml(t.detail_text || '') + '</textarea></div>' +
        '<div class="mcp-form-actions"><button class="mcp-btn mcp-btn-primary" id="task-f-save">' + (isEdit ? 'Save Changes' : 'Create Task') + '</button></div>' +
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
          if (confirm('Delete this task?')) {
            vscode.postMessage({ type: 'taskDelete', task_id: t.id });
          }
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

    // Remember insertion point
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
    messagesEl.insertBefore(wrapper, nextSib);

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

    // Move all children from the left column back into #messages before the wrapper.
    // Track the last moved child so we can place the bar right after it.
    let lastMoved = null;
    if (splitVncLeft) {
      while (splitVncLeft.firstChild) {
        lastMoved = splitVncLeft.firstChild;
        splitVncWrapper.parentNode.insertBefore(lastMoved, splitVncWrapper);
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
      splitVncWrapper.remove();
    } else {
      splitVncWrapper.remove();
    }

    splitVncWrapper = null;
    splitVncLeft = null;
    splitVncCollapsed = false;
  }

  // ── Chrome screencast (Browser tab + split widget) ───────────────────

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

    const target = splitVncLeft || splitChromeLeft || messagesEl;
    target.insertBefore(wrapper, nextSib);

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

    let lastMoved = null;
    if (splitChromeLeft) {
      while (splitChromeLeft.firstChild) {
        lastMoved = splitChromeLeft.firstChild;
        splitChromeWrapper.parentNode.insertBefore(lastMoved, splitChromeWrapper);
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
  const cfgWorkerCli = document.getElementById('cfg-worker-cli');
  const cfgWaitDelay = document.getElementById('cfg-wait-delay');

  // ── Persisted state ─────────────────────────────────────────────────
  // messageLog: array of message objects replayed on restore
  // runId: currently attached run id
  let messageLog = [];
  let currentRunId = null;

  function saveState() {
    // Persist run ID, config, and desktop info per panel. Chat history is
    // restored from transcript.jsonl on disk, so messageLog is NOT persisted.
    const state = { runId: currentRunId, config: getConfig() };
    if (novncPort) state.novncPort = novncPort;
    if (panelId) state.panelId = panelId;
    if (currentMode) state.currentMode = currentMode;
    if (currentTestEnv) state.currentTestEnv = currentTestEnv;
    vscode.setState(state);
  }

  function logMessage(msg) {
    // Only log messages that produce visible UI (skip transient/meta types).
    // messageLog is kept in memory for the current session but NOT persisted —
    // chat history survives reloads via transcript.jsonl on disk.
    const skipped = ['running', 'initConfig', 'syncConfig', 'rawEvent', 'setRunId', 'clearRunId', 'progressLine', 'progressFull', 'waitStatus', 'transcriptHistory'];
    if (skipped.includes(msg.type)) return;
    messageLog.push(msg);
  }

  // ── Progress bubble helpers ───────────────────────────────────────
  function showProgressBubble() {
    if (progressBubble) progressBubble.classList.remove('hidden');
  }

  function hideProgressBubble() {
    if (progressBubble) progressBubble.classList.add('hidden');
    if (progressBody) progressBody.textContent = '';
  }

  function setProgressContent(text) {
    if (!progressBody) return;
    if (!text) {
      hideProgressBubble();
      return;
    }
    progressBody.textContent = text;
    showProgressBubble();
    progressBody.scrollTop = progressBody.scrollHeight;
  }

  function appendProgressLine(line) {
    if (!progressBody) return;
    if (progressBody.textContent) {
      progressBody.textContent += '\n' + line;
    } else {
      progressBody.textContent = line;
    }
    showProgressBubble();
    progressBody.scrollTop = progressBody.scrollHeight;
  }

  function getConfig() {
    return {
      controllerModel: cfgControllerModel.value,
      workerModel: cfgWorkerModel.value,
      controllerThinking: cfgControllerThinking.value,
      workerThinking: cfgWorkerThinking.value,
      waitDelay: cfgWaitDelay ? cfgWaitDelay.value : '',
      chatTarget: cfgChatTarget ? cfgChatTarget.value : 'controller',
      controllerCli: cfgControllerCli ? cfgControllerCli.value : 'codex',
      workerCli: cfgWorkerCli ? cfgWorkerCli.value : 'claude',
    };
  }

  function setConfig(config) {
    if (!config) return;
    // Set CLI selectors first so updateControllerDropdowns repopulates with the right option sets
    if (config.controllerCli !== undefined && cfgControllerCli) cfgControllerCli.value = config.controllerCli;
    if (config.workerCli !== undefined && cfgWorkerCli) cfgWorkerCli.value = config.workerCli;
    // Repopulate model/thinking options based on selected CLIs, preserving current values where possible
    updateControllerDropdowns();
    // Now set the model/thinking values (options exist after repopulate)
    if (config.controllerModel !== undefined) cfgControllerModel.value = config.controllerModel;
    if (config.workerModel !== undefined) cfgWorkerModel.value = config.workerModel;
    if (config.controllerThinking !== undefined) cfgControllerThinking.value = config.controllerThinking;
    if (config.workerThinking !== undefined) cfgWorkerThinking.value = config.workerThinking;
    if (config.waitDelay !== undefined && cfgWaitDelay) cfgWaitDelay.value = config.waitDelay;
    suppressTargetConfirm = true;
    if (config.chatTarget !== undefined && cfgChatTarget) cfgChatTarget.value = config.chatTarget;
    suppressTargetConfirm = false;
    updateConfigBarForTarget(cfgChatTarget ? cfgChatTarget.value : 'controller');
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

  function repopulateSelect(el, options, currentValue) {
    if (!el) return;
    el.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    // Restore previous value if it still exists, otherwise default to ''
    if (currentValue && options.some(o => o.value === currentValue)) {
      el.value = currentValue;
    } else {
      el.value = '';
    }
  }

  function updateControllerDropdowns() {
    const controllerCli = cfgControllerCli ? cfgControllerCli.value : 'codex';
    const workerCli = cfgWorkerCli ? cfgWorkerCli.value : 'claude';

    const controllerModels = controllerCli === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
    const controllerThinking = controllerCli === 'claude' ? CLAUDE_THINKING : CODEX_THINKING;
    const workerModels = workerCli === 'codex' ? CODEX_MODELS : CLAUDE_MODELS;
    const workerThinking = workerCli === 'codex' ? CODEX_THINKING : CLAUDE_THINKING;

    repopulateSelect(cfgControllerModel, controllerModels, cfgControllerModel ? cfgControllerModel.value : '');
    repopulateSelect(cfgControllerThinking, controllerThinking, cfgControllerThinking ? cfgControllerThinking.value : '');
    repopulateSelect(cfgWorkerModel, workerModels, cfgWorkerModel ? cfgWorkerModel.value : '');
    repopulateSelect(cfgWorkerThinking, workerThinking, cfgWorkerThinking ? cfgWorkerThinking.value : '');
  }

  function labelForTarget(target) {
    if (!target || target === 'controller') return 'CC Manager';
    if (target === 'claude') return 'Worker (Default)';
    if (target.startsWith('agent-')) {
      const agentId = target.slice('agent-'.length);
      const allAgents = { ...agentsSystem, ...agentsGlobal, ...agentsProject };
      const agent = allAgents[agentId];
      return agent ? agent.name : agentId;
    }
    return 'CC Manager';
  }

  function updateConfigBarForTarget(target) {
    const isController = !target || target === 'controller';
    const isAgent = target && target.startsWith('agent-');
    document.querySelectorAll('.cfg-controller-only').forEach(el => el.classList.toggle('tab-hidden', !isController));
    // Worker dropdowns visible for controller + default worker, hidden for agents
    document.querySelectorAll('.cfg-worker-only').forEach(el => el.classList.toggle('tab-hidden', isAgent));
  }

  // Saved chatTarget from vscode.getState — used to restore after dropdown is populated
  let _pendingChatTarget = null;

  function refreshTargetDropdown() {
    if (!cfgChatTarget) return;
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
    // Restore: prefer pending saved target (from vscode.getState), then current value, then 'controller'
    const validValues = Array.from(cfgChatTarget.options).map(o => o.value);
    const preferred = _pendingChatTarget || currentValue;
    suppressTargetConfirm = true;
    cfgChatTarget.value = validValues.includes(preferred) ? preferred : 'controller';
    suppressTargetConfirm = false;
    _pendingChatTarget = null; // consumed
    updateConfigBarForTarget(cfgChatTarget.value);
  }

  function onConfigChange() {
    updateControllerDropdowns();
    const target = cfgChatTarget ? cfgChatTarget.value : 'controller';
    updateConfigBarForTarget(target);
    const config = getConfig();
    vscode.postMessage({ type: 'configChanged', config });
    vscode.postMessage({ type: 'setPanelTitle', title: labelForTarget(target) });
    saveState();
  }

  cfgControllerModel.addEventListener('change', onConfigChange);
  cfgControllerThinking.addEventListener('change', onConfigChange);
  cfgWorkerModel.addEventListener('change', onConfigChange);
  cfgWorkerThinking.addEventListener('change', onConfigChange);
  if (cfgWaitDelay) cfgWaitDelay.addEventListener('change', onConfigChange);
  if (cfgChatTarget) {
    let prevTarget = cfgChatTarget.value;
    cfgChatTarget.addEventListener('change', () => {
      const newTarget = cfgChatTarget.value;
      if (suppressTargetConfirm || newTarget === prevTarget) {
        prevTarget = newTarget;
        onConfigChange();
        return;
      }
      if (messageLog.length > 0) {
        showConfirm('Switching targets will clear the current conversation. Continue?', () => {
          vscode.postMessage({ type: 'userInput', text: '/clear' });
          prevTarget = newTarget;
          onConfigChange();
        }, () => {
          suppressTargetConfirm = true;
          cfgChatTarget.value = prevTarget;
          suppressTargetConfirm = false;
        });
      } else {
        prevTarget = newTarget;
        onConfigChange();
      }
    });
  }
  if (cfgControllerCli) cfgControllerCli.addEventListener('change', onConfigChange);
  if (cfgWorkerCli) cfgWorkerCli.addEventListener('change', onConfigChange);

  let currentActor = null;
  let currentSection = null;
  let hasContent = false;
  let streamingEntry = null;
  let isRunning = false;

  // ── Thinking indicator ────────────────────────────────────────────
  const thinkingChars = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588\u2587\u2586\u2585\u2584\u2583\u2582';
  let thinkingEl = null;
  let thinkingInterval = null;
  let thinkingTick = 0;

  function showThinking() {
    hideThinking();
    // Create a standalone thinking element at the bottom of messages
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking-standalone';
    const content = document.createElement('div');
    content.className = 'thinking-content';
    thinkingEl.appendChild(content);
    const target = splitVncLeft || splitChromeLeft || messagesEl;
    target.appendChild(thinkingEl);
    thinkingTick = 0;
    updateThinkingText(content);
    thinkingInterval = setInterval(() => updateThinkingText(content), 120);
    autoScroll();
  }

  function updateThinkingText(el) {
    const len = thinkingChars.length;
    let s = '';
    for (let i = 0; i < 5; i++) {
      s += thinkingChars[(thinkingTick + i) % len];
    }
    thinkingTick++;
    el.textContent = s;
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
  }

  function maybeShowThinking() {
    if (isRunning) {
      showThinking();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  function roleClass(label) {
    if (!label) return '';
    const l = label.toLowerCase();
    if (l.includes('user')) return 'role-user';
    if (l.includes('controller')) return 'role-controller';
    if (l.includes('claude')) return 'role-claude';
    if (l.includes('shell')) return 'role-shell';
    if (l.includes('error')) return 'role-error';
    return '';
  }

  function shouldAutoScroll() {
    const threshold = 60;
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
      requestAnimationFrame(scrollToBottom);
    }
  }

  // ── Lightweight Markdown → HTML ─────────────────────────────────────

  function escapeHtml(str) {
    if (typeof str !== 'string') str = JSON.stringify(str) || '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
    header.textContent = label;
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

  function addEntry(role, html, extraClass) {
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

    entry.appendChild(content);
    currentSection.appendChild(entry);
    hasContent = true;
    autoScroll();
    maybeShowThinking();
    return entry;
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
      streamingEntry = addEntry(role, renderInlineMarkdown(text));
      isRunning = savedRunning;
    } else {
      // Append to existing streaming entry
      const content = streamingEntry.querySelector('.entry-content');
      if (content) {
        content.innerHTML += '\n' + renderInlineMarkdown(text);
      }
    }
    autoScroll();
    maybeShowThinking();
  }

  // ── Message handlers ───────────────────────────────────────────────

  const handlers = {
    user(msg) {
      streamingEntry = null;
      addEntry('User', escapeHtml(msg.text));
    },

    controller(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Controller', renderInlineMarkdown(msg.text));
    },

    claude(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Worker', renderInlineMarkdown(msg.text));
      maybeShowThinking();
    },

    shell(msg) {
      streamingEntry = null;
      addEntry('Shell', renderInlineMarkdown(msg.text));
    },

    error(msg) {
      streamingEntry = null;
      addEntry(msg.label || 'Error', escapeHtml(msg.text), 'role-error');
    },

    banner(msg) {
      streamingEntry = null;
      addBanner(msg.text);
    },

    line(msg) {
      streamingEntry = null;
      addEntry(msg.label, renderInlineMarkdown(msg.text));
    },

    mdLine(msg) {
      streamingEntry = null;
      addEntry(msg.label, renderMarkdown(msg.text));
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
      addEntry(msg.label || 'Worker', escapeHtml(msg.text), 'tool-call');
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

    stop(msg) {
      streamingEntry = null;
      addEntry((msg && msg.label) || 'Controller', 'STOP');
    },

    requestStarted(msg) {
      streamingEntry = null;
      addBanner(`Attached run ${msg.runId}`);
    },

    requestFinished(msg) {
      streamingEntry = null;
      if (msg.message) {
        addBanner(msg.message);
      }
    },

    clear() {
      teardownSplitVnc(false);
      streamingEntry = null;
      closeSection();
      messagesEl.innerHTML = '';
      messageLog = [];
      currentRunId = null;
      hideProgressBubble();
      saveState();
    },

    close() {
      streamingEntry = null;
      closeSection();
    },

    running(msg) {
      if (msg.value) {
        isRunning = true;
        btnSend.style.display = 'none';
        if (btnContinue) btnContinue.style.display = 'none';
        if (btnOrchestrate) btnOrchestrate.style.display = 'none';
        btnStop.style.display = 'inline-block';
        textarea.disabled = true;
        showThinking();
      } else {
        isRunning = false;
        hideThinking();
        // Split VNC is torn down by ensureSection() when the actor changes.
        // As a fallback, teardown here too in case no new section was created.
        if (splitVncWrapper) teardownSplitVnc(true);
        if (splitChromeWrapper) teardownSplitChrome(true);
        btnSend.style.display = 'inline-block';
        if (btnContinue) btnContinue.style.display = 'inline-block';
        if (btnOrchestrate) btnOrchestrate.style.display = 'inline-block';
        btnStop.style.display = 'none';
        textarea.disabled = false;
        textarea.focus();
      }
    },

    initConfig(msg) {
      setConfig(msg.config);
      if (msg.panelId && !panelId) {
        panelId = msg.panelId;
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
      // Show wizard if no mode selected, or if mode is stale (no active run)
      _dbg('initConfig: currentMode=' + currentMode + ' currentTestEnv=' + currentTestEnv + ' msg.runId=' + msg.runId);
      _dbg('initConfig: modesSystem keys=' + JSON.stringify(Object.keys(modesSystem || {})));
      _dbg('initConfig DOM BEFORE: wizard.display="' + (wizardEl ? wizardEl.style.display : 'null') + '" step1="' + (wizardStep1 ? wizardStep1.style.display : 'null') + '" step2="' + (wizardStep2 ? wizardStep2.style.display : 'null') + '" step3="' + (wizardStep3 ? wizardStep3.style.display : 'null') + '" agent="' + (tabPanels.agent ? tabPanels.agent.style.display : 'null') + '"');
      if (currentMode) {
        const enabled = getAllEnabledModes();
        _dbg('initConfig: enabled modes=' + JSON.stringify(Object.keys(enabled)) + ' currentMode in enabled=' + !!enabled[currentMode]);
        if (!enabled[currentMode] || !msg.runId) {
          _dbg('initConfig: resetting stale mode (mode exists=' + !!enabled[currentMode] + ', runId=' + msg.runId + ')');
          currentMode = null;
          currentTestEnv = null;
        }
      }
      _dbg('initConfig DECISION: currentMode=' + currentMode + ' -> ' + (currentMode ? 'hideWizard' : 'showWizard'));
      if (!currentMode) {
        showInitWizard();
      } else {
        hideInitWizard();
        updateModeIndicator();
      }
      _dbg('initConfig DOM AFTER: wizard.display="' + (wizardEl ? wizardEl.style.display : 'null') + '" step1="' + (wizardStep1 ? wizardStep1.style.display : 'null') + '" step2="' + (wizardStep2 ? wizardStep2.style.display : 'null') + '" step3="' + (wizardStep3 ? wizardStep3.style.display : 'null') + '" agent="' + (tabPanels.agent ? tabPanels.agent.style.display : 'null') + '"');
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
      updateBrowserTab();
      saveState();
    },

    chromeFrame(msg) {
      if (msg.metadata) {
        chromeMeta = {
          deviceWidth: msg.metadata.deviceWidth || 1280,
          deviceHeight: msg.metadata.deviceHeight || 720,
          offsetTop: msg.metadata.offsetTop || 0,
          pageScaleFactor: msg.metadata.pageScaleFactor || 1,
        };
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
    },

    chromeGone() {
      chromePort = null;
      chromeImgEl = null;
      updateBrowserTab();
      hideBrowserNav();
      teardownSplitChrome(false);
      saveState();
    },

    tasksData(msg) {
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
      saveState();
    },

    clearRunId() {
      currentRunId = null;
      hideProgressBubble();
      saveState();
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
      streamingEntry = null;
      closeSection();
      messagesEl.innerHTML = '';
      messageLog = [];

      if (Array.isArray(msg.messages)) {
        for (const entry of msg.messages) {
          const handler = handlers[entry.type];
          if (handler) {
            handler(entry);
            messageLog.push(entry);
          }
        }
      }
    },

    waitStatus() {
      // Handled via banners; no additional UI needed
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
    _dbg('MSG received: type=' + msg.type + ' hasHandler=' + !!handlers[msg.type]);
    const handler = handlers[msg.type];
    if (handler) {
      try {
        handler(msg);
      } catch (e) {
        _dbg('MSG HANDLER ERROR: type=' + msg.type + ' error=' + (e && e.message || e));
      }
      logMessage(msg);
    }
  });

  // ── Restore persisted state on startup ────────────────────────────
  // Run ID and config are persisted per panel via vscode.setState/getState.
  // Chat history is rebuilt from transcript.jsonl on disk when the extension
  // host processes the 'ready' message and calls sendTranscript().
  const savedState = vscode.getState();
  _dbg('STATE: savedState=' + JSON.stringify(savedState ? { runId: savedState.runId, currentMode: savedState.currentMode, currentTestEnv: savedState.currentTestEnv, panelId: savedState.panelId } : null));
  if (savedState) {
    currentRunId = savedState.runId || null;
    if (savedState.config) {
      // Save chatTarget for later — dropdown options aren't populated yet (agents arrive in initConfig)
      if (savedState.config.chatTarget) _pendingChatTarget = savedState.config.chatTarget;
      setConfig(savedState.config);
    }
    if (savedState.panelId) {
      panelId = savedState.panelId;
    }
    if (savedState.novncPort) {
      novncPort = savedState.novncPort;
      updateComputerTab();
    }
    if (savedState.currentMode) {
      currentMode = savedState.currentMode;
    }
    if (savedState.currentTestEnv) {
      currentTestEnv = savedState.currentTestEnv;
    }
    // Don't restore chromePort — Chrome process dies on reload and must be restarted
  }

  // ── Suggestions / Autocomplete ────────────────────────────────────

  const suggestionsEl = document.getElementById('suggestions');

  const COMMANDS = [
    { cmd: '/help', desc: 'Show help' },
    { cmd: '/new', desc: 'Start a new run' },
    { cmd: '/resume', desc: 'Attach to an existing run' },
    { cmd: '/run', desc: 'Continue interrupted request' },
    { cmd: '/status', desc: 'Show run status' },
    { cmd: '/list', desc: 'List saved runs' },
    { cmd: '/logs', desc: 'Show recent events' },
    { cmd: '/clear', desc: 'Clear chat and start fresh' },
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
      vscode.postMessage({ type: 'continueInput', text });
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
      vscode.postMessage({ type: 'configChanged', config: { loopMode: loopToggle.checked } });
    });
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendInput();
    }
    if (e.key === 'Escape') {
      suggestionsEl.style.display = 'none';
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

  // Focus input on load
  textarea.focus();

  // Request persisted config from extension host, include saved runId for reattach
  _dbg('PRE-READY DOM: wizard.display="' + (wizardEl ? wizardEl.style.display : 'null') + '" step1="' + (wizardStep1 ? wizardStep1.style.display : 'null') + '" step2="' + (wizardStep2 ? wizardStep2.style.display : 'null') + '" step3="' + (wizardStep3 ? wizardStep3.style.display : 'null') + '"');
  _dbg('READY sent: runId=' + currentRunId + ' panelId=' + panelId + ' currentMode=' + currentMode);
  vscode.postMessage({ type: 'ready', runId: currentRunId, panelId: panelId });
})();
