const { truncate } = require('./utils');
const { summarizeClaudeEvent, summarizeCodexEvent } = require('./events');

class Renderer {
  constructor(options = {}) {
    this.rawEvents = Boolean(options.rawEvents);
    this.quiet = Boolean(options.quiet);
    this.out = options.out || process.stdout;
    this.streamLabel = null;
  }

  write(text) {
    this.out.write(text);
  }

  flushStream() {
    if (this.streamLabel) {
      this.write('\n');
      this.streamLabel = null;
    }
  }

  line(label, text) {
    this.flushStream();
    this.write(`${label}: ${text}\n`);
  }

  stream(label, text) {
    if (!text) {
      return;
    }
    const normalized = String(text).replace(/\r/g, '');
    const parts = normalized.split('\n');
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isLast = index === parts.length - 1;
      if (isLast && part === '') {
        continue;
      }
      if (!this.streamLabel) {
        this.write(`${label}: `);
        this.streamLabel = label;
      } else if (this.streamLabel !== label) {
        this.flushStream();
        this.write(`${label}: `);
        this.streamLabel = label;
      }
      this.write(part);
      if (!isLast) {
        this.write('\n');
        this.streamLabel = null;
      }
    }
  }

  banner(text) {
    this.flushStream();
    this.write(`${text}\n`);
  }

  shell(text) {
    this.line('Shell', text);
  }

  user(text) {
    this.line('User', text);
  }

  controller(text) {
    this.line('Controller', text);
  }

  claude(text) {
    this.line('Claude code', text);
  }

  launchClaude(prompt, sameSession) {
    const prefix = sameSession
      ? 'Launching Claude Code with the same session with: '
      : 'Launching Claude Code with: ';
    this.controller(`${prefix}"${truncate(prompt, 400)}"`);
  }

  stop() {
    this.controller('STOP');
  }

  controllerEvent(raw) {
    if (this.rawEvents) {
      this.flushStream();
      this.write(`${JSON.stringify({ source: 'controller', raw })}\n`);
      return;
    }
    const summary = summarizeCodexEvent(raw);
    if (!summary || this.quiet) {
      return;
    }
    this.controller(summary.text);
  }

  claudeEvent(raw) {
    if (this.rawEvents) {
      this.flushStream();
      this.write(`${JSON.stringify({ source: 'claude', raw })}\n`);
      return;
    }
    const summary = summarizeClaudeEvent(raw);
    if (!summary) {
      return;
    }
    if (summary.kind === 'text-delta') {
      this.stream('Claude code', summary.text);
      return;
    }
    if (summary.kind === 'assistant-text') {
      this.line('Claude code', summary.text);
      return;
    }
    if (summary.kind === 'final-text') {
      if (!this.quiet) {
        this.line('Claude code', summary.text);
      }
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      this.line('Claude code', summary.text);
    }
  }

  requestStarted(runId) {
    this.banner(`Attached run ${runId}`);
  }

  requestFinished(message) {
    if (message) {
      this.banner(message);
    }
  }

  close() {
    this.flushStream();
  }
}

module.exports = {
  Renderer,
};
