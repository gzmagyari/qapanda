/**
 * Helper to spawn qapanda CLI as a child process for end-to-end testing.
 */
const { execFile } = require('node:child_process');
const path = require('node:path');

const BIN = path.resolve(__dirname, '../../bin/qapanda.js');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Run qapanda with arguments and return { code, stdout, stderr }.
 *
 * @param {string[]} args - CLI arguments (e.g., ['doctor'] or ['run', '--mode', 'dev', 'hello'])
 * @param {object} [options]
 * @param {string} [options.stdin] - Text to pipe to stdin
 * @param {number} [options.timeout] - Timeout in ms (default 60s)
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCcManager(args, options = {}) {
  const { stdin, timeout = 60000, cwd = PROJECT_ROOT } = options;

  return new Promise((resolve) => {
    const child = execFile('node', [BIN, ...args], {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code || err.status || 1) : 0,
        stdout: (stdout || '').toString(),
        stderr: (stderr || '').toString(),
      });
    });

    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

/**
 * Run qapanda shell with piped commands.
 * Automatically appends /quit if not present.
 */
function runShell(commands, options = {}) {
  let input = Array.isArray(commands) ? commands.join('\n') : commands;
  if (!input.includes('/quit') && !input.includes('/exit')) {
    input += '\n/quit';
  }
  return runCcManager(['shell'], { ...options, stdin: input + '\n', timeout: options.timeout || 15000 });
}

/**
 * Strip ANSI escape codes from terminal output.
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

module.exports = { runCcManager, runShell, stripAnsi, BIN, PROJECT_ROOT };
