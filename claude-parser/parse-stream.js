/**
 * Real-time ANSI stream parser for Claude Code interactive PTY output.
 *
 * Claude's TUI sends the response text in one or a few large repaint chunks,
 * with words separated by \x1b[1C (cursor-forward-1) and line breaks via
 * cursor-positioning sequences like \x1b[ROW;COLh. This parser extracts
 * the clean text from each PTY data chunk as it arrives.
 *
 * Exported: parseChunk(data) -> { type, text } | null
 *
 * Types emitted:
 *   { type: 'text',      text }  — Claude response text delta
 *   { type: 'tool',      text }  — tool call line e.g. "Bash(echo hi)"
 *   { type: 'tool_out',  text }  — tool output line (⎿ prefix)
 *
 * End-of-turn detection is NOT done here — use the xterm buffer poller
 * (waitForResponse) which is more reliable than parsing the raw stream.
 */

'use strict';

// Strip all ANSI escape sequences and return raw printable text
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;]*[mGKHJABCDEFMPQRSTlh>?]/g, ' ')  // CSI sequences → space
    .replace(/\x1b\[[0-9]+;[0-9]+[Hf]/g, '\n')                // cursor position → newline
    .replace(/\x1b\][^\x07]*\x07/g, '')                        // OSC sequences
    .replace(/\x1b[=>]/g, '')                                   // other escapes
    .replace(/\r/g, '');
}

// Extract only the cursor-forward separators as spaces, keeping structure
function extractText(raw) {
  let result = raw
    // cursor-position → newline (line breaks in the response)
    .replace(/\x1b\[(\d+);(\d+)[Hf]/g, '\n')
    // cursor-forward-1 → space (word separators)
    .replace(/\x1b\[1C/g, ' ')
    // cursor-forward-N → N spaces
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Math.min(Number(n), 4)))
    // bold on/off — keep as markers temporarily
    .replace(/\x1b\[1m/g, '')
    .replace(/\x1b\[22m/g, '')
    // strip remaining CSI sequences
    .replace(/\x1b\[[0-9;]*[mGKJABDEFMPQRSTlh>?]/g, '')
    // OSC sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // other escapes
    .replace(/\x1b[=>]/g, '')
    // collapse multiple spaces
    .replace(/ {2,}/g, ' ')
    .replace(/\r/g, '');

  return result;
}

// Classify a line of extracted text
function classifyLine(line) {
  const t = line.trim();
  if (!t) return null;

  // Separator lines — UI chrome, skip
  if (t.startsWith('────')) return null;

  // Status bar — UI chrome, skip
  if (t.includes('⏵⏵') || t.includes('bypass permissions')) return null;

  // Tip messages — UI noise, skip
  if (t.startsWith('Tip:')) return null;

  // Spinner / thinking lines — skip (end-of-turn is detected via xterm buffer poll)
  if (/^[✢✣✤✥✦✧✶✷✸✹✺✻✼✽✾*·◐◑◒◓○◌]/.test(t) && t.includes('…')) return null;

  // User prompt line — skip
  if (t.startsWith('❯')) return null;

  // Tool output (⎿ prefix)
  if (t.startsWith('⎿')) {
    const out = t.replace(/^⎿\s*/, '').trim();
    return out ? { type: 'tool_out', text: out } : null;
  }

  // Collapsed file read lines e.g. "Read 1 file (ctrl+o to expand)"
  if (/^Read \d+ files?/.test(t)) {
    return { type: 'tool_out', text: t };
  }

  // Tool call or response text (● prefix)
  if (t.startsWith('●')) {
    const inner = t.slice(1).trim();
    if (!inner) return null;
    // Tool calls look like "Bash(...)", "Write(...)", "Update(...)", etc.
    if (/^(Bash|Write|Read|Edit|Update|Glob|Grep|WebFetch|WebSearch|TodoWrite|mcp__\w+)\s*[\(\[]/.test(inner)) {
      return { type: 'tool', text: inner };
    }
    return { type: 'text', text: inner };
  }

  // Transient "Reading N file(s)…" with ctrl+o — spinner-like, skip
  if (/^Reading \d+ files?…/.test(t)) return null;

  // Continuation/indented response text (2-space indent = continuation of ● block)
  if (line.startsWith('  ') && t && !t.startsWith('⎿')) {
    // Skip UI noise like "Running…", tip messages
    if (t.includes('Running…') || t.includes('ctrl+o') || t.includes('Tip:')) return null;
    return { type: 'text', text: t };
  }

  return null;
}

/**
 * Parse a raw PTY data chunk and extract structured events.
 * @param {string} data — raw PTY output chunk
 * @returns {Array<{type, text?}>}
 */
function parseChunk(data) {
  const text = extractText(data);
  const lines = text.split('\n');
  const events = [];

  for (const line of lines) {
    const event = classifyLine(line);
    if (event) events.push(event);
  }

  return events;
}

const SPINNER_RE = /^[✢✣✤✥✦✧✶✷✸✹✺✻✼✽✾*·◐◑◒◓○◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

function isSpinnerLine(line) {
  const t = line.trimStart();
  return SPINNER_RE.test(t) && t.includes('…');
}

/**
 * Parse a tool call string like "Bash(echo hello)" into { name, argsText }.
 * Returns null if not a tool call format.
 */
function parseToolCall(text) {
  const match = text.match(/^(\w+)\s*\(([^]*)\)$/);
  if (match) return { name: match[1], argsText: match[2] };
  const match2 = text.match(/^(\w+)\s*\[([^]*)\]$/);
  if (match2) return { name: match2[1], argsText: match2[2] };
  return null;
}

module.exports = { parseChunk, extractText, classifyLine, isSpinnerLine, SPINNER_RE, parseToolCall };
