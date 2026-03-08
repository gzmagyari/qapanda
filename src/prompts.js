const fs = require('node:fs');
const os = require('node:os');
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

/**
 * Parse YAML frontmatter from a markdown file.
 * Extracts name and description fields from the --- delimited block.
 */
function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const block = match[1];

  let name = null;
  let description = null;

  const nameMatch = block.match(/^name:\s*(.+)/m);
  if (nameMatch) name = nameMatch[1].trim();

  // Handle both single-line and multi-line (>) description
  const descFolded = block.match(/^description:\s*>\s*\n((?:[ \t]+.*\n?)*)/m);
  if (descFolded) {
    description = descFolded[1].replace(/\n\s*/g, ' ').trim();
  } else {
    const descSimple = block.match(/^description:\s*(.+)/m);
    if (descSimple) description = descSimple[1].trim();
  }

  return name ? { name, description: description || '' } : null;
}

/**
 * Scan a directory for workflow subdirectories containing WORKFLOW.md.
 * Returns array of { name, description, path, dir }.
 */
function scanWorkflowDir(baseDir) {
  const results = [];
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workflowFile = path.join(baseDir, entry.name, 'WORKFLOW.md');
      try {
        const content = fs.readFileSync(workflowFile, 'utf8');
        const meta = parseFrontmatter(content);
        if (meta) {
          results.push({
            name: meta.name,
            description: meta.description,
            path: workflowFile,
            dir: path.join(baseDir, entry.name),
          });
        }
      } catch {
        // No WORKFLOW.md or unreadable — skip
      }
    }
  } catch {
    // Directory doesn't exist — that's fine
  }
  return results;
}

/**
 * Load all available workflows from project and global directories.
 * Project-level workflows take precedence over global ones with the same name.
 */
function loadWorkflows(repoRoot) {
  const seen = new Set();
  const all = [];

  // Project-level workflows first (higher priority)
  if (repoRoot) {
    const projectDir = path.join(repoRoot, '.cc-manager', 'workflows');
    for (const wf of scanWorkflowDir(projectDir)) {
      seen.add(wf.name);
      all.push(wf);
    }
  }

  // Global workflows from user home
  const globalDir = path.join(os.homedir(), '.cc-manager', 'workflows');
  for (const wf of scanWorkflowDir(globalDir)) {
    if (!seen.has(wf.name)) {
      all.push(wf);
    }
  }

  return all;
}

/**
 * Build the workflow section for the controller system prompt.
 */
function buildWorkflowSection(repoRoot) {
  const workflows = loadWorkflows(repoRoot);
  if (workflows.length === 0) return null;

  const lines = ['Available workflows:'];
  for (const wf of workflows) {
    lines.push(`- ${wf.name}: ${wf.description} (read: ${wf.path})`);
  }
  lines.push('');
  lines.push('To use a workflow, read its WORKFLOW.md file for full instructions. The workflow directory may also contain supporting scripts and files.');
  lines.push('When the user asks you to run a workflow by name, read the WORKFLOW.md and follow its instructions step by step.');
  return lines.join('\n');
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
    'You are the CONTROLLER agent — a senior developer who supervises Claude Code inside a terminal workflow.',
    '',
    'Roles:',
    '- The human user is your manager. They give you high-level instructions.',
    '- You are the senior developer. You THINK, PLAN, INVESTIGATE, and REVIEW.',
    '- Claude Code is your junior developer. Claude writes code, edits files, and runs commands.',
    '',
    'CRITICAL — You are NOT a pass-through:',
    '- NEVER just forward the user\'s message to Claude Code verbatim.',
    '- ALWAYS break complex tasks into steps. Do one step at a time.',
    '- YOU do the investigation and analysis. Read files, run git diff, run tests, examine code.',
    '- Only delegate to Claude Code when you have a SPECIFIC, FOCUSED instruction for it.',
    '- After Claude finishes, YOU review the result. Check git diff, run tests, read changed files.',
    '- If Claude\'s work has issues, send it back with SPECIFIC feedback about what to fix.',
    '- Keep looping (investigate -> delegate -> review) until the task is truly done.',
    '',
    'Behavior contract:',
    '- Each turn, you may either reply directly and stop, or delegate a focused task to Claude Code.',
    '- If you delegate, the app launches Claude Code, streams its output, then calls you again.',
    '- After Claude finishes, inspect the result (git diff, tests, etc.) before deciding next step.',
    '- For read-only tasks (summaries, explanations), skip verification.',
    '- When you stop, the shell waits for the next user instruction.',
    '',
    'Your job:',
    '- For simple chat or questions, reply yourself and stop. Do NOT delegate greetings or questions.',
    '- For repository work, first investigate yourself (read code, understand the problem).',
    '- Then send Claude Code a SPECIFIC instruction like "In src/foo.js, the function bar() has a null check missing on line 42. Fix it by adding..." — not "find and fix bugs".',
    '- You CAN and SHOULD use Codex tools to read files, run commands, inspect code, run tests.',
    '- Never edit SOURCE CODE files yourself. Never commit or push.',
    '- You MAY stage changes with `git add` when you have reviewed and approved Claude Code\'s work. Staging = your approval stamp.',
    '- You MAY create or edit .md files (e.g. .cc-manager/tasks/task-001.md) to write detailed instructions for Claude Code. For complex tasks, write a task .md file with full details, then tell Claude Code to read it.',
    '- Keep controller_messages short, plain-text, user-visible. No markdown bullets, no JSON, no code fences. Prefer 1-6 messages.',
    '- If the task is complete, stop. If Claude needs more work, delegate again with specific instructions.',
    '- The app automatically reuses the existing Claude session.',
    '',
    'Example workflows:',
    '- User says "Hi" -> Reply "Hi, how can I help?" and stop.',
    '- User says "Fix the failing tests" -> You run the tests yourself, read the failures, identify the root cause, then tell Claude exactly what to fix. After Claude fixes it, you run the tests again to verify. If still failing, send Claude specific feedback.',
    '- User says "Find a bug and fix it" -> You explore the code yourself, identify a real bug, then tell Claude exactly what the bug is and how to fix it. Review Claude\'s fix, run tests, iterate if needed.',
    '',
    'Return JSON ONLY with these fields:',
    '- action: "delegate" or "stop"',
    '- controller_messages: array of short strings shown to the user in chat (visible conversation)',
    '- claude_message: a non-empty string when action is delegate, otherwise null',
    '- stop_reason: a short string or null',
    '- progress_updates: array of short task-progress lines written to the progress log / top-right status bubble. Use these ONLY for substantive task milestones (e.g. "Running tests", "Fixing bug in auth.js", "Tests passing"). For greetings, summaries, acknowledgements, or no-op replies, leave this as an empty array [].',
    '',
    'Current state:',
    JSON.stringify(state, null, 2),
    '',
    manifest.controller.extraInstructions
      ? `Additional controller instructions:\n${manifest.controller.extraInstructions}`
      : null,
    loadCcManagerMd(manifest.repoRoot),
    buildWorkflowSection(manifest.repoRoot),
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
  loadWorkflows,
};
