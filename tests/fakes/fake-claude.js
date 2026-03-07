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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write('fake-claude 0.0.1\n');
    return;
  }

  const prompt = getFlagValue(args, '-p');
  const sessionId = getFlagValue(args, '--resume') || getFlagValue(args, '--session-id') || 'fake-claude-session-0001';

  if (!prompt) {
    process.stderr.write('Missing -p prompt\n');
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
