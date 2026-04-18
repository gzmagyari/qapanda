const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { nowIso } = require('./utils');

function createEmptyUsageActorSummary() {
  return {
    totalCostUsd: 0,
    promptCostUsd: 0,
    completionCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costAvailable: false,
  };
}

function createEmptyUsageSummary() {
  return {
    totalCostUsd: 0,
    promptCostUsd: 0,
    completionCostUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    costAvailable: false,
    byActor: {
      controller: createEmptyUsageActorSummary(),
      worker: createEmptyUsageActorSummary(),
    },
    updatedAt: null,
  };
}

function normalizeActorSummary(actor) {
  const normalized = createEmptyUsageActorSummary();
  const source = actor && typeof actor === 'object' ? actor : {};
  for (const key of Object.keys(normalized)) {
    if (key === 'costAvailable') {
      normalized.costAvailable = !!source.costAvailable;
      continue;
    }
    normalized[key] = toFiniteNumber(source[key]);
  }
  return normalized;
}

function normalizeUsageSummary(summary) {
  const normalized = createEmptyUsageSummary();
  const source = summary && typeof summary === 'object' ? summary : {};
  for (const key of [
    'totalCostUsd',
    'promptCostUsd',
    'completionCostUsd',
    'promptTokens',
    'completionTokens',
    'cachedTokens',
    'cacheWriteTokens',
  ]) {
    normalized[key] = toFiniteNumber(source[key]);
  }
  normalized.costAvailable = !!source.costAvailable;
  normalized.updatedAt = typeof source.updatedAt === 'string' && source.updatedAt.trim()
    ? source.updatedAt
    : null;
  normalized.byActor.controller = normalizeActorSummary(source.byActor && source.byActor.controller);
  normalized.byActor.worker = normalizeActorSummary(source.byActor && source.byActor.worker);
  normalized.costAvailable =
    normalized.costAvailable ||
    normalized.byActor.controller.costAvailable ||
    normalized.byActor.worker.costAvailable;
  return normalized;
}

function usageActorHasData(actor) {
  if (!actor || typeof actor !== 'object') return false;
  return !!(
    actor.costAvailable ||
    toFiniteNumber(actor.promptTokens) > 0 ||
    toFiniteNumber(actor.completionTokens) > 0 ||
    toFiniteNumber(actor.cachedTokens) > 0 ||
    toFiniteNumber(actor.cacheWriteTokens) > 0
  );
}

function usageSummaryHasData(summary) {
  const normalized = normalizeUsageSummary(summary);
  return !!(
    usageActorHasData(normalized.byActor.controller) ||
    usageActorHasData(normalized.byActor.worker) ||
    normalized.costAvailable ||
    normalized.promptTokens > 0 ||
    normalized.completionTokens > 0 ||
    normalized.cachedTokens > 0 ||
    normalized.cacheWriteTokens > 0
  );
}

function usageSummaryNeedsBackfill(summary) {
  const normalized = normalizeUsageSummary(summary);
  if (!usageSummaryHasData(normalized)) return false;
  if (normalized.totalCostUsd > 0) return false;
  const hasComponentCosts =
    normalized.promptCostUsd > 0 ||
    normalized.completionCostUsd > 0 ||
    normalized.byActor.controller.promptCostUsd > 0 ||
    normalized.byActor.controller.completionCostUsd > 0 ||
    normalized.byActor.worker.promptCostUsd > 0 ||
    normalized.byActor.worker.completionCostUsd > 0;
  return hasComponentCosts;
}

function usageActorFromBackend(backend) {
  return String(backend || '').startsWith('controller:') ? 'controller' : 'worker';
}

function usageDeltaFromUsage(usage) {
  const normalized = usage && typeof usage === 'object' ? usage : {};
  const raw = normalized.raw && typeof normalized.raw === 'object' ? normalized.raw : {};
  const costDetails = raw.cost_details && typeof raw.cost_details === 'object' ? raw.cost_details : {};
  const promptCostUsd = firstFinite(
    costDetails.upstream_inference_prompt_cost,
    costDetails.prompt_cost,
    costDetails.input_cost,
    raw.prompt_cost,
    raw.input_cost
  );
  const completionCostUsd = firstFinite(
    costDetails.upstream_inference_completions_cost,
    costDetails.upstream_inference_completion_cost,
    costDetails.completion_cost,
    costDetails.output_cost,
    raw.completion_cost,
    raw.output_cost
  );
  const summedPromptAndCompletionCost =
    Number.isFinite(promptCostUsd) || Number.isFinite(completionCostUsd)
      ? (toFiniteNumber(promptCostUsd) + toFiniteNumber(completionCostUsd))
      : null;
  const totalCostUsd = firstPositiveFinite(
    raw.cost,
    raw.total_cost,
    raw.cost_usd,
    raw.total_cost_usd,
    costDetails.upstream_inference_cost,
    costDetails.total_cost,
    costDetails.total_cost_usd,
    raw.upstream_inference_cost,
    summedPromptAndCompletionCost
  ) ?? firstFinite(
    raw.cost,
    raw.total_cost,
    raw.cost_usd,
    raw.total_cost_usd,
    costDetails.upstream_inference_cost,
    costDetails.total_cost,
    costDetails.total_cost_usd,
    raw.upstream_inference_cost,
    summedPromptAndCompletionCost
  );
  const costAvailable =
    Number.isFinite(totalCostUsd) ||
    Number.isFinite(promptCostUsd) ||
    Number.isFinite(completionCostUsd);

  return {
    totalCostUsd: toFiniteNumber(totalCostUsd),
    promptCostUsd: toFiniteNumber(promptCostUsd),
    completionCostUsd: toFiniteNumber(completionCostUsd),
    promptTokens: toFiniteNumber(normalized.promptTokens),
    completionTokens: toFiniteNumber(normalized.completionTokens),
    cachedTokens: toFiniteNumber(normalized.cachedTokens),
    cacheWriteTokens: toFiniteNumber(normalized.cacheWriteTokens),
    costAvailable,
  };
}

