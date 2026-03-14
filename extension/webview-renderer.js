const { truncate } = require('./src/utils');
const { summarizeClaudeEvent, summarizeCodexEvent } = require('./src/events');

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
    this.controllerLabel = 'Controller';
  }

  _post(msg) {
    try {
      this._panel.webview.postMessage(msg);
    } catch {
      // Panel may be disposed
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
    this._post({ type: 'claude', text });
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

  launchClaude(prompt, sameSession, agentId) {
    this.flushStream();
    const agentLabel = agentId && agentId !== 'default' ? ` [agent: ${agentId}]` : '';
    const prefix = sameSession
      ? `Launching Claude Code${agentLabel} (same session) with: `
      : `Launching Claude Code${agentLabel} with: `;
    this._post({ type: 'controller', text: `${prefix}"${truncate(prompt, 400)}"`, label: this.controllerLabel });
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
    if (name === 'Bash' && input.command) {
      return `Running command: ${input.command}`;
    }
    if (name === 'Read' && input.file_path) {
      return `Reading ${input.file_path}`;
    }
    if (name === 'Write' && input.file_path) {
      return `Writing ${input.file_path}`;
    }
    if (name === 'Edit' && input.file_path) {
      return `Editing ${input.file_path}`;
    }
    if (name === 'Glob' && input.pattern) {
      return `Glob: ${input.pattern}`;
    }
    if (name === 'Grep' && input.pattern) {
      const path = input.path || input.include || '';
      return `Grep: ${input.pattern}${path ? ` in ${path}` : ''}`;
    }
    if (name === 'TodoWrite') {
      return `Updating todos`;
    }
    const filePath = input.file_path || input.path || input.target_file || input.filename;
    if (filePath) {
      return `${name}: ${filePath}`;
    }
    const keys = Object.keys(input);
    if (keys.length > 0) {
      const brief = keys.map(k => `${k}=${truncate(String(input[k]), 80)}`).join(', ');
      return `${name}: ${brief}`;
    }
    return `Using ${name}`;
  }

  controllerEvent(raw) {
    if (this.rawEvents) {
      this._post({ type: 'rawEvent', source: 'controller', raw });
      return;
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
        this._post({ type: 'toolCall', label: this.controllerLabel, text: desc });
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
      this.streamMarkdown('Claude code', summary.text);
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
        this._post({ type: 'toolCall', label: 'Claude code', text: desc });
        this._toolCalls.delete(summary.index);
      }
      return;
    }
    if (summary.kind === 'assistant-text') {
      this.mdLine('Claude code', summary.text);
      return;
    }
    if (summary.kind === 'final-text') {
      if (!this.quiet) {
        this.mdLine('Claude code', summary.text);
      }
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      const msgType = summary.kind === 'error' ? 'error' : 'claude';
      this._post({ type: msgType, text: summary.text });
    }
  }
}

module.exports = { WebviewRenderer };
