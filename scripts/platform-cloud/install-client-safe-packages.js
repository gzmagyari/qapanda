const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isWindows, repoRoot, manifestPath, readJson } = require('./shared.js');
const npmCommand = isWindows ? 'npm.cmd' : 'npm';

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Missing manifest at ${manifestPath}. Run "npm run platform:cloud:pack" first.`);
}

const manifest = readJson(manifestPath);
const tarballPaths = manifest.packages.map((pkg) => path.join(repoRoot, pkg.tarballPath));

for (const tarballPath of tarballPaths) {
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Missing tarball at ${tarballPath}. Re-run "npm run platform:cloud:pack".`);
  }
}

const result = spawnSync(npmCommand, ['install', '--save-exact', ...tarballPaths], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['inherit', 'pipe', 'pipe'],
  maxBuffer: 20 * 1024 * 1024,
  shell: isWindows,
});

process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  throw new Error('npm install failed for platform client-safe tarballs.');
}

console.log('Installed platform client-safe tarballs into the QA Panda repo.');
