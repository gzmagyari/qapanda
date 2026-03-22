'use strict';

const crypto = require('node:crypto');
const { classifyLine, isSpinnerLine, SPINNER_RE, parseToolCall } = require('./parse-stream');

class ClaudeSession {
  /**
   * @param {object} opts
   * @param {string}  [opts.cwd]             Working directory
   * @param {string}  [opts.bin]             Claude binary name (default: 'claude')
   * @param {string[]} [opts.args]           Extra CLI args
   * @param {object}  [opts.env]             Environment variables
   * @param {number}  [opts.cols]            Terminal columns (default: 220)
   * @param {number}  [opts.rows]            Terminal rows (default: 50)
   * @param {number}  [opts.pollInterval]    Idle poll interval ms (default: 200)
   * @param {number}  [opts.startupTimeout]  Max ms to wait for initial ready (default: 30000)
   * @param {number}  [opts.turnTimeout]     Max ms per turn (default: 300000)
   * @param {number}  [opts.scrollback]      Xterm scrollback lines (default: 5000)
   */
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.cols = opts.cols || 220;
    this.rows = opts.rows || 50;
    this.claudeArgs = opts.args || ['--dangerously-skip-permissions'];
    this.claudeBin = opts.bin || 'claude';
    this.env = opts.env || { ...process.env };
    this.pollInterval = opts.pollInterval || 200;
    this.startupTimeout = opts.startupTimeout || 30000;
    this.turnTimeout = opts.turnTimeout || 300000;
    this.scrollback = opts.scrollback || 5000;

