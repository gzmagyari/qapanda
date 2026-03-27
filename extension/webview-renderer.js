const fs = require('node:fs');
const { truncate } = require('./src/utils');
const { summarizeClaudeEvent, summarizeCodexEvent, formatToolCall } = require('./src/events');
const { workerLabelFor } = require('./src/render');

// Message types to skip when logging to chat.jsonl (internal/transient only)
const CHAT_LOG_SKIP = new Set([
  'running', 'syncConfig', 'rawEvent', 'setRunId', 'clearRunId',
  'progressLine', 'progressFull', 'waitStatus', 'transcriptHistory',
  'streamLine', 'flushStream', 'close', 'initConfig',
  'desktopReady', 'desktopGone', 'chromeReady', 'chromeFrame', 'chromeGone',
  'computerUseDetected', 'requestStarted', 'requestFinished',
]);

class WebviewRenderer {
  constructor(panel, options = {}) {
    this._panel = panel;
    this.rawEvents = Boolean(options.rawEvents);
    this.quiet = Boolean(options.quiet);
    // Markdown streaming state
    this._mdBuffer = '';
    this._streamLabel = null;
    // Tool call tracking: index -> { name, inputJson }
    this._toolCalls = new Map();
    // Controller label — set from manifest.controller.cli
    this.controllerLabel = 'Orchestrator';
    // Worker label — set from manifest.worker.cli
    this.workerLabel = 'Worker';
    // Chat log path — set by session-manager when manifest is available
    this.chatLogPath = null;
  }

  _post(msg) {
    try {
      this._panel.webview.postMessage(msg);
    } catch {
      // Panel may be disposed
    }
    this._logChat(msg);
  }

  /** Append a message to chat.jsonl — the unified chat history file. */
  _logChat(msg) {
    if (!this.chatLogPath || !msg || !msg.type) return;
    if (CHAT_LOG_SKIP.has(msg.type)) return;
    try {
      const entry = { ts: new Date().toISOString(), ...msg };
      fs.appendFileSync(this.chatLogPath, JSON.stringify(entry) + '\n');
    } catch {
      // File write may fail if run dir doesn't exist yet
    }
  }

  write() {
    // No-op in webview
  }

  flushStream() {
    if (this._mdBuffer) {
      this._post({ type: 'streamLine', label: this._streamLabel, text: this._mdBuffer });
      this._mdBuffer = '';
    }
    this._streamLabel = null;
    this._post({ type: 'flushStream' });
  }

  user(text) {
    this.flushStream();
    this._post({ type: 'user', text });
  }

  controller(text) {
    this.flushStream();
    this._post({ type: 'controller', text, label: this.controllerLabel });
  }

  claude(text) {
    this.flushStream();
    this._post({ type: 'claude', text, label: this.workerLabel });
  }

  shell(text) {
    this.flushStream();
    this._post({ type: 'shell', text });
  }

  banner(text) {
    this.flushStream();
    this._post({ type: 'banner', text });
  }

  line(label, text, _labelColor) {
    this.flushStream();
    this._post({ type: 'line', label, text });
  }

  mdLine(label, text, _labelColor) {
    this.flushStream();
    this._post({ type: 'mdLine', label, text });
  }

  streamMarkdown(label, text, _labelColor) {
    if (!text) return;
    this._streamLabel = label;
    const normalized = String(text).replace(/\r/g, '');
    this._mdBuffer += normalized;

    let nlIndex;
    while ((nlIndex = this._mdBuffer.indexOf('\n')) !== -1) {
      const completeLine = this._mdBuffer.slice(0, nlIndex);
      this._mdBuffer = this._mdBuffer.slice(nlIndex + 1);
      this._post({ type: 'streamLine', label, text: completeLine });
    }
  }

  launchClaude(prompt, sameSession, agentId, agentCli, agentName, overrideLabel) {
    this.flushStream();
    const backendLabel = agentCli ? workerLabelFor(agentCli, agentName) : this.workerLabel;
    const agentLabel = !agentName && agentId && agentId !== 'default' ? ` [${agentId}]` : '';
    const prefix = sameSession
      ? `Launching ${backendLabel}${agentLabel} (same session) with: `
      : `Launching ${backendLabel}${agentLabel} with: `;
    this._post({ type: 'controller', text: `${prefix}"${prompt}"`, label: overrideLabel || this.controllerLabel });
  }

  stop() {
    this.flushStream();
    this._post({ type: 'stop', label: this.controllerLabel });
  }

  requestStarted(runId) {
    this._post({ type: 'requestStarted', runId });
  }

  requestFinished(message) {
    this._post({ type: 'requestFinished', message });
  }

  userPrompt() {
    // No-op — webview has its own input box
    return '';
  }

  close() {
    this.flushStream();
    this._post({ type: 'close' });
  }

  progress(line) {
    this._post({ type: 'progressLine', text: line });
  }

  _formatToolCall(name, input) {
    return formatToolCall(name, input);
  }

