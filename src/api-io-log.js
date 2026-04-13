const path = require('node:path');
const { appendJsonl, nowIso, writeText } = require('./utils');
const { redactHostedWorkflowValue } = require('./cloud/workflow-hosted-runs');

function safeClone(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    return {
      serializationError: error && error.message ? String(error.message) : 'Failed to serialize value',
    };
  }
}

function loopDirForPromptFile(promptFile) {
  if (!promptFile) return null;
  return path.dirname(promptFile);
}

function workerApiLogFiles(workerRecord, loop, iteration) {
  const loopDir = loopDirForPromptFile(
    (workerRecord && workerRecord.promptFile) ||
    (loop && loop.worker && loop.worker.promptFile) ||
    (loop && loop.controller && loop.controller.promptFile)
  );
  if (!loopDir) return null;
  const suffix = String(iteration || 1).padStart(4, '0');
  return {
    requestFile: path.join(loopDir, `worker.api.iter-${suffix}.request.json`),
    responseFile: path.join(loopDir, `worker.api.iter-${suffix}.response.jsonl`),
  };
}

function controllerApiLogFiles(loop) {
  const loopDir = loopDirForPromptFile(loop && loop.controller && loop.controller.promptFile);
  if (!loopDir) return null;
  return {
    requestFile: path.join(loopDir, 'controller.api.request.json'),
    responseFile: path.join(loopDir, 'controller.api.response.jsonl'),
  };
}

function compactionApiLogFiles(manifest, { requestId = null, loopIndex = null, sessionKey = 'session' } = {}) {
  if (!manifest || !manifest.runDir) return null;
  const safeSessionKey = String(sessionKey || 'session').replace(/[^a-zA-Z0-9_-]+/g, '-');
  const compactionDir = path.join(manifest.runDir, 'compaction');
  const requestSuffix = requestId ? `.req-${requestId}` : '';
  const loopSuffix = Number.isFinite(loopIndex) ? `.loop-${String(loopIndex).padStart(4, '0')}` : '';
  const baseName = `${safeSessionKey}${requestSuffix}${loopSuffix}`;
  return {
    requestFile: path.join(compactionDir, `${baseName}.request.json`),
    responseFile: path.join(compactionDir, `${baseName}.response.jsonl`),
  };
}

async function writeApiRequestLog(manifest, filePath, payload) {
  if (!filePath) return;
  const sanitized = redactHostedWorkflowValue(manifest, safeClone(payload));
  await writeText(filePath, `${JSON.stringify(sanitized, null, 2)}\n`);
}

async function appendApiResponseLog(manifest, filePath, payload) {
  if (!filePath) return;
  const sanitized = redactHostedWorkflowValue(manifest, {
    ts: nowIso(),
    ...safeClone(payload),
  });
  await appendJsonl(filePath, sanitized);
}

function createStreamApiLogHooks(manifest, files, meta = {}) {
  if (!files || !files.requestFile || !files.responseFile) return {};
  return {
    onRequest: async ({ mode, params }) => {
      await writeApiRequestLog(manifest, files.requestFile, {
        ...meta,
        mode: mode || 'stream',
        params,
      });
    },
    onChunk: async (chunk) => {
      await appendApiResponseLog(manifest, files.responseFile, {
        type: 'chunk',
        chunk,
      });
    },
  };
}

module.exports = {
  appendApiResponseLog,
  compactionApiLogFiles,
  controllerApiLogFiles,
  createStreamApiLogHooks,
  workerApiLogFiles,
  writeApiRequestLog,
};
