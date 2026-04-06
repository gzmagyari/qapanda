function failUnavailable(reason) {
  throw new Error(reason || 'Cloud workflow secret storage is not available in this environment.');
}

function normalizeSecretProvider(provider) {
  if (!provider) return null;
  if (typeof provider.storeSecret === 'function' && typeof provider.resolveSecret === 'function') {
    return provider;
  }
  if (provider.workflowSecrets) {
    return normalizeSecretProvider(provider.workflowSecrets);
  }
  if (provider.secrets) {
    return normalizeSecretProvider(provider.secrets);
  }
  return null;
}

function normalizeStoredSecretId(result) {
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (result && typeof result === 'object') {
    if (typeof result.secretId === 'string' && result.secretId.trim()) return result.secretId.trim();
    if (typeof result.id === 'string' && result.id.trim()) return result.id.trim();
  }
  return null;
}

function createUnavailableWorkflowSecretStore(reason) {
  const message = reason || 'Cloud workflow secret storage is not available in this environment.';
  return {
    available: false,
    reason: message,
    isAvailable() {
      return false;
    },
    async storeSecret() {
      failUnavailable(message);
    },
    async resolveSecret() {
      failUnavailable(message);
    },
    async deleteSecret() {
      failUnavailable(message);
    },
  };
}

function createCloudWorkflowSecretStore(options = {}) {
  const provider = normalizeSecretProvider(options.provider);
  if (!provider) {
    return createUnavailableWorkflowSecretStore(options.reason);
  }
  return {
    available: true,
    reason: null,
    isAvailable() {
      return true;
    },
    async storeSecret(value, metadata = {}) {
      const result = await provider.storeSecret(String(value == null ? '' : value), metadata);
      const secretId = normalizeStoredSecretId(result);
      if (!secretId) {
        throw new Error('Cloud workflow secret storage did not return a valid secret id.');
      }
      return { secretId };
    },
    async resolveSecret(secretId, metadata = {}) {
      const normalizedSecretId = String(secretId || '').trim();
      if (!normalizedSecretId) {
        throw new Error('A secret id is required to resolve a workflow secret.');
      }
      const value = await provider.resolveSecret(normalizedSecretId, metadata);
      if (typeof value !== 'string' || !value) {
        throw new Error(`Workflow secret "${normalizedSecretId}" could not be resolved.`);
      }
      return value;
    },
    async deleteSecret(secretId, metadata = {}) {
      const normalizedSecretId = String(secretId || '').trim();
      if (!normalizedSecretId) return;
      if (typeof provider.deleteSecret === 'function') {
        await provider.deleteSecret(normalizedSecretId, metadata);
      }
    },
  };
}

module.exports = {
  createCloudWorkflowSecretStore,
  createUnavailableWorkflowSecretStore,
};
