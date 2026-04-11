#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const EXTENSION_IDS = [
  'qapandaapp.qapanda-vscode',
  'qapanda.qapanda-vscode',
  'cc-manager.cc-manager-vscode',
];

const LEGACY_DIR_PREFIXES = [
  'qapandaapp.qapanda-vscode-',
  'qapanda.qapanda-vscode-',
  'cc-manager.cc-manager-vscode-',
];

const dryRun = process.argv.includes('--dry-run');
const repoRoot = path.resolve(__dirname, '..');
const vsixPath = path.join(repoRoot, 'extension', 'qapanda.vsix');
const extensionsRoot = path.join(os.homedir(), '.vscode', 'extensions');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension', 'package.json'), 'utf8'));
const expectedInstalledId = `${packageJson.publisher}.${packageJson.name}@${packageJson.version}`;
const expectedDirName = `${packageJson.publisher}.${packageJson.name}-${packageJson.version}`;
const codeCliPath = resolveCodeCli();

function log(message) {
  process.stdout.write(`${message}\n`);
}

function quoteArg(value) {
  const str = String(value);
  if (!/[ \t"]/u.test(str)) return str;
  return `"${str.replace(/"/g, '\\"')}"`;
}

function quoteCmdArg(value) {
  const str = String(value);
  if (!/[ \t"]/u.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveCodeCli() {
  const envCandidates = [
    process.env.QAPANDA_CODE_CLI,
    process.env.CODE_CLI_PATH,
  ].filter(Boolean);

  const windowsCandidates = process.platform === 'win32'
    ? [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd') : null,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd') : null,
        process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin', 'code.cmd') : null,
      ].filter(Boolean)
    : ['code'];

  for (const candidate of [...envCandidates, ...windowsCandidates]) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (process.platform === 'win32') {
    const whereResult = cp.spawnSync('where.exe', ['code.cmd'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const match = String(whereResult.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (match) return match;
  }

  return process.platform === 'win32' ? 'code.cmd' : 'code';
}

function runCode(args, { allowFailure = false } = {}) {
  const commandText = `${quoteArg(codeCliPath)} ${args.map(quoteArg).join(' ')}`;
  if (dryRun) {
    log(`[dry-run] ${commandText}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const result = process.platform === 'win32'
    ? cp.spawnSync(`${quoteCmdArg(codeCliPath)} ${args.map(quoteCmdArg).join(' ')}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        shell: true,
        timeout: 30000,
      })
    : cp.spawnSync(codeCliPath, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: 'pipe',
        shell: false,
        timeout: 30000,
      });
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      const isInstallCommand = args.includes('--install-extension');
      if (isInstallCommand) {
        const currentDir = path.join(extensionsRoot, expectedDirName);
        if (fs.existsSync(currentDir) && isVsCodeRunning()) {
          throw new Error(
            `Timed out waiting for VS Code CLI to finish: ${commandText}\n` +
            `Current extension directory still present: ${currentDir}\n` +
            'VS Code appears to still be holding the installed extension open. Close VS Code and rerun the install.'
          );
        }
      }
      throw new Error(`Timed out waiting for VS Code CLI to finish: ${commandText}`);
    }
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error((result.stderr || result.stdout || `Command failed: ${commandText}`).trim());
  }
  if (result.stdout && result.stdout.trim()) log(result.stdout.trim());
  if (result.stderr && result.stderr.trim()) log(result.stderr.trim());
  return result;
}

function isVsCodeRunning() {
  if (process.platform === 'win32') {
    const result = cp.spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Code.exe', '/FO', 'CSV', '/NH'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const output = String(result.stdout || '').trim();
    return !!output && !output.includes('No tasks are running');
  }
  const result = cp.spawnSync('ps', ['-A', '-o', 'comm='], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => /(^|\/)(code|code-insiders)$/i.test(line));
}

function removeStaleExtensionDirs() {
  if (!fs.existsSync(extensionsRoot)) {
    log(`Extensions root not found: ${extensionsRoot}`);
    return;
  }
  const entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!LEGACY_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (entry.name === expectedDirName) {
      log(`Keeping current extension directory ${entry.name}`);
      continue;
    }
    const fullPath = path.join(extensionsRoot, entry.name);
    if (dryRun) {
      log(`[dry-run] remove ${fullPath}`);
      continue;
    }
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      log(`Removed stale extension directory ${entry.name}`);
    } catch (error) {
      if (error && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        log(`Skipped locked extension directory ${entry.name} (${error.code})`);
        continue;
      }
      throw error;
    }
  }
}

function verifyInstall() {
  if (dryRun) {
    log('Dry run completed.');
    return;
  }
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = runCode(['--list-extensions', '--show-versions'], { allowFailure: false });
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const installed = lines.find((line) => line === expectedInstalledId);
    if (installed) {
      log(`Verified installed extension: ${installed}`);
      return;
    }
    if (attempt < maxAttempts) {
      log(`Install not visible yet (attempt ${attempt}/${maxAttempts}). Retrying...`);
      sleep(1000);
    }
  }
  throw new Error(`Expected ${expectedInstalledId} after install, but it was not reported by ${quoteArg(codeCliPath)} --list-extensions --show-versions`);
}

function main() {
  if (!fs.existsSync(vsixPath)) {
    throw new Error(`VSIX not found: ${vsixPath}`);
  }

  log(`Using VSIX: ${vsixPath}`);
  log(`Using VS Code CLI: ${codeCliPath}`);
  for (const id of EXTENSION_IDS) {
    runCode(['--uninstall-extension', id], { allowFailure: true });
  }
  removeStaleExtensionDirs();
  runCode(['--install-extension', vsixPath, '--force'], { allowFailure: false });
  verifyInstall();
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}
