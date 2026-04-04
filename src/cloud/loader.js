const CLOUD_PACKAGE_SPECIFIERS = Object.freeze({
  contracts: '@qapanda/contracts',
  runProtocol: '@qapanda/run-protocol',
  cloudSdk: '@qapanda/cloud-sdk',
  security: '@qapanda/security',
  syncCore: '@qapanda/sync-core',
  clientCloud: '@qapanda/client-cloud',
  ui: '@qapanda/ui',
});

const packagePromiseCache = new Map();

function listCloudPackageSpecifiers() {
  return Object.values(CLOUD_PACKAGE_SPECIFIERS);
}

async function loadCloudPackage(specifier) {
  if (!specifier) throw new Error('A cloud package specifier is required.');
  if (!packagePromiseCache.has(specifier)) {
    packagePromiseCache.set(specifier, import(specifier));
  }
  return packagePromiseCache.get(specifier);
}

async function loadCloudPackages() {
  const entries = await Promise.all(
    Object.entries(CLOUD_PACKAGE_SPECIFIERS).map(async ([key, specifier]) => {
      const mod = await loadCloudPackage(specifier);
      return [key, mod];
    })
  );
  return Object.fromEntries(entries);
}

module.exports = {
  CLOUD_PACKAGE_SPECIFIERS,
  listCloudPackageSpecifiers,
  loadCloudPackage,
  loadCloudPackages,
};
