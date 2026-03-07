#!/usr/bin/env node

const fs = require('node:fs');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function getFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

function decide(prompt) {
  const latestUserMatch = prompt.match(/"latest_user_message":\s*"([^"]*)"/);
  const latestUser = latestUserMatch ? latestUserMatch[1] : '';
  const latestClaudeResultMatch = prompt.match(/"latest_claude_result":\s*(null|"([\s\S]*?)")/);
  const latestClaudeResult = latestClaudeResultMatch && latestClaudeResultMatch[2] ? latestClaudeResultMatch[2] : '';

  if (/"latest_user_message":\s*"Hi"/.test(prompt)) {
    return {
      action: 'stop',
      controller_messages: ['Hi, how can I help you?'],
      claude_message: null,
      stop_reason: 'Handled greeting.',
    };
  }

  if (/Good job\. Thank you/.test(prompt)) {
    return {
      action: 'stop',
      controller_messages: ['No worries. Let me know if you want me to do anything else.'],
      claude_message: null,
      stop_reason: 'Acknowledged user.',
    };
  }

  if (latestClaudeResult.includes('All unit tests passing. All issues fixed')) {
    return {
      action: 'delegate',
      controller_messages: [
        'Let me review the work that was done.',
        'Checking the git diff.',
        'Opening logic.py.',
        'I found a critical bug that was introduced with the change. Let me tell Claude Code.',
      ],
      claude_message: 'The changes in logic.py introduced a critical bug. Please fix it and rerun the unit tests.',
      stop_reason: null,
    };
  }

  if (latestClaudeResult.includes('The issue has been fixed and all unit tests still passing')) {
    return {
      action: 'stop',
      controller_messages: [
        'Checking the fix.',
        'Opening logic.py.',
        'Confirmed the fix to be correct. Checking unit tests.',
        'All unit tests passing. The task has been completed. Waiting for next user instruction.',
      ],
      claude_message: null,
      stop_reason: 'Task complete.',
    };
  }

  if (/Please do fixes in this repository until all unit tests pass/.test(prompt)) {
    return {
      action: 'delegate',
      controller_messages: ['I will instruct Claude Code to fix the issues.'],
      claude_message: 'Please fix all issues in this repository such that all unit tests pass.',
      stop_reason: null,
    };
  }

  return {
    action: 'stop',
    controller_messages: [latestUser ? `Understood: ${latestUser}` : 'Got it.'],
    claude_message: null,
    stop_reason: 'No further action.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write('fake-codex 0.0.1\n');
    return;
  }

  if (args[0] !== 'exec') {
    process.stderr.write(`Unexpected command: ${args.join(' ')}\n`);
    process.exit(2);
    return;
  }

  const isResume = args[1] === 'resume';
  const providedSessionId = isResume ? args[2] : null;
  const sessionId = providedSessionId || 'fake-codex-session-0001';
  const outputFile = getFlagValue(args, '--output-last-message');
  if (!outputFile) {
    process.stderr.write('Missing --output-last-message\n');
    process.exit(2);
    return;
  }

  const prompt = await readStdin();
  const decision = decide(prompt);

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: sessionId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);
  if (decision.action === 'delegate' && !providedSessionId) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.started',
      item: { id: 'item-1', type: 'command_execution', command: 'git status --short', status: 'in_progress' },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'command_execution', command: 'git status --short', status: 'completed' },
    })}\n`);
  }
  if (providedSessionId) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.started',
      item: { id: 'item-2', type: 'command_execution', command: 'git diff --stat', status: 'in_progress' },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-2', type: 'command_execution', command: 'git diff --stat', status: 'completed' },
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  fs.writeFileSync(outputFile, JSON.stringify(decision, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
