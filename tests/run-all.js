#!/usr/bin/env node
/**
 * Run all tests, output details to tests/last-run.log, print summary to terminal.
 * Runs cleanup after tests complete.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const logFile = path.join(__dirname, 'last-run.log');

// Run tests
console.log('Running all tests...\n');
let testExitCode = 0;
try {
  execSync('node --test tests/unit/*.test.js tests/crud/*.test.js tests/ui/*.test.js tests/live/*.test.js', {
    cwd: path.join(__dirname, '..'),
    stdio: ['inherit', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
    timeout: 600000,
  });
} catch (e) {
  testExitCode = e.status || 1;
}

// Print summary
const log = fs.readFileSync(logFile, 'utf8');
const tests = (log.match(/ℹ tests (\d+)/) || [])[1] || '?';
const pass = (log.match(/ℹ pass (\d+)/) || [])[1] || '?';
const fail = (log.match(/ℹ fail (\d+)/) || [])[1] || '?';

if (fail === '0') {
  console.log(`\x1b[32mTests: ${tests} | Pass: ${pass} | Fail: ${fail}\x1b[0m`);
} else {
  console.log(`\x1b[31mTests: ${tests} | Pass: ${pass} | Fail: ${fail}\x1b[0m`);
  console.log('\nFailing tests:');
  log.split('\n')
    .filter(l => l.includes('✖') && !l.includes('failing tests'))
    .forEach(l => console.log('  ' + l.trim()));
}

console.log(`\nDetails: tests/last-run.log`);

// Cleanup
console.log('');
try {
  require('./cleanup');
} catch (e) {
  console.error('Cleanup error:', e.message);
}

process.exit(testExitCode);
