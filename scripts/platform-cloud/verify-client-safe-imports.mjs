import { API_PATH_VERSION, CONTRACTS_VERSION } from '@qapanda/contracts';
import { CloudSdkClient } from '@qapanda/cloud-sdk';
import { createCloudApiClient, getCloudAuthStatus } from '@qapanda/client-cloud';
import { createRunEvent } from '@qapanda/run-protocol';
import { DEFAULT_HOSTED_FEATURE_FLAGS } from '@qapanda/security';
import { computeRepositoryIdentity } from '@qapanda/sync-core';
import { hasTier } from '@qapanda/ui';

const client = new CloudSdkClient({
  apiBaseUrl: 'https://api.qapanda.example',
  appBaseUrl: 'https://app.qapanda.example',
});

const repo = computeRepositoryIdentity({
  remoteUrl: 'git@github.com:qapanda/example.git',
  branchName: 'main',
});

const event = createRunEvent({
  sequence: 1,
  workspaceId: 'workspace-1',
  runId: 'run-1',
  type: 'run.queued',
  message: 'Queued from QA Panda B-01 import verification',
  tone: 'neutral',
  payload: { ok: true },
});

const cloudBoundary = createCloudApiClient({
  QAPANDA_CLOUD_API_BASE_URL: 'https://api.qapanda.example',
  QAPANDA_CLOUD_APP_BASE_URL: 'https://app.qapanda.example',
});

const authStatus = getCloudAuthStatus({ QAPANDA_CLOUD_AUTH_MODE: 'pkce' });
const tierCheck = hasTier('enterprise', 'pro');

console.log(JSON.stringify({
  contractsVersion: CONTRACTS_VERSION,
  apiPathVersion: API_PATH_VERSION,
  cloudClientBaseUrl: client.apiBaseUrl,
  repositorySlug: repo.repositorySlug,
  runEventType: event.type,
  cloudBoundaryBaseUrl: cloudBoundary.baseUrls.apiBaseUrl,
  authMode: authStatus.mode,
  hostedFlags: Object.keys(DEFAULT_HOSTED_FEATURE_FLAGS).length,
  tierCheck,
}, null, 2));
