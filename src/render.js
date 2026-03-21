const { truncate } = require('./utils');
const { summarizeClaudeEvent, summarizeCodexEvent } = require('./events');

// ANSI color helpers
const color = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  strikethrough: '\x1b[9m',
  // Label colors
  user: '\x1b[36m',        // cyan
  controller: '\x1b[33m',  // yellow
  claude: '\x1b[32m',      // green
  shell: '\x1b[35m',       // magenta
  banner: '\x1b[90m',      // gray
  error: '\x1b[31m',       // red
  code: '\x1b[36m',        // cyan for inline code
  codeBlock: '\x1b[90m',   // gray for code blocks
  heading: '\x1b[1;36m',   // bold cyan for headings
  bullet: '\x1b[33m',      // yellow for bullets
  // Background color for user messages
  bgUser: '\x1b[48;5;236m',       // dark gray background
};

/**
 * Render inline markdown (bold, italic, code, strikethrough) to ANSI.
 * Handles: **bold**, *italic*, `code`, ~~strikethrough~~
 */
function renderInlineMarkdown(text, useColor) {
  if (!useColor) return text;
  return text
    .replace(/`([^`]+)`/g, `${color.code}$1${color.reset}`)
    .replace(/\*\*([^*]+)\*\*/g, `${color.bold}$1${color.reset}`)
    .replace(/\*([^*]+)\*/g, `${color.italic}$1${color.reset}`)
    .replace(/~~([^~]+)~~/g, `${color.strikethrough}$1${color.reset}`);
}

/**
 * Render a complete line of markdown to ANSI.
 */
function renderMarkdownLine(line, useColor, inCodeBlock) {
  if (!useColor) return { text: line, inCodeBlock };

  // Code block fence
  if (line.match(/^```/)) {
    if (inCodeBlock) {
      return { text: `${color.codeBlock}${line}${color.reset}`, inCodeBlock: false };
    }
    return { text: `${color.codeBlock}${line}${color.reset}`, inCodeBlock: true };
  }

  // Inside code block — render as-is in gray
  if (inCodeBlock) {
    return { text: `${color.codeBlock}${line}${color.reset}`, inCodeBlock: true };
  }

  // Headings
  const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
  if (headingMatch) {
    const content = renderInlineMarkdown(headingMatch[2], useColor);
    return { text: `${color.heading}${headingMatch[1]} ${content}${color.reset}`, inCodeBlock: false };
  }

  // Bullet points
  const bulletMatch = line.match(/^(\s*[-*+])\s+(.*)/);
  if (bulletMatch) {
    const content = renderInlineMarkdown(bulletMatch[2], useColor);
    return { text: `${color.bullet}${bulletMatch[1]}${color.reset} ${content}`, inCodeBlock: false };
  }

  // Numbered lists
  const numMatch = line.match(/^(\s*\d+\.)\s+(.*)/);
  if (numMatch) {
    const content = renderInlineMarkdown(numMatch[2], useColor);
    return { text: `${color.bullet}${numMatch[1]}${color.reset} ${content}`, inCodeBlock: false };
  }

  // Regular line with inline formatting
  return { text: renderInlineMarkdown(line, useColor), inCodeBlock };
}

// Unicode timeline characters
const glyph = {
  circle: '\u25cf',   // ●
  pipe: '\u2502',     // │
};

function controllerLabelFor(cli) {
  return cli === 'claude' ? 'Controller (Claude)' : 'Controller (Codex)';
}

function workerLabelFor(cli, agentName) {
  if (agentName) return agentName;
  if (!cli || cli === 'claude') return 'Worker (Claude)';
  if (cli === 'codex') return 'Worker (Codex)';
  return `Worker (${cli})`;
}

class Renderer {
  constructor(options = {}) {
    this.rawEvents = Boolean(options.rawEvents);
    this.quiet = Boolean(options.quiet);
    this.out = options.out || process.stdout;
    this.useColor = options.color != null ? Boolean(options.color) : (this.out.isTTY !== false);
    // Markdown streaming state
    this._mdBuffer = '';
    this._mdInCodeBlock = false;
    // Tool call tracking: index -> { name, inputJson }
    this._toolCalls = new Map();
    // Track current actor to avoid duplicate headers
    this._currentActor = null;
    this._currentColor = null;
    // Whether we've written at least one content line in the current section
    this._hasContent = false;
    // Controller label — set from manifest.controller.cli
    this.controllerLabel = 'Controller';
    // Worker label — set from manifest.worker.cli
    this.workerLabel = 'Worker';
  }