  controllerEvent(raw) {
    if (this.rawEvents) {
      this._post({ type: 'rawEvent', source: 'controller', raw });
      return;
    }
    // Detect computer-control MCP tool calls from codex controller
    if (raw && raw.type === 'item.started' && raw.item && raw.item.type === 'mcp_tool_call') {
      const server = raw.item.server || '';
      if (server.includes('computer-control') || server.includes('computer_control') || server.includes('chrome-devtools') || server.includes('chrome_devtools')) {
        this.computerUseDetected();
      }
    }
    const summary = summarizeCodexEvent(raw);
    if (!summary || this.quiet) return;
    if (summary.kind === 'reasoning') {
      this.streamMarkdown(this.controllerLabel, summary.text);
      this.flushStream();
      return;
    }
    this.controller(summary.text);
  }

  claudeControllerEvent(raw) {
    if (this.rawEvents) {
      this._post({ type: 'rawEvent', source: 'controller', raw });
      return;
    }
    const summary = summarizeClaudeEvent(raw);
    if (!summary || this.quiet) return;

    if (summary.kind === 'text-delta') {
      this.streamMarkdown(this.controllerLabel, summary.text);
      return;
    }
    if (summary.kind === 'tool-start') {
      this.flushStream();
      this._toolCalls.set(summary.index, { name: summary.toolName, inputJson: '' });
      return;
    }
    if (summary.kind === 'tool-input-delta') {
      const tc = this._toolCalls.get(summary.index);
      if (tc) {
        tc.inputJson += summary.text;
      }
      return;
    }
    if (summary.kind === 'block-stop') {
      const tc = this._toolCalls.get(summary.index);
      if (tc) {
        let input = {};
        try { input = JSON.parse(tc.inputJson); } catch {}
        const desc = this._formatToolCall(tc.name, input);
        const isComputerUse = tc.name.startsWith('mcp__computer-control__') || tc.name.startsWith('mcp__chrome-devtools__');
        const isChromeDevtools = tc.name.startsWith('mcp__chrome-devtools__');
        this._post({ type: 'toolCall', label: this.controllerLabel, text: desc, isComputerUse, isChromeDevtools });
        this._toolCalls.delete(summary.index);
      }
      return;
    }
    if (summary.kind === 'assistant-text' || summary.kind === 'final-text') {
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      const msgType = summary.kind === 'error' ? 'error' : 'controller';
      this._post({ type: msgType, text: summary.text, label: this.controllerLabel });
    }
  }

  claudeEvent(raw) {
    if (this.rawEvents) {
      this._post({ type: 'rawEvent', source: 'claude', raw });
      return;
    }
    const summary = summarizeClaudeEvent(raw);
    if (!summary) return;

    if (summary.kind === 'text-delta') {
      this.streamMarkdown(this.workerLabel, summary.text);
      return;
    }
    if (summary.kind === 'tool-start') {
      this.flushStream();
      this._toolCalls.set(summary.index, { name: summary.toolName, inputJson: '' });
      return;
    }
    if (summary.kind === 'tool-input-delta') {
      const tc = this._toolCalls.get(summary.index);
      if (tc) {
        tc.inputJson += summary.text;
      }
      return;
    }
    if (summary.kind === 'block-stop') {
      const tc = this._toolCalls.get(summary.index);
      if (tc) {
        let input = {};
        try { input = JSON.parse(tc.inputJson); } catch {}
        // Intercept display card tools — render as styled cards instead of generic tool calls
        if (tc.name === 'mcp__cc_tests__display_test_summary') {
          this._post({ type: 'testCard', label: this.workerLabel, data: input });
          this._toolCalls.delete(summary.index);
          return;
        }
        if (tc.name === 'mcp__cc_tests__display_bug_report') {
          this._post({ type: 'bugCard', label: this.workerLabel, data: input });
          this._toolCalls.delete(summary.index);
          return;
        }
        if (tc.name === 'mcp__cc_tasks__display_task') {
          this._post({ type: 'taskCard', label: this.workerLabel, data: input });
          this._toolCalls.delete(summary.index);
          return;
        }
        const desc = this._formatToolCall(tc.name, input);
        const isComputerUse = tc.name.startsWith('mcp__computer-control__') || tc.name.startsWith('mcp__chrome-devtools__');
        const isChromeDevtools = tc.name.startsWith('mcp__chrome-devtools__');
        this._post({ type: 'toolCall', label: this.workerLabel, text: desc, isComputerUse, isChromeDevtools });
        this._toolCalls.delete(summary.index);
      }
      return;
    }
    if (summary.kind === 'assistant-text') {
      this.mdLine(this.workerLabel, summary.text);
      return;
    }
    if (summary.kind === 'final-text') {
      if (!this.quiet) {
        this.mdLine(this.workerLabel, summary.text);
      }
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      const msgType = summary.kind === 'error' ? 'error' : 'claude';
      this._post({ type: msgType, text: summary.text });
    }
  }

  desktopReady(novncPort) {
    this._post({ type: 'desktopReady', novncPort });
  }

  desktopGone() {
    this._post({ type: 'desktopGone' });
  }

  computerUseDetected() {
    this._post({ type: 'computerUseDetected' });
  }

  chromeDevtoolsDetected() {
    this._post({ type: 'toolCall', label: this.workerLabel, text: 'Using Chrome DevTools', isComputerUse: false, isChromeDevtools: true });
  }

  chromeReady(chromePort) {
    this._post({ type: 'chromeReady', chromePort });
  }

  chromeFrame(base64Data) {
    this._post({ type: 'chromeFrame', data: base64Data });
  }

  chromeGone() {
    this._post({ type: 'chromeGone' });
  }
}

module.exports = { WebviewRenderer };
