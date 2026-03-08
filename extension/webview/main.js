(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById('messages');
  const textarea = document.getElementById('user-input');
  const btnSend = document.getElementById('btn-send');
  const btnStop = document.getElementById('btn-stop');

  // Config dropdowns
  const cfgControllerModel = document.getElementById('cfg-controller-model');
  const cfgControllerThinking = document.getElementById('cfg-controller-thinking');
  const cfgWorkerModel = document.getElementById('cfg-worker-model');
  const cfgWorkerThinking = document.getElementById('cfg-worker-thinking');

  function getConfig() {
    return {
      controllerModel: cfgControllerModel.value,
      workerModel: cfgWorkerModel.value,
      controllerThinking: cfgControllerThinking.value,
      workerThinking: cfgWorkerThinking.value,
    };
  }

  function setConfig(config) {
    if (!config) return;
    if (config.controllerModel !== undefined) cfgControllerModel.value = config.controllerModel;
    if (config.workerModel !== undefined) cfgWorkerModel.value = config.workerModel;
    if (config.controllerThinking !== undefined) cfgControllerThinking.value = config.controllerThinking;
    if (config.workerThinking !== undefined) cfgWorkerThinking.value = config.workerThinking;
  }

  function onConfigChange() {
    vscode.postMessage({ type: 'configChanged', config: getConfig() });
  }

  cfgControllerModel.addEventListener('change', onConfigChange);
  cfgControllerThinking.addEventListener('change', onConfigChange);
  cfgWorkerModel.addEventListener('change', onConfigChange);
  cfgWorkerThinking.addEventListener('change', onConfigChange);

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
    messagesEl.appendChild(thinkingEl);
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
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function autoScroll() {
    if (shouldAutoScroll()) {
      requestAnimationFrame(scrollToBottom);
    }
  }

  // ── Lightweight Markdown → HTML ─────────────────────────────────────

  function escapeHtml(str) {
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
    closeSection();

    currentActor = label;
    const section = document.createElement('div');
    section.className = 'section';

    const header = document.createElement('div');
    header.className = `section-header ${roleClass(label)}`;
    header.textContent = label;
    section.appendChild(header);

    messagesEl.appendChild(section);
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
    const role = label || 'Claude code';
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
  }

  // ── Message handlers ───────────────────────────────────────────────

  const handlers = {
    user(msg) {
      streamingEntry = null;
      addEntry('User', escapeHtml(msg.text));
    },

    controller(msg) {
      streamingEntry = null;
      addEntry('Controller', renderInlineMarkdown(msg.text));
    },

    claude(msg) {
      streamingEntry = null;
      addEntry('Claude code', renderInlineMarkdown(msg.text));
    },

    shell(msg) {
      streamingEntry = null;
      addEntry('Shell', renderInlineMarkdown(msg.text));
    },

    error(msg) {
      streamingEntry = null;
      addEntry('Error', escapeHtml(msg.text), 'role-error');
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
      addEntry(msg.label || 'Claude code', escapeHtml(msg.text), 'tool-call');
    },

    stop() {
      streamingEntry = null;
      addEntry('Controller', 'STOP');
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
      streamingEntry = null;
      closeSection();
      messagesEl.innerHTML = '';
    },

    close() {
      streamingEntry = null;
      closeSection();
    },

    running(msg) {
      if (msg.value) {
        isRunning = true;
        btnSend.style.display = 'none';
        btnStop.style.display = 'inline-block';
        textarea.disabled = true;
        showThinking();
      } else {
        isRunning = false;
        hideThinking();
        btnSend.style.display = 'inline-block';
        btnStop.style.display = 'none';
        textarea.disabled = false;
        textarea.focus();
      }
    },

    initConfig(msg) {
      setConfig(msg.config);
    },

    syncConfig(msg) {
      setConfig(msg.config);
    },

    rawEvent() {
      // Ignored in UI
    },
  };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    const handler = handlers[msg.type];
    if (handler) {
      handler(msg);
    }
  });

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
    { cmd: '/config', desc: 'Show current config' },
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

  // Request persisted config from extension host
  vscode.postMessage({ type: 'ready' });
})();