    // Internal state
    this._pty = null;
    this._term = null;
    this._started = false;
    this._ready = false;
    this._busy = false;
    this._sessionId = null;
    this._turnIndex = 0;
    this._onDataHandler = null;
    this._onExitHandler = null;
    this._closed = false;
  }

  get started() { return this._started; }
  get busy() { return this._busy; }
  get sessionId() { return this._sessionId; }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start() {
    if (this._started) return;
    this._started = true;

    const { Terminal } = require('@xterm/headless');
    const pty = require('node-pty');

    this._term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });

    // Generate a session ID upfront so we always have one
    if (!this._sessionId) {
      this._sessionId = crypto.randomUUID();
    }

    const isWin = process.platform === 'win32';
    const fullArgs = ['--session-id', this._sessionId, ...this.claudeArgs];
    const cmd = isWin ? 'cmd.exe' : this.claudeBin;
    const args = isWin
      ? ['/c', this.claudeBin, ...fullArgs]
      : fullArgs;

    const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = this.env;

    this._pty = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: cleanEnv,
    });

    this._pty.onData((data) => {
      this._term.write(data);
      if (this._onDataHandler) this._onDataHandler(data);
    });

    this._pty.onExit(({ exitCode }) => {
      this._closed = true;
      if (this._onExitHandler) this._onExitHandler(exitCode);
    });

    await this._waitForIdle(this.startupTimeout);
    this._ready = true;
    // Session ID was set before spawn via --session-id, keep it
  }

  abort() {
    if (!this._busy) return;
    // Send Escape to interrupt current turn (keeps session alive)
    this._pty.write('\x1b');
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._pty.write('/exit\r');
      setTimeout(() => {
        try { this._pty.kill(); } catch {}
      }, 2000);
    } catch {
      try { this._pty.kill(); } catch {}
    }
  }

  // ── Core: send a message and stream events ────────────────────────

  /**
   * Send a prompt and receive streaming events.
   * @param {string} prompt
   * @param {object} [callbacks]
   * @param {function} [callbacks.onEvent] Called for each parsed event
   * @returns {Promise<{prompt, exitCode, signal, sessionId, hadTextDelta, resultText, finalEvent}>}
   */
  async send(prompt, callbacks = {}) {
    if (!this._started) await this.start();
    if (this._busy) throw new Error('ClaudeSession: already processing a turn');
    if (this._closed) throw new Error('ClaudeSession: process has exited');

    this._busy = true;
    this._turnIndex++;

    const shortPrompt = prompt.slice(0, 30);
    let lastResponseText = '';
    const emittedLines = new Set(); // track lines we've already emitted events for
    let toolIndex = 0;

    return new Promise((resolve, reject) => {
      const turnTimeout = setTimeout(() => {
        cleanup();
        reject(new Error('ClaudeSession: turn timed out'));
      }, this.turnTimeout);

      // On each PTY data chunk, diff the buffer and emit events.
      // We track emitted lines by their text to avoid duplicates on repaints.
      const onData = () => {
        const lines = this._snapshotBuffer();
        const current = this._getResponseText(lines, shortPrompt);
        if (current === lastResponseText) return;

        // Classify all current lines and emit any we haven't seen before
        const currentLines = current.split('\n');
        for (const line of currentLines) {
          const classified = classifyLine(line);
          if (!classified) continue;
          // Use the raw line as dedup key
          const key = line.trim();
          if (emittedLines.has(key)) continue;
          emittedLines.add(key);
          this._emitClassified(classified, callbacks, toolIndex);
          if (classified.type === 'tool') toolIndex++;
        }
        lastResponseText = current;
      };

      this._onDataHandler = onData;

      // Poll for idle state (turn completion)
      const idlePoll = setInterval(() => {
        const lines = this._snapshotBuffer();

        // Must have our prompt echoed
        const promptIdx = lines.findIndex(l => l.startsWith('❯') && l.includes(shortPrompt));
        if (promptIdx === -1) return;

        // Must have a response started
        const responseIdx = lines.findIndex((l, i) => i > promptIdx && l.startsWith('●'));
        if (responseIdx === -1) return;

        // No spinners in content area
        const firstSep = lines.findIndex((l, i) => i > promptIdx && l.startsWith('────'));
        const contentArea = firstSep === -1 ? lines.slice(promptIdx) : lines.slice(promptIdx, firstSep);
        if (contentArea.some(l => isSpinnerLine(l))) return;

        // Status bar not showing "esc to interrupt" (still processing)
        const statusLine = lines.find(l => l.includes('⏵⏵'));
        if (statusLine && statusLine.includes('esc to interrupt')) return;

        // Check idle: two separators with just ❯ between
        if (!this._isIdle(lines)) return;

        cleanup();

        // Final content extraction
        const finalText = this._getResponseText(lines, shortPrompt);

        // Emit final-text
        if (callbacks.onEvent) {
          callbacks.onEvent({ source: 'worker', kind: 'final-text', text: finalText });
        }

        resolve({
          prompt,
          exitCode: 0,
          signal: null,
          sessionId: this._sessionId,
          hadTextDelta: lastResponseText.length > 0,
          resultText: this._extractPlainText(finalText),
          finalEvent: null,
        });
      }, this.pollInterval);

      // Handle unexpected exit during turn
      this._onExitHandler = (code) => {
        cleanup();
        reject(new Error(`ClaudeSession: process exited unexpectedly (code ${code})`));
      };

      const cleanup = () => {
        clearInterval(idlePoll);
        clearTimeout(turnTimeout);
        this._onDataHandler = null;
        this._onExitHandler = null;
        this._busy = false;
      };

      // Send the prompt
      if (prompt.includes('\n')) {
        // Multi-line: use bracketed paste
        this._pty.write('\x1b[200~' + prompt + '\x1b[201~');
        setTimeout(() => this._pty.write('\r'), 200);
      } else {
        this._pty.write(prompt + '\r');
      }
    });
  }

  // ── Internal helpers ───────────────────────────────────────────────

  _emitClassified(classified, callbacks, toolIndex) {
    if (!callbacks.onEvent) return;

    if (classified.type === 'text') {
      callbacks.onEvent({ source: 'worker', kind: 'text-delta', text: classified.text });
    } else if (classified.type === 'tool') {
      const parsed = parseToolCall(classified.text);
      callbacks.onEvent({
        source: 'worker',
        kind: 'tool-start',
        toolName: parsed ? parsed.name : 'unknown',
        toolText: classified.text,
        index: toolIndex,
      });
    } else if (classified.type === 'tool_out') {
      callbacks.onEvent({ source: 'worker', kind: 'tool-output', text: classified.text });
    }
  }

  _snapshotBuffer() {
    const lines = [];
    for (let i = 0; i < this._term.buffer.active.length; i++) {
      const line = this._term.buffer.active.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true).trimEnd();
      if (text) lines.push(text);
    }
    return lines;
  }

  _isIdle(lines) {
    const sepIndices = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('────')) sepIndices.push(i);
    }
    if (sepIndices.length < 2) return false;
    const lastSep = sepIndices[sepIndices.length - 1];
    const prevSep = sepIndices[sepIndices.length - 2];
    const between = lines.slice(prevSep + 1, lastSep);
    return between.length === 1 && between[0].trimEnd() === '❯';
  }

  _waitForIdle(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('ClaudeSession: timed out waiting for idle state'));
      }, timeout);

      const poll = setInterval(() => {
        const lines = this._snapshotBuffer();
        if (this._isIdle(lines)) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(lines);
        }
      }, this.pollInterval);
    });
  }

  _getResponseText(lines, shortPrompt) {
    // Find the LAST prompt line matching our prompt (handles multi-turn)
    let promptIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('❯') && lines[i].includes(shortPrompt)) {
        promptIdx = i;
        break;
      }
    }
    if (promptIdx === -1) return '';
    const firstSepAfter = lines.findIndex((l, i) => i > promptIdx && l.startsWith('────'));
    const contentLines = firstSepAfter === -1
      ? lines.slice(promptIdx + 1)
      : lines.slice(promptIdx + 1, firstSepAfter);
    // Strip trailing spinner lines
    while (contentLines.length && SPINNER_RE.test(contentLines[contentLines.length - 1].trimStart())) {
      contentLines.pop();
    }
    return contentLines.join('\n');
  }

  /**
   * Extract plain text from the response content.
   * Strips ● and ⎿ prefixes, tool call lines, and UI noise.
   */
  _extractPlainText(responseText) {
    const lines = responseText.split('\n');
    const textLines = [];
    for (const line of lines) {
      const classified = classifyLine(line);
      if (classified && classified.type === 'text') {
        textLines.push(classified.text);
      }
    }
    return textLines.join('\n');
  }

  _extractSessionId() {
    const lines = this._snapshotBuffer();
    for (const line of lines) {
      // Claude shows resume info like: claude --resume <uuid>
      const match = line.match(/--resume\s+([a-f0-9-]{36})/);
      if (match) return match[1];
    }
    // Also check for session ID in welcome box or status
    for (const line of lines) {
      const match = line.match(/[Ss]ession[:\s]+([a-f0-9-]{36})/);
      if (match) return match[1];
    }
    return null;
  }
}

module.exports = { ClaudeSession };
