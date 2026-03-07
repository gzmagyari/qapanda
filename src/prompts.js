const fs = require('node:fs');
const path = require('node:path');
const { truncate } = require('./utils');

function buildTranscriptExcerpt(manifest, limit = 18) {
  const requestLines = [];
  for (const request of manifest.requests.slice(-6)) {
    requestLines.push(`User: ${request.userMessage}`);
    for (const loop of request.loops.slice(-4)) {
      if (loop.controller && loop.controller.decision) {
        for (const message of loop.controller.decision.controller_messages || []) {
          requestLines.push(`Controller: ${message}`);
        }
      }
      if (loop.worker && loop.worker.resultText) {
        requestLines.push(`Claude Code: ${truncate(loop.worker.resultText, 600)}`);
      }
    }
    if (request.stopReason) {
      requestLines.push(`Controller STOP reason: ${request.stopReason}`);
    }
  }
  return requestLines.slice(-limit);
}

function loadCcManagerMd(repoRoot) {
  if (!repoRoot) return null;
  const filePath = path.join(repoRoot, 'CCMANAGER.md');
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (content) {
      return `Project instructions from CCMANAGER.md:\n${content}`;
    }
  } catch {
    // File doesn't exist — that's fine
  }
  return null;
}

function buildControllerPrompt(manifest, request) {
  const lastLoop = request.loops[request.loops.length - 1] || null;
  const lastWorker = lastLoop && lastLoop.worker ? lastLoop.worker : request.latestWorkerResult || null;
  const transcriptLines = buildTranscriptExcerpt(manifest);

  const state = {
    repository_root: manifest.repoRoot,
    run_id: manifest.runId,
    request_id: request.id,
    controller_session_id: manifest.controller.sessionId,
    claude_session_id: manifest.worker.sessionId,
    claude_session_started: manifest.worker.hasStarted,
    request_started_at: request.startedAt,
    current_loop_index: request.loops.length + 1,
    latest_user_message: request.userMessage,
    latest_stop_reason: manifest.stopReason,
    latest_claude_prompt: lastWorker ? lastWorker.prompt : null,
    latest_claude_exit_code: lastWorker ? lastWorker.exitCode : null,
    latest_claude_result: lastWorker ? lastWorker.resultText : null,
    recent_transcript: transcriptLines,
  };

  return [
    'You are the CONTROLLER agent inside a terminal workflow.',
    '',
    'Roles:',
    '- The human user is your manager.',
    '- You are the developer/controller who talks to the manager directly.',
    '- Claude Code is your executor. Claude does the actual repository work.',
    '',
    'Behavior contract:',
    '- Each time the manager sends a message, you may either reply directly and stop, or delegate work to Claude Code.',
    '- If you delegate, the outer app will launch Claude Code, stream Claude output live, then call you again after Claude finishes.',
    '- After Claude finishes, if the task involved file changes, inspect the repo (git diff, tests, etc.) before deciding. If the task was read-only (summaries, explanations, etc.), skip verification and decide immediately.',
    '- When you stop, the shell remains open and waits for the next manager instruction.',
    '',
    'Your job:',
    '- Act like a competent developer supervising Claude Code.',
    '- For simple chat, acknowledgements, or questions that do not require repository work, do NOT delegate. Reply yourself and stop.',
    '- For repository work, usually delegate to Claude Code.',
    '- You may use Codex tools to inspect and verify. You may run safe verification commands.',
    '- Never edit files yourself. Never stage, commit, push, or modify the repository. Inspection and verification only.',
    '- Keep controller_messages short, plain-text, and user-visible. No markdown bullets, no JSON, no code fences. Prefer 1 to 6 messages.',
    '- If the task is complete or nothing useful remains, stop.',
    '- If Claude needs another instruction, delegate again with a concise operational claude_message.',
    '- The outer app automatically reuses the existing Claude session when one exists.',
    '- When you do verify Claude work, briefly mention what you checked. But do not run verification steps for read-only tasks.',
    '',
    'Examples:',
    '- Greeting example: manager says "Hi" -> you reply with something like "Hi, how can I help you?" and stop.',
    '- Work example: manager asks to fix tests -> you say you will instruct Claude, delegate to Claude, review Claude result, then either delegate again or stop.',
    '',
    'Return JSON ONLY with these fields:',
    '- action: "delegate" or "stop"',
    '- controller_messages: array of short strings shown as Controller: ...',
    '- claude_message: a non-empty string when action is delegate, otherwise null',
    '- stop_reason: a short string or null',
    '',
    'Current state:',
    JSON.stringify(state, null, 2),
    '',
    manifest.controller.extraInstructions
      ? `Additional controller instructions:\n${manifest.controller.extraInstructions}`
      : null,
    loadCcManagerMd(manifest.repoRoot),
    '',
    'Now decide the next step. Return JSON only.',
  ].filter(Boolean).join('\n');
}

function buildDefaultWorkerAppendSystemPrompt() {
  return [
    'You are Claude Code acting as the executor in a supervised workflow.',
    'A controller agent will review your work after every run and may send you another message in the same session.',
    'Do the actual repository work yourself.',
    'While working, narrate concise progress updates in plain text so the terminal stream stays readable.',
    'Mention files and commands when helpful.',
    'When you believe the task is done, clearly state what changed and whether verification or tests passed.',
    'Do not ask the human to manually continue the workflow unless you are truly blocked.',
  ].join(' ');
}

module.exports = {
  buildControllerPrompt,
  buildDefaultWorkerAppendSystemPrompt,
};
