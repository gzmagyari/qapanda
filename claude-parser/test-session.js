/**
 * Test: ClaudeSession API — sends 3 prompts (simple, create file, read file)
 * and logs all streamed events + final results.
 */

'use strict';

const { ClaudeSession } = require('./index');
const fs = require('fs');
const path = require('path');
const os = require('os');

const outFile = path.join(os.homedir(), 'Desktop', 'claude-session-test.log');
fs.writeFileSync(outFile, '');

const log = (label, data) => {
  const entry = `[${new Date().toISOString()}] [${label}] ${data}\n`;
  process.stdout.write(entry);
  fs.appendFileSync(outFile, entry);
};

async function main() {
  const repoRoot = path.resolve(__dirname, '..');

  log('START', `Creating ClaudeSession (cwd: ${repoRoot})`);

  const session = new ClaudeSession({
    cwd: repoRoot,
    startupTimeout: 30000,
    turnTimeout: 60000,
  });

  const onEvent = (event) => {
    log('EVENT', JSON.stringify(event));
  };

  try {
    // --- Turn 1: Simple question ---
    log('TURN_1', 'Sending simple math question');
    const r1 = await session.send('What is 2+2? Just the number.', { onEvent });
    log('RESULT_1', JSON.stringify({ resultText: r1.resultText, sessionId: r1.sessionId, hadTextDelta: r1.hadTextDelta }));

    // --- Turn 2: Create a file (tool use) ---
    log('TURN_2', 'Sending file creation request');
    const r2 = await session.send('Create a file called claude-parser/session-test.txt with exactly the text "session test ok"', { onEvent });
    log('RESULT_2', JSON.stringify({ resultText: r2.resultText, sessionId: r2.sessionId }));

    // Verify the file was created
    const testFile = path.join(__dirname, 'session-test.txt');
    const exists = fs.existsSync(testFile);
    log('VERIFY', `session-test.txt exists: ${exists}`);
    if (exists) {
      log('VERIFY', `contents: ${JSON.stringify(fs.readFileSync(testFile, 'utf8'))}`);
    }

    // --- Turn 3: Read the file ---
    log('TURN_3', 'Sending file read request');
    const r3 = await session.send('Read claude-parser/session-test.txt and tell me its contents', { onEvent });
    log('RESULT_3', JSON.stringify({ resultText: r3.resultText, sessionId: r3.sessionId }));

    log('DONE', 'All turns complete');
  } catch (err) {
    log('ERROR', err.message);
  } finally {
    session.close();
    // Wait for clean exit
    setTimeout(() => process.exit(0), 3000);
  }
}

main();
