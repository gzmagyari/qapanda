const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  applyUsageToManifest,
  backfillUsageSummaryFromRun,
  createEmptyUsageSummary,
  responseLogActorForPath,
  usageSummaryHasData,
  usageSummaryNeedsBackfill,
  usageSummaryMessage,
} = require('../../src/usage-summary');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-usage-summary-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeManifest() {
  const runDir = path.join(tmpDir, '.qpanda', 'runs', 'usage-run');
  fs.mkdirSync(runDir, { recursive: true });
  return {
    runId: 'usage-run',
    runDir,
    files: {
      manifest: path.join(runDir, 'manifest.json'),
    },
    usageSummary: createEmptyUsageSummary(),
  };
}

describe('usage summary helper', () => {
  it('aggregates worker and controller usage into total and actor buckets', () => {
    const manifest = makeManifest();
    applyUsageToManifest(manifest, {
      actor: 'worker',
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        cachedTokens: 80,
        cacheWriteTokens: 5,
        raw: {
          cost: 0.02,
          cost_details: {
            upstream_inference_prompt_cost: 0.015,
            upstream_inference_completions_cost: 0.005,
          },
        },
      },
    });
    applyUsageToManifest(manifest, {
      actor: 'controller',
      usage: {
        promptTokens: 40,
        completionTokens: 10,
        cachedTokens: 35,
        cacheWriteTokens: 2,
        raw: {
          cost: 0.004,
          cost_details: {
            upstream_inference_prompt_cost: 0.003,
            upstream_inference_completions_cost: 0.001,
          },
        },
      },
    });

    assert.equal(manifest.usageSummary.totalCostUsd, 0.024);
    assert.equal(manifest.usageSummary.promptTokens, 140);
    assert.equal(manifest.usageSummary.completionTokens, 30);
    assert.equal(manifest.usageSummary.cachedTokens, 115);
    assert.equal(manifest.usageSummary.cacheWriteTokens, 7);
    assert.equal(manifest.usageSummary.byActor.worker.totalCostUsd, 0.02);
    assert.equal(manifest.usageSummary.byActor.controller.totalCostUsd, 0.004);
    assert.equal(usageSummaryHasData(manifest.usageSummary), true);
    assert.equal(usageSummaryMessage(manifest.usageSummary).byActor.worker.promptTokens, 100);
  });

  it('falls back to provider cost details when raw total cost is zero', () => {
    const manifest = makeManifest();
    applyUsageToManifest(manifest, {
      actor: 'worker',
      usage: {
        promptTokens: 11131,
        completionTokens: 43,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        raw: {
          cost: 0,
          is_byok: true,
          cost_details: {
            upstream_inference_cost: 0.00227995,
            upstream_inference_prompt_cost: 0.0022262,
            upstream_inference_completions_cost: 0.00005375,
          },
        },
      },
    });

    assert.equal(manifest.usageSummary.totalCostUsd, 0.00227995);
    assert.equal(manifest.usageSummary.promptCostUsd, 0.0022262);
    assert.equal(manifest.usageSummary.completionCostUsd, 0.00005375);
    assert.equal(manifest.usageSummary.byActor.worker.totalCostUsd, 0.00227995);
    assert.equal(manifest.usageSummary.costAvailable, true);
  });

  it('flags persisted summaries with zero total but positive component costs for backfill', () => {
    assert.equal(usageSummaryNeedsBackfill({
      totalCostUsd: 0,
      promptCostUsd: 0.0036,
      completionCostUsd: 0.0003,
      promptTokens: 1000,
      completionTokens: 80,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costAvailable: true,
      byActor: {
        controller: {
          totalCostUsd: 0,
          promptCostUsd: 0,
          completionCostUsd: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          costAvailable: false,
        },
        worker: {
          totalCostUsd: 0,
          promptCostUsd: 0.0036,
          completionCostUsd: 0.0003,
          promptTokens: 1000,
          completionTokens: 80,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          costAvailable: true,
        },
      },
    }), true);
  });

  it('backfills usage summary from existing worker, controller, and compaction response logs', async () => {
    const manifest = makeManifest();
    const workerLoopDir = path.join(manifest.runDir, 'requests', 'req-0001', 'loop-0001');
    const compactionDir = path.join(manifest.runDir, 'compaction');
    fs.mkdirSync(workerLoopDir, { recursive: true });
    fs.mkdirSync(compactionDir, { recursive: true });

    fs.writeFileSync(path.join(workerLoopDir, 'worker.api.iter-0001.response.jsonl'), [
      JSON.stringify({
        ts: '2026-04-14T10:00:00.000Z',
        type: 'done',
        usage: {
          promptTokens: 200,
          completionTokens: 30,
          cachedTokens: 150,
          cacheWriteTokens: 10,
          raw: {
            cost: 0.03,
            cost_details: {
              upstream_inference_prompt_cost: 0.02,
              upstream_inference_completions_cost: 0.01,
            },
          },
        },
      }),
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(workerLoopDir, 'controller.api.response.jsonl'), [
      JSON.stringify({
        ts: '2026-04-14T10:00:01.000Z',
        type: 'done',
        usage: {
          promptTokens: 80,
          completionTokens: 12,
          cachedTokens: 70,
          cacheWriteTokens: 3,
          raw: {
            cost: 0.008,
            cost_details: {
              upstream_inference_prompt_cost: 0.006,
              upstream_inference_completions_cost: 0.002,
            },
          },
        },
      }),
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(compactionDir, 'worker-default.req-req-0001.loop-0001.response.jsonl'), [
      JSON.stringify({
        ts: '2026-04-14T10:00:02.000Z',
        type: 'done',
        usage: {
          promptTokens: 50,
          completionTokens: 5,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          raw: {
            cost: 0.005,
            cost_details: {
              upstream_inference_prompt_cost: 0.004,
              upstream_inference_completions_cost: 0.001,
            },
          },
        },
      }),
      '',
    ].join('\n'));

    const result = await backfillUsageSummaryFromRun(manifest);
    assert.equal(result.changed, true);
    assert.equal(manifest.usageSummary.totalCostUsd, 0.043);
    assert.ok(Math.abs(manifest.usageSummary.byActor.worker.totalCostUsd - 0.035) < 1e-9);
    assert.equal(manifest.usageSummary.byActor.controller.totalCostUsd, 0.008);
    assert.equal(manifest.usageSummary.promptTokens, 330);
    assert.equal(manifest.usageSummary.completionTokens, 47);
    assert.equal(manifest.usageSummary.updatedAt, '2026-04-14T10:00:02.000Z');
  });

  it('backfills usage summary by streaming response logs instead of whole-file readFile calls', async () => {
    const manifest = makeManifest();
    const workerLoopDir = path.join(manifest.runDir, 'requests', 'req-0002', 'loop-0001');
    fs.mkdirSync(workerLoopDir, { recursive: true });
    fs.writeFileSync(path.join(workerLoopDir, 'worker.api.iter-0001.response.jsonl'), [
      JSON.stringify({ type: 'ignored', usage: null }),
      JSON.stringify({
        ts: '2026-04-14T11:00:00.000Z',
        type: 'done',
        usage: {
          promptTokens: 42,
          completionTokens: 7,
          cachedTokens: 5,
          cacheWriteTokens: 1,
          raw: {
            cost: 0.0042,
            cost_details: {
              upstream_inference_prompt_cost: 0.0038,
              upstream_inference_completions_cost: 0.0004,
            },
          },
        },
      }),
      '',
    ].join('\n'));

    const fsPromises = require('node:fs/promises');
    const originalReadFile = fsPromises.readFile;
    fsPromises.readFile = async () => {
      throw new Error('backfillUsageSummaryFromRun should not use readFile');
    };
    try {
      const result = await backfillUsageSummaryFromRun(manifest);
      assert.equal(result.changed, true);
      assert.equal(manifest.usageSummary.totalCostUsd, 0.0042);
      assert.equal(manifest.usageSummary.promptTokens, 42);
      assert.equal(manifest.usageSummary.updatedAt, '2026-04-14T11:00:00.000Z');
    } finally {
      fsPromises.readFile = originalReadFile;
    }
  });

  it('infers the actor from response log paths', () => {
    assert.equal(responseLogActorForPath('C:\\run\\requests\\req-1\\loop-0001\\worker.api.iter-0001.response.jsonl'), 'worker');
    assert.equal(responseLogActorForPath('C:\\run\\requests\\req-1\\loop-0001\\controller.api.response.jsonl'), 'controller');
    assert.equal(responseLogActorForPath('C:\\run\\compaction\\controller-main.req-req-1.loop-0001.response.jsonl'), 'controller');
    assert.equal(responseLogActorForPath('C:\\run\\compaction\\worker-default.req-req-1.loop-0001.response.jsonl'), 'worker');
  });
});