  write(text) {
    this.out.write(text);
  }

  /**
   * Colored circle prefix for a content line.
   */
  _circlePfx() {
    const c = this._currentColor;
    if (!this.useColor || !c) return `  ${glyph.circle} `;
    return `  ${c}${glyph.circle}${color.reset} `;
  }

  /**
   * Colored pipe connector between content lines.
   */
  _pipePfx() {
    const c = this._currentColor;
    if (!this.useColor || !c) return `  ${glyph.pipe}`;
    return `  ${c}${glyph.pipe}${color.reset}`;
  }

  /**
   * End the current section with a blank line.
   */
  _closeSection() {
    if (!this._currentActor) return;
    this.write('\n');
    this._currentActor = null;
    this._currentColor = null;
    this._hasContent = false;
  }

  /**
   * Print a section header for an actor. Only prints if the actor changed.
   */
  _ensureHeader(label, labelColor) {
    if (this._currentActor === label) return;
    this.flushStream();
    if (this._currentActor) {
      this._closeSection();
    }
    this._currentActor = label;
    this._currentColor = labelColor;
    this._hasContent = false;
    if (this.useColor) {
      this.write(`${labelColor}${color.bold}${label}${color.reset}\n`);
    } else {
      this.write(`${label}\n`);
    }
  }

  /**
   * Write a content line with a circle bullet. Adds a pipe connector
   * between consecutive content lines.
   */
  _contentLine(text) {
    if (this._hasContent) {
      this.write(`${this._pipePfx()}\n`);
    }
    this.write(`${this._circlePfx()}${text}\n`);
    this._hasContent = true;
  }

  /**
   * Write a continuation line (multi-line text within the same bullet).
   * Uses pipe prefix with padding to align with the circle text.
   */
  _continueLine(text) {
    this.write(`${this._pipePfx()} ${text}\n`);
  }

  flushStream() {
    if (this._mdBuffer) {
      const { text } = renderMarkdownLine(this._mdBuffer, this.useColor, this._mdInCodeBlock);
      this._continueLine(text);
      this._mdBuffer = '';
    }
    this._mdInCodeBlock = false;
  }

  /**
   * Print a plain text line under the given actor header.
   */
  line(label, text, labelColor) {
    this.flushStream();
    this._ensureHeader(label, labelColor);
    this._contentLine(text);
  }

