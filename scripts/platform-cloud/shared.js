const fs = require('node:fs');
const path = require('node:path');
const isWindows = process.platform === 'win32';

const repoRoot = path.resolve(__dirname, '..', '..');
const platformRoot = path.join(repoRoot, 'propanda', 'qapanda-platform');
const platformPackagesRoot = path.join(platformRoot, 'packages');
const tarballRoot = path.join(repoRoot, '.qpanda', 'platform-client-safe');
const manifestPath = path.join(tarballRoot, 'manifest.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getClientSafePackages() {
  return fs
    .readdirSync(platformPackagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(platformPackagesRoot, entry.name);
      const packageJsonPath = path.join(directory, 'package.json');
      if (!fs.existsSync(packageJsonPath)) return null;
      const packageJson = readJson(packageJsonPath);
      if (!packageJson?.qapanda?.clientSafe) return null;
      return {
        name: packageJson.name,
        version: packageJson.version,
        directory,
        packageJsonPath,
        dependencies: Object.keys(packageJson.dependencies || {}),
      };
    })
    .filter(Boolean);
}

function sortPackagesForPacking(packages) {
  const packageMap = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const seen = new Set();
  const order = [];

  function visit(pkg) {
    if (seen.has(pkg.name)) return;
    seen.add(pkg.name);
    for (const dependency of pkg.dependencies) {
      const dependencyPkg = packageMap.get(dependency);
      if (dependencyPkg) visit(dependencyPkg);
    }
    order.push(pkg);
  }

  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    visit(pkg);
  }

  return order;
}

module.exports = {
  isWindows,
  repoRoot,
  platformRoot,
  platformPackagesRoot,
  tarballRoot,
  manifestPath,
  readJson,
  getClientSafePackages,
  sortPackagesForPacking,
};
