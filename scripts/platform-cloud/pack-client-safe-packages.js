const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  isWindows,
  repoRoot,
  platformRoot,
  tarballRoot,
  manifestPath,
  getClientSafePackages,
  sortPackagesForPacking,
} = require('./shared.js');

const corepackCommand = isWindows ? 'corepack.cmd' : 'corepack';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
    shell: isWindows,
    ...options,
  });
  if (result.error) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw result.error;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
  return result.stdout.trim();
}

const packages = sortPackagesForPacking(getClientSafePackages());
const packageMap = new Map(packages.map((pkg) => [pkg.name, pkg]));
if (packages.length === 0) {
  throw new Error('No client-safe platform packages were found.');
}

fs.rmSync(tarballRoot, { recursive: true, force: true });
fs.mkdirSync(tarballRoot, { recursive: true });

console.log('Building platform workspaces before packing client-safe packages...');
run(corepackCommand, ['pnpm', '--dir', platformRoot, 'build:workspaces']);

const manifest = {
  generatedAt: new Date().toISOString(),
  platformRoot,
  tarballRoot,
  packages: [],
};

for (const pkg of packages) {
  const stagingDir = path.join(tarballRoot, 'staging', pkg.name.replace('/', '__'));
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagingDir), { recursive: true });
  fs.cpSync(pkg.directory, stagingDir, { recursive: true });

  const stagingPackageJsonPath = path.join(stagingDir, 'package.json');
  const stagingPackageJson = JSON.parse(fs.readFileSync(stagingPackageJsonPath, 'utf8'));
  for (const dependencyField of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!stagingPackageJson[dependencyField]) continue;
    for (const [dependencyName, dependencyVersion] of Object.entries(stagingPackageJson[dependencyField])) {
      if (dependencyVersion !== 'workspace:*') continue;
      const dependencyPkg = packageMap.get(dependencyName);
      if (!dependencyPkg) continue;
      stagingPackageJson[dependencyField][dependencyName] = dependencyPkg.version;
    }
  }
  fs.writeFileSync(stagingPackageJsonPath, `${JSON.stringify(stagingPackageJson, null, 2)}\n`, 'utf8');

  console.log(`Packing ${pkg.name} from ${path.relative(repoRoot, pkg.directory)}...`);
  const stdout = run(
    npmCommand,
    ['pack', '--json', '--pack-destination', tarballRoot],
    { cwd: stagingDir },
  );
  const packed = JSON.parse(stdout);
  const tarballFile = packed[0]?.filename;
  if (!tarballFile) {
    throw new Error(`npm pack did not return a tarball filename for ${pkg.name}`);
  }
  manifest.packages.push({
    name: pkg.name,
    version: pkg.version,
    directory: path.relative(repoRoot, pkg.directory),
    tarballFile,
    tarballPath: path.relative(repoRoot, path.join(tarballRoot, tarballFile)).replace(/\\/g, '/'),
  });
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote client-safe package manifest to ${path.relative(repoRoot, manifestPath)}`);