function applyUsageDelta(summary, actor, delta, updatedAt = nowIso()) {
  const normalized = normalizeUsageSummary(summary);
  const targetActor = actor === 'controller' ? 'controller' : 'worker';
  const actorSummary = normalized.byActor[targetActor];
  for (const key of [
    'totalCostUsd',
    'promptCostUsd',
    'completionCostUsd',
    'promptTokens',
    'completionTokens',
    'cachedTokens',
    'cacheWriteTokens',
  ]) {
    const value = toFiniteNumber(delta[key]);
    normalized[key] += value;
    actorSummary[key] += value;
  }
  actorSummary.costAvailable = actorSummary.costAvailable || !!delta.costAvailable;
  normalized.costAvailable =
    normalized.costAvailable ||
    actorSummary.costAvailable ||
    normalized.byActor.controller.costAvailable ||
    normalized.byActor.worker.costAvailable;
  normalized.updatedAt = newerIso(normalized.updatedAt, updatedAt);
  return normalized;
}

function applyUsageToManifest(manifest, { actor, usage, updatedAt = nowIso() } = {}) {
  if (!manifest || !usage) return null;
  manifest.usageSummary = applyUsageDelta(
    manifest.usageSummary,
    actor === 'controller' ? 'controller' : 'worker',
    usageDeltaFromUsage(usage),
    updatedAt
  );
  return manifest.usageSummary;
}

function usageSummaryMessage(summary) {
  const normalized = normalizeUsageSummary(summary);
  return usageSummaryHasData(normalized) ? normalized : null;
}

function responseLogActorForPath(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  const baseName = path.basename(normalized);
  if (baseName.startsWith('worker.api.iter-')) return 'worker';
  if (baseName === 'controller.api.response.jsonl') return 'controller';
  if (!normalized.includes('/compaction/')) return null;
  return baseName.startsWith('controller-') ? 'controller' : 'worker';
}

async function backfillUsageSummaryFromRun(manifest) {
  if (!manifest || !manifest.runDir) {
    return { changed: false, summary: usageSummaryMessage(null) };
  }

  const files = await collectResponseLogFiles(manifest.runDir);
  let summary = createEmptyUsageSummary();
  let found = false;

  for (const filePath of files) {
    const actor = responseLogActorForPath(filePath);
    if (!actor) continue;
    await scanUsageResponseLog(filePath, async (parsed) => {
      if (!parsed || parsed.type !== 'done' || !parsed.usage) return;
      summary = applyUsageDelta(summary, actor, usageDeltaFromUsage(parsed.usage), parsed.ts || null);
      found = true;
    });
  }

  const normalizedCurrent = normalizeUsageSummary(manifest.usageSummary);
  const normalizedNext = found ? summary : createEmptyUsageSummary();
  const changed = JSON.stringify(normalizedCurrent) !== JSON.stringify(normalizedNext);
  manifest.usageSummary = normalizedNext;
  return { changed, summary: usageSummaryMessage(normalizedNext) };
}

async function collectResponseLogFiles(rootDir) {
  const found = [];
  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.response.jsonl')) {
        found.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return found.sort();
}

async function scanUsageResponseLog(filePath, onRecord) {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      await onRecord(parsed);
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

function firstFinite(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function firstPositiveFinite(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function newerIso(a, b) {
  if (!b) return a || null;
  if (!a) return b;
  return String(a) > String(b) ? a : b;
}

module.exports = {
  applyUsageToManifest,
  backfillUsageSummaryFromRun,
  createEmptyUsageSummary,
  normalizeUsageSummary,
  responseLogActorForPath,
  usageActorFromBackend,
  usageDeltaFromUsage,
  usageSummaryHasData,
  usageSummaryNeedsBackfill,
  usageSummaryMessage,
};
