const { truncate } = require('./utils');
const { summarizeClaudeEvent, summarizeCodexEvent } = require('./events');

// ANSI color helpers
const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  // Label colors
  user: '\x1b[36m',        // cyan
  controller: '\x1b[33m',  // yellow
  claude: '\x1b[32m',      // green
  shell: '\x1b[35m',       // magenta
  banner: '\x1b[90m',      // gray
  error: '\x1b[31m',       // red
};

class Renderer {
  constructor(options = {}) {
    this.rawEvents = Boolean(options.rawEvents);
    this.quiet = Boolean(options.quiet);
    this.out = options.out || process.stdout;
    this.streamLabel = null;
    this.useColor = options.color != null ? Boolean(options.color) : (this.out.isTTY !== false);
  }

  write(text) {
    this.out.write(text);
  }

  _colorLabel(label, c) {
    if (!this.useColor) {
      return `${label}:`;
    }
    return `${c}${color.bold}${label}:${color.reset}`;
  }

  flushStream() {
    if (this.streamLabel) {
      this.write('\n');
      this.streamLabel = null;
    }
  }

  line(label, text, c) {
    this.flushStream();
    this.write(`${this._colorLabel(label, c)} ${text}\n`);
  }

  stream(label, text, c) {
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
        this.write(`${this._colorLabel(label, c)} `);
        this.streamLabel = label;
      } else if (this.streamLabel !== label) {
        this.flushStream();
        this.write(`${this._colorLabel(label, c)} `);
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
    if (this.useColor) {
      this.write(`${color.banner}${text}${color.reset}\n`);
    } else {
      this.write(`${text}\n`);
    }
  }

  shell(text) {
    this.line('Shell', text, color.shell);
  }

  user(text) {
    this.line('User', text, color.user);
  }

  controller(text) {
    this.line('Controller', text, color.controller);
  }

  claude(text) {
    this.line('Claude code', text, color.claude);
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
      this.stream('Claude code', summary.text, color.claude);
      return;
    }
    if (summary.kind === 'assistant-text') {
      this.line('Claude code', summary.text, color.claude);
      return;
    }
    if (summary.kind === 'final-text') {
      if (!this.quiet) {
        this.line('Claude code', summary.text, color.claude);
      }
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      const c = summary.kind === 'error' ? color.error : color.claude;
      this.line('Claude code', summary.text, c);
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
