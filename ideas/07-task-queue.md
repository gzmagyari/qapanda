# Task Queue

## What It Is

The chat input stays enabled in the VS Code webview while the agent is working. Any message sent during an active run is automatically queued and processed after the current run finishes. No special syntax, no `/queue` command — just type your next task and send it. The agent picks it up when it is ready, fully autonomously.

## Why Users Would Want It

Real usage is bursty: a user has five things they need done, not one. Today, the input box is disabled while a run is active, forcing the user to wait and remember what they wanted next. With an always-open input, the user dumps their to-do list as it comes to mind and walks away. The agent works through everything in order. It is the natural extension of full autonomy — autonomous not just within a task, but across tasks.

## MVP Shape

- **VS Code (MVP)**: The webview chat input stays active during a run. Messages sent while a run is in progress are added to a queue and shown beneath the input area with their position. Items can be drag-reordered or removed. When the current run stops, the orchestrator automatically picks up the next queued message and starts a new run. No user input needed between tasks.
- Each queued task becomes its own run with its own run ID, logs, and transcript — fully independent, fully searchable via the conversation history engine (idea 01).
- The queue is persisted to `.cc-manager/queue.json` so it survives VS Code reloads.
- **CLI (future work)**: The terminal shell currently blocks during active runs, so CLI queue support would require reworking the readline loop. This is a later consideration, not part of the MVP.

## Why It Fits cc-manager

The orchestrator in `src/orchestrator.js` already handles run lifecycle — start, loop, stop. The queue sits above the orchestrator as a thin scheduling layer: when one run stops, check the queue, start the next. Each task uses the existing run infrastructure in `src/state.js` with no changes to the core loop. The key UX change is keeping the webview input enabled, which is a `webview/main.js` concern.

## Implementation Notes

- Add `src/queue.js` with `add(stateDir, message)`, `next(stateDir)`, `list(stateDir)`, `remove(stateDir, index)`. The queue is stored as `.cc-manager/queue.json`.
- `extension/session-manager.js` handles messages during an active run by calling `queue.add()` instead of starting a new run. `webview/main.js` keeps the input enabled and renders the queue list below it.
- When a run stops, the queue layer in `extension/session-manager.js` checks `queue.next()`. If a task is pending, it feeds the queued message through the existing new-run flow — the same path used when the user sends a message with no active run.
- Queue updates are pushed to the webview via `queue-updated` postMessages so the UI stays in sync.
