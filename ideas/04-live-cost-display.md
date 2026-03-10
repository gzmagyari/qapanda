# Live Cost Display

## What It Is

An always-visible cost and token counter displayed beneath the chat input area, alongside the existing dropdowns. It updates in real time as the run progresses — showing tokens consumed, estimated dollar cost, and run duration — so the user always knows what a session is costing without running a separate command.

## Why Users Would Want It

Cost is the number one concern for regular AI tool users, but today there is zero visibility during a run. Users find out what they spent only by checking their provider dashboard after the fact. A persistent, glanceable cost readout removes the anxiety of "is this run burning through my budget?" and helps users develop intuition for what different tasks cost.

## MVP Shape

- **Terminal**: A status line rendered below the input prompt showing: `Tokens: 12,450 | Cost: ~$0.18 | Duration: 2m 34s`. Updated after every worker turn using token counts from Claude's streaming events.
- **VS Code**: The same information displayed as a compact bar beneath the webview input box, styled to match the existing UI. Updated via postMessage from the session manager.
- Token counts are extracted from Claude's `usage` fields in streaming output and from Codex's response metadata. Controller and worker tokens are summed separately and shown as a combined total.
- The display resets on each new run and accumulates across loops within a run.

## Why It Fits cc-manager

The worker streaming in `src/claude.js` already processes events that include token usage. The renderer interface already separates terminal and webview output. The cost display is a thin aggregation layer that taps into data flowing through the existing event pipeline — no new API calls or data collection.

## Implementation Notes

- Add `src/cost-tracker.js` with `update(usageEvent)`, `reset()`, and `summary()` that maintains running totals and formats the display string.
- `src/claude.js` calls `costTracker.update()` when it encounters `usage` fields in streaming events.
- `src/render.js` adds a `costLine(summary)` method that writes the status line below the prompt. `extension/webview-renderer.js` posts a `cost-update` message to the webview.
- Price-per-token table in `src/cost-tracker.js` keyed by model name, with sensible defaults and a `--cost-table` override for custom pricing.
