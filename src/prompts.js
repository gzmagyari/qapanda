const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { truncate } = require('./utils');

/**
 * Build transcript excerpt from chat.jsonl — the unified chat history.
 * Falls back to manifest.requests if chat.jsonl doesn't exist (backward compat).
 * @param {object} manifest
 * @param {number} [sinceLine] - If provided, only include chat lines from this index onward (for incremental resume).
 */
function buildTranscriptExcerpt(manifest, sinceLine) {
  // Try reading from chat.jsonl first (unified chat log with everything the user sees)
  const chatLogFile = manifest.files && manifest.files.chatLog;
  if (chatLogFile) {
    try {
      const raw = fs.readFileSync(chatLogFile, 'utf8').trim();
      if (raw) {
        const allLines = raw.split('\n');
        const lines = (sinceLine != null && sinceLine > 0) ? allLines.slice(sinceLine) : allLines;
        return lines.map(line => {
          try {
            const e = JSON.parse(line);
            if (e.type === 'user') return `User: ${e.text}`;
            if (e.type === 'controller') return `${e.label || 'Controller'}: ${e.text}`;
            if (e.type === 'claude' || e.type === 'mdLine') return `${e.label || 'Worker'}: ${e.text}`;
            if (e.type === 'toolCall') return `${e.label || 'Worker'} tool: ${e.text}`;
            if (e.type === 'stop') return `${e.label || 'Controller'}: STOP`;
            if (e.type === 'error') return `Error: ${e.text}`;
            if (e.type === 'banner') return `System: ${e.text}`;
            if (e.type === 'shell') return `Shell: ${e.text}`;
            if (e.type === 'line') return `${e.label || ''}: ${e.text}`;
            if (e.type === 'chatScreenshot') return null; // skip images in controller context
            return null;
          } catch { return null; }
        }).filter(Boolean);
      }
    } catch {
      // chat.jsonl unreadable — fall through to legacy
    }
  }

  // Fallback: build from manifest.requests (legacy, no tool calls or delegations)
  const allRequests = manifest.requests || [];
  const requests = allRequests;
  const requestLines = [];
  for (const request of requests) {
    const msg = request.userMessage;
    if (msg && !msg.startsWith('[AUTO-CONTINUE]') && !msg.startsWith('[CONTROLLER GUIDANCE]') && !msg.startsWith('[ORCHESTRATE]')) {
      requestLines.push(`User: ${msg}`);
    }
    for (const loop of request.loops || []) {
      if (loop.controller && loop.controller.decision) {
        for (const message of loop.controller.decision.controller_messages || []) {
          requestLines.push(`Controller: ${message}`);
        }
      }
      if (loop.worker && loop.worker.resultText) {
        requestLines.push(`Worker: ${loop.worker.resultText}`);
      }
    }
    if (request.stopReason) {
      requestLines.push(`Stop reason: ${request.stopReason}`);
    }
  }
  return requestLines;
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

function buildOverriddenControllerPrompt(manifest, request) {
  const lastLoop = request.loops[request.loops.length - 1] || null;
  let lastWorker = lastLoop && lastLoop.worker ? lastLoop.worker : request.latestWorkerResult || null;

  // If this is a new request (continue/loop) with no worker yet, look at the previous request's last worker
  if (!lastWorker && manifest.requests.length > 1) {
    const prevReq = manifest.requests[manifest.requests.length - 2];
    if (prevReq) {
      const prevLastLoop = prevReq.loops[prevReq.loops.length - 1] || null;
      lastWorker = (prevLastLoop && prevLastLoop.worker) ? prevLastLoop.worker : prevReq.latestWorkerResult || null;
    }
  }

  const transcriptLines = buildTranscriptExcerpt(manifest);
  const workerCli = manifest.worker.cli || manifest.worker.bin || 'claude';

  // For auto-continue requests, show the original user message instead of the [AUTO-CONTINUE] prefix
  let userMessage = request.userMessage;
  if (userMessage && (userMessage.startsWith('[AUTO-CONTINUE]') || userMessage.startsWith('[CONTROLLER GUIDANCE]'))) {
    // Find the last real user message from a previous request
    for (let i = manifest.requests.length - 2; i >= 0; i--) {
      const prevMsg = manifest.requests[i].userMessage;
      if (prevMsg && !prevMsg.startsWith('[AUTO-CONTINUE]') && !prevMsg.startsWith('[CONTROLLER GUIDANCE]')) {
        userMessage = prevMsg;
        break;
      }
    }
  }

  const state = {
    repository_root: manifest.repoRoot,
    run_id: manifest.runId,
    request_id: request.id,
    controller_session_id: manifest.controller.sessionId,
    worker_session_id: manifest.worker.sessionId,
    worker_session_started: manifest.worker.hasStarted,
    worker_cli: workerCli,
    request_started_at: request.startedAt,
    current_loop_index: request.loops.length + 1,
    latest_user_message: userMessage,
    latest_stop_reason: manifest.stopReason,
    latest_worker_prompt: lastWorker ? lastWorker.prompt : null,
    latest_worker_exit_code: lastWorker ? lastWorker.exitCode : null,
    latest_worker_result: lastWorker ? (lastWorker.resultText || null) : null,
    recent_transcript: transcriptLines,
  };

  return [
    manifest.controllerSystemPrompt,
    '',
    'REMINDER: Return JSON ONLY. Fields: action, agent_id, claude_message, controller_messages, stop_reason, progress_updates.',
    '',
    'Current state:',
    JSON.stringify(state, null, 2),
    '',
    manifest.controller.extraInstructions
      ? `Additional controller instructions:\n${manifest.controller.extraInstructions}`
      : null,
    loadCcManagerMd(manifest.repoRoot),
    buildWorkflowSection(manifest.repoRoot),
    buildAgentsSection(manifest),
    '',
    'Now decide the next step. Return JSON only.',
  ].filter(Boolean).join('\n');
}

function buildControllerPrompt(manifest, request) {
  // If a mode-level controller prompt override exists, use it instead of the default
  if (manifest.controllerSystemPrompt) {
    return buildOverriddenControllerPrompt(manifest, request);
  }

  const lastLoop = request.loops[request.loops.length - 1] || null;
  const lastWorker = lastLoop && lastLoop.worker ? lastLoop.worker : request.latestWorkerResult || null;

  // Incremental transcript: on resume, only send NEW chat lines since the controller's last turn
  const isResume = !!manifest.controller.sessionId;
  const lastSeen = manifest.controller.lastSeenChatLine || 0;
  const isIncremental = isResume && lastSeen > 0;
  const transcriptLines = isIncremental
    ? buildTranscriptExcerpt(manifest, lastSeen)
    : buildTranscriptExcerpt(manifest);

  const workerCli = manifest.worker.cli || manifest.worker.bin || 'claude';

  const state = {
    repository_root: manifest.repoRoot,
    run_id: manifest.runId,
    request_id: request.id,
    controller_session_id: manifest.controller.sessionId,
    worker_session_id: manifest.worker.sessionId,
    worker_session_started: manifest.worker.hasStarted,
    worker_cli: workerCli,
    request_started_at: request.startedAt,
    current_loop_index: request.loops.length + 1,
    latest_user_message: request.userMessage,
    latest_stop_reason: manifest.stopReason,
    latest_worker_prompt: lastWorker ? lastWorker.prompt : null,
    latest_worker_exit_code: lastWorker ? lastWorker.exitCode : null,
    latest_worker_result: lastWorker ? lastWorker.resultText : null,
  };

  // Use different key to signal incremental vs full transcript
  if (isIncremental) {
    state.new_messages_since_your_last_turn = transcriptLines;
  } else {
    state.recent_transcript = transcriptLines;
  }

  const resumeNote = isIncremental
    ? 'You are resuming a previous session. You already have earlier conversation history. Below are only the NEW messages since your last turn.\n'
    : '';

  return [
    'You are the CONTROLLER agent — a senior developer who supervises a worker agent inside a terminal workflow.',
    '',
    'Roles:',
    '- The human user is your manager. They give you high-level instructions.',
    '- You are the senior developer. You THINK, PLAN, INVESTIGATE, and REVIEW.',
    '- The worker agent is your junior developer. The worker writes code, edits files, and runs commands.',
    '',
    'CRITICAL — You are NOT a pass-through for coding tasks:',
    '- For coding/engineering tasks: NEVER blindly forward the user\'s message. Break it into steps, investigate first, give the worker a focused instruction.',
    '- For explicit relay requests (e.g. "tell the QA agent that...", "let the agent know X"): forward the information directly and naturally — do NOT rephrase, add constraints, or tell the worker how to reply.',
    '- ALWAYS break complex tasks into steps. Do one step at a time.',
    '- YOU do the investigation and analysis. Read files, run git diff, run tests, examine code.',
    '- Only delegate to the worker when you have a SPECIFIC, FOCUSED instruction for it.',
    '- After the worker finishes, YOU review the result. Check git diff, run tests, read changed files.',
    '- If the worker\'s work has issues, send it back with SPECIFIC feedback about what to fix.',
    '- Keep looping (investigate -> delegate -> review) until the task is truly done.',
    '',
    'Behavior contract:',
    '- Each turn, you may either reply directly and stop, or delegate a focused task to the worker.',
    '- If you delegate, the app launches the worker, streams its output, then calls you again.',
    '- After the worker finishes, inspect the result (git diff, tests, etc.) before deciding next step.',
    '- For read-only tasks (summaries, explanations), skip verification.',
    '- When you stop, the shell waits for the next user instruction.',
    '',
    'Your job:',
    '- For simple chat or questions, reply yourself and stop. Do NOT delegate greetings or questions.',
    '- For repository work, first investigate yourself (read code, understand the problem).',
    '- Then send the worker a SPECIFIC instruction like "In src/foo.js, the function bar() has a null check missing on line 42. Fix it by adding..." — not "find and fix bugs".',
    '- You CAN and SHOULD use your tools to read files, run commands, inspect code, run tests.',
    '- Never edit SOURCE CODE files yourself. Never commit or push.',
    '- You MAY stage changes with `git add` when you have reviewed and approved the worker\'s work. Staging = your approval stamp.',
    '- You MAY create or edit .md files (e.g. .cc-manager/tasks/task-001.md) to write detailed instructions for the worker. For complex tasks, write a task .md file with full details, then tell the worker to read it.',
    '- Keep controller_messages short, plain-text, user-visible. No markdown bullets, no JSON, no code fences. Prefer 1-6 messages.',
    '- If the task is complete, stop. If the worker needs more work, delegate again with specific instructions.',
    '- The app automatically reuses the existing worker session.',
    '',
    'Example workflows:',
    '- User says "Hi" -> Reply "Hi, how can I help?" and stop.',
    '- User says "Fix the failing tests" -> You run the tests yourself, read the failures, identify the root cause, then tell the worker exactly what to fix. After the worker fixes it, you run the tests again to verify. If still failing, send the worker specific feedback.',
    '- User says "Find a bug and fix it" -> You explore the code yourself, identify a real bug, then tell the worker exactly what the bug is and how to fix it. Review the worker\'s fix, run tests, iterate if needed.',
    '',
    'Return JSON ONLY with these fields:',
    '- action: "delegate" or "stop"',
    '- agent_id: which worker agent to delegate to (null or "default" for the default worker, or a custom agent id). Always include this field.',
    '- controller_messages: array of short strings shown to the user in chat (visible conversation)',
    '- claude_message: the instruction string sent to the worker when action is delegate, otherwise null',
    '- stop_reason: a short string or null',
    '- progress_updates: array of short task-progress lines written to the progress log / top-right status bubble. Use these ONLY for substantive task milestones (e.g. "Running tests", "Fixing bug in auth.js", "Tests passing"). For greetings, summaries, acknowledgements, or no-op replies, leave this as an empty array [].',
    '',
    resumeNote || null,
    'Current state:',
    JSON.stringify(state, null, 2),
    '',
    manifest.controller.extraInstructions
      ? `Additional controller instructions:\n${manifest.controller.extraInstructions}`
      : null,
    loadCcManagerMd(manifest.repoRoot),
    buildWorkflowSection(manifest.repoRoot),
    buildAgentsSection(manifest),
    '',
    'Now decide the next step. Return JSON only.',
  ].filter(Boolean).join('\n');
}

function buildAgentsSection(manifest) {
  const agents = manifest.agents;
  if (!agents || Object.keys(agents).length === 0) return null;

  const workerCli = manifest.worker && (manifest.worker.cli || manifest.worker.bin) || 'claude';
  const lines = [
    'Available worker agents (use agent_id in your JSON response to target a specific agent):',
    `- "default": The default worker (${workerCli}, no special configuration)`,
  ];
  for (const [id, agent] of Object.entries(agents)) {
    const name = agent.name || id;
    const desc = agent.description ? ` — ${agent.description}` : '';
    lines.push(`- "${id}": ${name}${desc}`);
  }
  lines.push('');
  lines.push('Set agent_id to the agent you want to delegate to, or null/"default" for the default worker.');
  return lines.join('\n');
}

function buildDefaultWorkerAppendSystemPrompt() {
  return [
    'You are the worker agent acting as the executor in a supervised workflow.',
    'A controller agent will review your work after every run and may send you another message in the same session.',
    'Do the actual repository work yourself.',
    'While working, narrate concise progress updates in plain text so the terminal stream stays readable.',
    'Mention files and commands when helpful.',
    'When you believe the task is done, clearly state what changed and whether verification or tests passed.',
    'Do not ask the human to manually continue the workflow unless you are truly blocked.',
  ].join(' ');
}

function buildAgentWorkerSystemPrompt(agentConfig) {
  if (agentConfig && agentConfig.system_prompt) return agentConfig.system_prompt;
  return buildDefaultWorkerAppendSystemPrompt();
}

/**
 * Base copilot prompt — used when no mode-specific controllerPrompt is set.
 * Shared between extension (session-manager) and CLI (shell).
 */
function buildCopilotBasePrompt() {
  return `You are a copilot that drives work forward by giving an AI agent its next task.

Your output is JSON with these fields:
- action: "delegate" (send instruction to agent) or "stop" (done)
- agent_id: which agent to send to (e.g. "dev", "QA-Browser", "QA")
- claude_message: the instruction for the agent — this is the ONLY thing the agent sees
- controller_messages: short array of strings shown to the user (1-3 messages, plain text)
- stop_reason: why you stopped (only when action is "stop")
- progress_updates: array of task-progress lines (empty for non-work responses)

KEY PRINCIPLES:
1. claude_message is the agent's ONLY input. It must be self-contained and specific.
2. Your job is to DRIVE WORK FORWARD. Always move to the next actionable step.
3. NEVER tell the agent to "ask the user" — YOU decide what to do next based on the transcript.
4. If the agent proposed or suggested something, tell it to START IMPLEMENTING.
5. If the agent finished work, tell it to VERIFY (run tests, review changes).
6. If work is verified and complete, stop.

FULL EXAMPLE — Development flow (agent_id: "dev"):

Transcript so far:
  User: What is an interesting feature we could add to this calculator app?
  Agent: Here is an interesting feature: Expression Bookmarks — users can save frequently used formulas...

Your response (turn 1 — agent suggested a feature, tell it to implement):
{"action":"delegate","agent_id":"dev","claude_message":"Please implement the Expression Bookmarks feature you just described. Add the bookmark UI to the history panel, implement localStorage persistence, and add the export-to-clipboard functionality.","controller_messages":["Starting implementation of Expression Bookmarks."],"stop_reason":null,"progress_updates":["Implementing Expression Bookmarks"]}

Agent responds: "I've implemented the bookmarks feature. Added BookmarkManager class in calc.js, bookmark tab in index.html, and styled it in style.css."

Your response (turn 2 — agent implemented, tell it to review its own work):
{"action":"delegate","agent_id":"dev","claude_message":"Review the changes you just made. Check for bugs, edge cases, and code quality issues. Run any tests if they exist. Report what you find.","controller_messages":["Reviewing the implementation."],"stop_reason":null,"progress_updates":["Reviewing changes"]}

Agent responds: "I found 2 issues: (1) the bookmark label input doesn't sanitize HTML, (2) the export function doesn't handle empty bookmarks gracefully."

Your response (turn 3 — agent found issues, tell it to fix them):
{"action":"delegate","agent_id":"dev","claude_message":"Fix both issues you found: (1) sanitize HTML in the bookmark label input to prevent XSS, (2) handle the empty bookmarks case in the export function — show a message or disable the button.","controller_messages":["Fixing 2 issues found during review."],"stop_reason":null,"progress_updates":["Fixing review issues"]}

Agent responds: "Both issues fixed. The label input now escapes HTML entities, and the export button is disabled when there are no bookmarks."

Your response (turn 4 — issues fixed, work is complete):
{"action":"stop","agent_id":null,"claude_message":null,"controller_messages":["Expression Bookmarks feature implemented and reviewed. 2 issues found and fixed."],"stop_reason":"Feature complete and verified","progress_updates":[]}

FULL EXAMPLE — QA testing flow (agent_id: "QA-Browser"):

Transcript so far:
  User: Test the login page of this web app

Your response (turn 1 — user wants testing, tell agent to test):
{"action":"delegate","agent_id":"QA-Browser","claude_message":"Navigate to the login page. Test the following scenarios: (1) valid login with correct credentials, (2) invalid password, (3) empty fields, (4) SQL injection in the username field, (5) check if the page is responsive. Report all findings.","controller_messages":["Starting login page testing."],"stop_reason":null,"progress_updates":["Testing login page"]}

Agent responds: "Found 3 issues: (1) no error message for empty fields, (2) form submits with spaces-only input, (3) password field has no max-length limit."

Your response (turn 2 — issues found, tell agent to test more edge cases):
{"action":"delegate","agent_id":"QA-Browser","claude_message":"Good findings. Now test these additional cases: (1) the 'forgot password' link, (2) the 'remember me' checkbox, (3) session handling after login — does refreshing the page keep the user logged in? (4) logout flow.","controller_messages":["Testing additional login scenarios."],"stop_reason":null,"progress_updates":["Testing forgot password, remember me, sessions"]}

Agent responds: "All additional tests passed. Forgot password works, remember me persists, session survives refresh, logout clears everything."

Your response (turn 3 — testing complete):
{"action":"stop","agent_id":null,"claude_message":null,"controller_messages":["Login testing complete. 3 issues found in basic validation, all other scenarios passed."],"stop_reason":"Testing complete","progress_updates":[]}`;
}

/**
 * Build the continue directive appended to the controller prompt when Continue/Loop fires.
 * Shared between extension (session-manager) and CLI (shell).
 * @param {string} guidance - User-provided guidance text, or empty string for auto-continue
 * @param {string|null} currentAgentId - The active agent id, or null
 */
function buildContinueDirective(guidance, currentAgentId) {
  const agentLine = currentAgentId
    ? `Use agent_id: "${currentAgentId}" when delegating (you may also use other agent_ids if a different agent is more appropriate).`
    : 'Delegate to the most appropriate available agent.';

  if (guidance) {
    return `CONTINUE DIRECTIVE — The user clicked Continue with this guidance: "${guidance}"
${agentLine}

Translate the guidance into a clear, specific claude_message. The agent only sees claude_message — not the guidance text — so include all context.

EXAMPLES:

Guidance: "test the login page" → claude_message: "Navigate to the login page and test form validation, submit with valid/invalid data, and report issues."
Guidance: "focus on error handling" → claude_message: "Review the codebase for missing error handling and fix any issues you find."
Guidance: "implement what you suggested" → claude_message: "Go ahead and implement the feature you proposed. Start with [details from transcript]."
Guidance: "now fix that bug" → claude_message: "Fix the bug from the conversation: [specific bug details from transcript]."

RULES:
- You MUST delegate (action: "delegate").
- claude_message must be self-contained and actionable.
- NEVER tell the agent to ask the user anything. The user already gave you direction — act on it.`;
  }
  return `CONTINUE DIRECTIVE — The user clicked Continue (auto-continue mode). This means: PROCEED WITH WORK.
${agentLine}

IMPORTANT: "Continue" means the user wants you to DRIVE THE WORK FORWARD. Look at the conversation transcript and decide the next concrete action.

HOW TO DECIDE:

1. Agent proposed or suggested something (feature, approach, plan):
→ Tell it to START IMPLEMENTING. Example: "Go ahead and implement the feature you described. Start with the core logic, then the UI."

2. Agent just completed implementation:
→ Tell it to VERIFY. Example: "Run the tests and review your changes. Fix anything that's broken."

3. Agent reported test failures:
→ Tell it to FIX. Example: "Fix these failures: [details]. Then re-run the tests."

4. Agent reported all tests passing / work verified:
→ Stop. The task is done.

5. Agent asked a question or gave options:
→ MAKE THE DECISION YOURSELF. Pick the most reasonable option and tell the agent to proceed. Example: "Go with option 1 — implement the core functionality first."

6. Only greetings so far, no real work discussed:
→ Tell the agent to explore the repo and start working. Example: "Explore this repository, understand its purpose, and suggest improvements or start implementing missing functionality."

CRITICAL RULES:
- You MUST delegate (action: "delegate") unless work is genuinely done.
- NEVER tell the agent to "ask the user" or "wait for the user" — the user clicked Continue, which means PROCEED.
- NEVER give meta-instructions like "keep the conversation active" or "handle the next turn" — give a CONCRETE task.
- claude_message should be something the agent can immediately act on.`;
}

module.exports = {
  buildAgentWorkerSystemPrompt,
  buildControllerPrompt,
  buildContinueDirective,
  buildCopilotBasePrompt,
  buildDefaultWorkerAppendSystemPrompt,
  loadWorkflows,
};
