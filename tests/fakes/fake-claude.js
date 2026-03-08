#!/usr/bin/env node

function getFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function emitText(text) {
  for (const part of text.split(/(?<=\n)/)) {
    if (!part) continue;
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: part },
      },
    });
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    // If stdin is already ended or not piped, resolve quickly
    if (process.stdin.readableEnded) resolve('');
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write('fake-claude 0.0.1\n');
    return;
  }

  // Known flags that take a value (the next arg belongs to the flag, not a positional prompt).
  const valuedFlags = new Set([
    '--output-format', '--model', '--session-id', '--resume',
    '--allowedTools', '--tools', '--disallowedTools',
    '--permission-prompt-tool', '--max-turns', '--max-budget-usd',
    '--add-dir', '--append-system-prompt',
  ]);

  // Find the positional prompt: last arg that isn't a flag or a flag's value.
  let prompt = null;
  const sessionId = getFlagValue(args, '--resume') || getFlagValue(args, '--session-id') || 'fake-claude-session-0001';

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (valuedFlags.has(args[i]) && i + 1 < args.length) {
        i++; // skip the value
      }
      continue;
    }
    // This arg doesn't start with - and isn't consumed by a flag — it's the prompt.
    prompt = args[i];
  }

  if (!prompt) {
    prompt = (await readStdin()).trim();
  }

  if (!prompt) {
    process.stderr.write('Missing prompt (expected as last positional argument or via stdin)\n');
    process.exit(2);
    return;
  }

  emit({ type: 'system', session_id: sessionId });

  if (prompt.includes('Please fix all issues in this repository')) {
    emitText('I will start fixing the issues.\n');
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'npm test --silent' },
        },
      },
      session_id: sessionId,
    });
    emitText('Opening logic.py.\nFound issue in logic.py. Fixing.\nTesting unit tests.\nAll unit tests passing. All issues fixed.\n');
    emit({
      type: 'result_message',
      session_id: sessionId,
      result: 'All unit tests passing. All issues fixed.',
    });
    return;
  }

  if (prompt.includes('introduced a critical bug')) {
    emitText('Let me review my changes.\nOpening logic.py.\nFound critical bug. Fixing.\nFixed the critical bug. Checking unit tests again.\nThe issue has been fixed and all unit tests still passing.\n');
    emit({
      type: 'result_message',
      session_id: sessionId,
      result: 'The issue has been fixed and all unit tests still passing.',
    });
    return;
  }

  emitText('Okay.\n');
  emit({ type: 'result_message', session_id: sessionId, result: 'Okay.' });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
