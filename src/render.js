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

class Renderer {
  constructor(options = {}) {
    this.rawEvents = Boolean(options.rawEvents);
    this.quiet = Boolean(options.quiet);
    this.out = options.out || process.stdout;
    this.streamLabel = null;
    this.useColor = options.color != null ? Boolean(options.color) : (this.out.isTTY !== false);
    // Markdown streaming state
    this._mdBuffer = '';
    this._mdInCodeBlock = false;
    this._mdLabel = null;
    this._mdColor = null;
    // Tool call tracking: index -> { name, inputJson }
    this._toolCalls = new Map();
    // Active label tracking — only print label when it changes
    this._activeLabel = null;
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

  /**
   * Returns the label prefix or equivalent padding.
   * Only prints the actual label when the actor changes.
   */
  _labelOrPad(label, c) {
    const labelStr = this._colorLabel(label, c);
    if (this._activeLabel !== label) {
      this._activeLabel = label;
      return labelStr;
    }
    // Pad with spaces to match label width (label + colon)
    const padLen = label.length + 1;
    return ' '.repeat(padLen);
  }

  flushStream() {
    // Flush any remaining markdown buffer (partial last line)
    if (this._mdBuffer) {
      // Write label prefix if we haven't started this line yet
      if (!this.streamLabel && this._mdLabel) {
        this.write(`${this._labelOrPad(this._mdLabel, this._mdColor)} `);
        this.streamLabel = this._mdLabel;
      }
      const { text } = renderMarkdownLine(this._mdBuffer, this.useColor, this._mdInCodeBlock);
      this.write(text);
      this._mdBuffer = '';
    }
    if (this.streamLabel) {
      this.write('\n');
      this.streamLabel = null;
    }
    this._mdLabel = null;
    this._mdColor = null;
    this._mdInCodeBlock = false;
  }

  line(label, text, c) {
    this.flushStream();
    this.write(`${this._labelOrPad(label, c)} ${text}\n`);
  }

  /**
   * Like line() but renders the text through the markdown formatter.
   */
  mdLine(label, text, c) {
    this.flushStream();
    const lines = String(text).replace(/\r/g, '').split('\n');
    let inCodeBlock = false;
    for (const rawLine of lines) {
      const { text: rendered, inCodeBlock: newState } = renderMarkdownLine(rawLine, this.useColor, inCodeBlock);
      inCodeBlock = newState;
      this.write(`${this._labelOrPad(label, c)} ${rendered}\n`);
    }
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
        this.write(`${this._labelOrPad(label, c)} `);
        this.streamLabel = label;
      } else if (this.streamLabel !== label) {
        this.flushStream();
        this.write(`${this._labelOrPad(label, c)} `);
        this.streamLabel = label;
      }
      this.write(part);
      if (!isLast) {
        this.write('\n');
        this.streamLabel = null;
      }
    }
  }

  /**
   * Stream text with markdown rendering. Buffers partial lines and renders
   * complete lines through the markdown formatter.
   */
  streamMarkdown(label, text, c) {
    if (!text) return;
    const normalized = String(text).replace(/\r/g, '');

    // If label changed, flush previous
    if (this._mdLabel && this._mdLabel !== label) {
      this.flushStream();
    }
    this._mdLabel = label;
    this._mdColor = c;

    this._mdBuffer += normalized;

    // Process all complete lines in the buffer
    let nlIndex;
    while ((nlIndex = this._mdBuffer.indexOf('\n')) !== -1) {
      const completeLine = this._mdBuffer.slice(0, nlIndex);
      this._mdBuffer = this._mdBuffer.slice(nlIndex + 1);

      // Write label prefix if we're starting a new line
      if (!this.streamLabel) {
        this.write(`${this._labelOrPad(label, c)} `);
        this.streamLabel = label;
      }

      const { text: rendered, inCodeBlock } = renderMarkdownLine(completeLine, this.useColor, this._mdInCodeBlock);
      this._mdInCodeBlock = inCodeBlock;
      this.write(`${rendered}\n`);
      this.streamLabel = null; // next line needs a new label
    }

    // If there's remaining partial text, write it (unformatted, will be completed later)
    // But don't write it yet — keep buffering until we get a newline or flush
  }

  banner(text) {
    this.flushStream();
    this._activeLabel = null;
    if (this.useColor) {
      this.write(`${color.banner}${text}${color.reset}\n`);
    } else {
      this.write(`${text}\n`);
    }
  }

  /**
   * Returns a colored "User: " string suitable for use as a readline prompt.
   */
  userPrompt() {
    if (!this.useColor) {
      return 'User: ';
    }
    return `${color.user}${color.bold}User:${color.reset} `;
  }

  shell(text) {
    this.line('Shell', text, color.shell);
  }

  user(text) {
    this._activeLabel = null;
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
    // Show raw input for unknown tools
    const keys = Object.keys(input);
    if (keys.length > 0) {
      const brief = keys.map(k => `${k}=${truncate(String(input[k]), 80)}`).join(', ');
      return `${name}: ${brief}`;
    }
    return `Using ${name}`;
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
      this.streamMarkdown('Claude code', summary.text, color.claude);
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
        this.line('Claude code', desc, color.claude);
        this._toolCalls.delete(summary.index);
      }
      return;
    }
    if (summary.kind === 'assistant-text') {
      this.mdLine('Claude code', summary.text, color.claude);
      return;
    }
    if (summary.kind === 'final-text') {
      if (!this.quiet) {
        this.mdLine('Claude code', summary.text, color.claude);
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
