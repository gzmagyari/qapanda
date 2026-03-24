#!/usr/bin/env node
/**
 * Test cleanup — stops leftover Docker containers and Chrome processes
 * created by tests. Run after test suite or on demand.
 *
 * Usage: node tests/cleanup.js
 */
const { execSync } = require('node:child_process');

function run(cmd, label) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim();
    return out;
  } catch {
    return '';
  }
}

// ── Docker containers ────────────────────────────────────────────
console.log('Cleaning up test Docker containers...');
const containers = run('docker ps -a --filter "label=qa-desktop-instance" --format "{{.Names}}"');
if (containers) {
  const testContainers = containers.split('\n').filter(n => n.includes('cc-test') || n.includes('test-'));
  if (testContainers.length > 0) {
    for (const name of testContainers) {
      console.log(`  Stopping: ${name}`);
      run(`docker stop "${name}"`, 'stop');
      run(`docker rm "${name}"`, 'rm');
    }
    console.log(`  Removed ${testContainers.length} test container(s).`);
  } else {
    console.log('  No test containers found.');
  }
} else {
  console.log('  No qa-desktop containers found.');
}

// ── Docker volumes ───────────────────────────────────────────────
const volumes = run('docker volume ls --format "{{.Name}}"');
if (volumes) {
  const testVolumes = volumes.split('\n').filter(v => v.startsWith('qa-workspace-cc-test') || v.startsWith('qa-workspace-test-'));
  if (testVolumes.length > 0) {
    for (const vol of testVolumes) {
      console.log(`  Removing volume: ${vol}`);
      run(`docker volume rm "${vol}"`, 'vol-rm');
    }
    console.log(`  Removed ${testVolumes.length} test volume(s).`);
  }
}

// ── Chrome processes ─────────────────────────────────────────────
// Only kill Chrome instances started by our tests (user-data-dir contains "cc-chrome-test")
// We can't reliably distinguish test Chrome from user Chrome on Windows,
// so we just report if Chrome is running. The chrome-manager's killChrome
// handles per-panel cleanup — leftover processes are from crashed tests.
console.log('Chrome cleanup:');
try {
  const chromeManager = require('../extension/chrome-manager');
  chromeManager.killAll();
  console.log('  Killed all managed Chrome instances.');
} catch {
  console.log('  chrome-manager not available — skip Chrome cleanup.');
}

console.log('Cleanup done.');