  /**
   * Print text with markdown rendering under the given actor header.
   * Multi-line text shares one circle bullet; extra lines use pipe continuation.
   */
  mdLine(label, text, labelColor) {
    this.flushStream();
    this._ensureHeader(label, labelColor);
    const lines = String(text).replace(/\r/g, '').split('\n');
    let inCodeBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const { text: rendered, inCodeBlock: newState } = renderMarkdownLine(lines[i], this.useColor, inCodeBlock);
      inCodeBlock = newState;
      if (i === 0) {
        this._contentLine(rendered);
      } else {
        this._continueLine(rendered);
      }
    }
  }

  /**
   * Stream text with markdown rendering. Buffers partial lines and renders
   * complete lines through the markdown formatter.
   */
  streamMarkdown(label, text, labelColor) {
    if (!text) return;
    this._ensureHeader(label, labelColor);
    const normalized = String(text).replace(/\r/g, '');
    this._mdBuffer += normalized;

    let first = true;
    let nlIndex;
    while ((nlIndex = this._mdBuffer.indexOf('\n')) !== -1) {
      const completeLine = this._mdBuffer.slice(0, nlIndex);
      this._mdBuffer = this._mdBuffer.slice(nlIndex + 1);
      const { text: rendered, inCodeBlock } = renderMarkdownLine(completeLine, this.useColor, this._mdInCodeBlock);
      this._mdInCodeBlock = inCodeBlock;
      // First streamed line in this section gets a circle; rest get pipe continuation
      if (!this._hasContent && first) {
        this._contentLine(rendered);
        first = false;
      } else {
        this._continueLine(rendered);
      }
    }
  }

  banner(text) {
    this.flushStream();
    if (this._currentActor) {
      this._closeSection();
    }
    if (this.useColor) {
      this.write(`${color.banner}${text}${color.reset}\n`);
    } else {
      this.write(`${text}\n`);
    }
  }

  /**
   * Returns a colored prompt string for readline.
   */
  userPrompt() {
    this.flushStream();
    if (this._currentActor) {
      this._closeSection();
    }
    if (!this.useColor) {
      return '> ';
    }
    return `${color.dim}>${color.reset} `;
  }

  shell(text) {
    this.line('Shell', text, color.shell);
  }

  user(text) {
    this.flushStream();
    if (this._currentActor) {
      this._closeSection();
    }
    this._currentActor = 'User';
    this._currentColor = color.user;
    this._hasContent = false;
    // Move up one line and clear it to overwrite the readline echo
    if (this.out.isTTY) {
      this.write('\x1b[A\x1b[2K');
    }
    if (this.useColor) {
      this.write(`${color.user}${color.bold}User${color.reset}\n`);
      this.write(`${this._circlePfx()}${color.bgUser}${text}${color.reset}\n`);
    } else {
      this.write(`User\n`);
      this.write(`${this._circlePfx()}${text}\n`);
    }
    this._hasContent = true;
  }

  controller(text) {
    this.line(this.controllerLabel, text, color.controller);
  }

  claude(text) {
    this.line(this.workerLabel, text, color.claude);
  }

  launchClaude(prompt, sameSession, agentId, agentCli, agentName) {
    const backendLabel = agentCli ? workerLabelFor(agentCli, agentName) : this.workerLabel;
    const agentLabel = !agentName && agentId && agentId !== 'default' ? ` [${agentId}]` : '';
    const prefix = sameSession
      ? `Launching ${backendLabel}${agentLabel} (same session) with: `
      : `Launching ${backendLabel}${agentLabel} with: `;
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
    if (summary.kind === 'reasoning') {
      this.streamMarkdown(this.controllerLabel, summary.text);
      this.flushStream();
      return;
    }
    this.controller(summary.text);
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

  claudeControllerEvent(raw) {
    if (this.rawEvents) {
      this.flushStream();
      this.write(`${JSON.stringify({ source: 'controller', raw })}\n`);
      return;
    }
    const summary = summarizeClaudeEvent(raw);
    if (!summary || this.quiet) return;
    if (summary.kind === 'text-delta') {
      this.streamMarkdown(this.controllerLabel, summary.text, color.controller);
      return;
    }
    if (summary.kind === 'tool-start') {
      this.flushStream();
      this._toolCalls.set(summary.index, { name: summary.toolName, inputJson: '' });
      return;
    }
    if (summary.kind === 'tool-input-delta') {
      const tc = this._toolCalls.get(summary.index);
      if (tc) tc.inputJson += summary.text;
      return;
    }
    if (summary.kind === 'block-stop') {
      const tc = this._toolCalls.get(summary.index);
      if (tc) {
        let input = {};
        try { input = JSON.parse(tc.inputJson); } catch {}
        const desc = this._formatToolCall(tc.name, input);
        this._ensureHeader(this.controllerLabel, color.controller);
        this._contentLine(`${color.dim}${desc}${color.reset}`);
        this._toolCalls.delete(summary.index);
      }
      return;
    }
    if (summary.kind === 'assistant-text' || summary.kind === 'final-text') {
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      const c = summary.kind === 'error' ? color.error : color.controller;
      this.line(this.controllerLabel, summary.text, c);
    }
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
      this.streamMarkdown(this.workerLabel, summary.text, color.claude);
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
        this._ensureHeader(this.workerLabel, color.claude);
        this._contentLine(`${color.dim}${desc}${color.reset}`);
        this._toolCalls.delete(summary.index);
      }
      return;
    }
    if (summary.kind === 'assistant-text') {
      this.mdLine(this.workerLabel, summary.text, color.claude);
      return;
    }
    if (summary.kind === 'final-text') {
      if (!this.quiet) {
        this.mdLine(this.workerLabel, summary.text, color.claude);
      }
      return;
    }
    if (!this.quiet || summary.kind === 'error') {
      const c = summary.kind === 'error' ? color.error : color.claude;
      this.line(this.workerLabel, summary.text, c);
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

  chromeDevtoolsDetected() {
    // No-op for terminal renderer; webview renderer shows Chrome split widget
  }
}

module.exports = {
  Renderer,
  controllerLabelFor,
  workerLabelFor,
};
