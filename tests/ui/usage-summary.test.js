const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createWebviewDom, sampleInitConfig } = require('../helpers/webview-dom');

let wv;

beforeEach(() => {
  wv = createWebviewDom({ savedState: { runId: 'run-1' } });
  wv.postMessage(sampleInitConfig({ runId: 'run-1' }));
});

afterEach(() => {
  wv.cleanup();
});

describe('Usage summary widget', () => {
  it('stays hidden until API usage arrives', () => {
    const widget = wv.document.getElementById('usage-summary');
    assert.ok(widget.classList.contains('hidden'));
    assert.equal(wv.text('#usage-summary-cost'), '');
  });

  it('renders combined totals and actor breakdown for the current run', () => {
    wv.postMessage({
      type: 'usageStats',
      summary: {
        totalCostUsd: 0.07830462,
        promptCostUsd: 0.07435902,
        completionCostUsd: 0.0039456,
        promptTokens: 939217,
        completionTokens: 3288,
        cachedTokens: 864000,
        cacheWriteTokens: 0,
        costAvailable: true,
        byActor: {
          controller: {
            totalCostUsd: 0.0054663,
            promptCostUsd: 0.0051,
            completionCostUsd: 0.0003663,
            promptTokens: 26095,
            completionTokens: 120,
            cachedTokens: 0,
            cacheWriteTokens: 26092,
            costAvailable: true,
          },
          worker: {
            totalCostUsd: 0.07283832,
            promptCostUsd: 0.06925902,
            completionCostUsd: 0.0035793,
            promptTokens: 913122,
            completionTokens: 3168,
            cachedTokens: 864000,
            cacheWriteTokens: 0,
            costAvailable: true,
          },
        },
        updatedAt: '2026-04-14T12:00:00.000Z',
      },
    });

    const widget = wv.document.getElementById('usage-summary');
    assert.equal(widget.classList.contains('hidden'), false);
    assert.match(wv.text('#usage-summary-cost'), /Cost \$0\.0783/);
    assert.match(wv.text('#usage-summary-cost'), /Prompt \$0\.0744/);
    assert.match(wv.text('#usage-summary-tokens'), /Tokens 939k in/);
    assert.match(wv.text('#usage-summary-tokens'), /3\.3k out/);
    assert.match(wv.text('#usage-summary-actors'), /Worker \$0\.0728/);
    assert.match(wv.text('#usage-summary-actors'), /Orchestrator \$0\.0055/);
  });

  it('hides again when the run is cleared', () => {
    wv.postMessage({
      type: 'usageStats',
      summary: {
        totalCostUsd: 0.01,
        promptCostUsd: 0.009,
        completionCostUsd: 0.001,
        promptTokens: 1000,
        completionTokens: 200,
        cachedTokens: 900,
        cacheWriteTokens: 50,
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
            totalCostUsd: 0.01,
            promptCostUsd: 0.009,
            completionCostUsd: 0.001,
            promptTokens: 1000,
            completionTokens: 200,
            cachedTokens: 900,
            cacheWriteTokens: 50,
            costAvailable: true,
          },
        },
        updatedAt: '2026-04-14T12:00:00.000Z',
      },
    });
    wv.postMessage({ type: 'clearRunId' });

    const widget = wv.document.getElementById('usage-summary');
    assert.ok(widget.classList.contains('hidden'));
    assert.equal(wv.text('#usage-summary-cost'), '');
  });
});
