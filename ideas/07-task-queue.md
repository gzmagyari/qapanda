# Task Queue

## What It Is

The chat input stays enabled while the agent is working. Any message sent during an active run is automatically queued and processed after the current run finishes. No special syntax, no `/queue` command — just type your next task and send it. The agent picks it up when it is ready, fully autonomously.

## Why Users Would Want It

Real usage is bursty: a user has five things they need done, not one. Today, the input box is disabled while a run is active, forcing the user to wait and remember what they wanted next. With an always-open input, the user dumps their to-do list as it comes to mind and walks away. The agent works through everything in order. It is the natural extension of full autonomy — autonomous not just within a task, but across tasks.

## MVP Shape

- The chat input box (both terminal readline and VS Code webview) stays active during a run. Messages sent while a run is in progress are added to a queue and shown beneath the input area with their position.
- When the current run stops, the orchestrator automatically picks up the next queued message and starts a new run for it. No user input needed between tasks.
- The queue is visible: a small list under the chat input showing pending messages with their order. In VS Code, items can be drag-reordered or removed. In the terminal, `/queue` shows pending items and `/queue remove <n>` drops one.
- Each queued task becomes its own run with its own run ID, logs, and transcript — fully independent, fully searchable via the conversation history engine (idea 01).

## Why It Fits cc-manager

The orchestrator in `src/orchestrator.js` already handles run lifecycle — start, loop, stop. The queue sits above the orchestrator as a thin scheduling layer: when one run stops, check the queue, start the next. Each task uses the existing run infrastructure in `src/state.js` with no changes to the core loop. The key UX change is simply keeping the input enabled, which is a renderer/webview concern.

## Implementation Notes

- Add `src/queue.js` with `add(stateDir, message)`, `next(stateDir)`, `list(stateDir)`, `remove(stateDir, index)`. The queue is stored as `.cc-manager/queue.json`.
- `src/shell.js` stops disabling readline during active runs. Incoming messages check if a run is active — if yes, call `queue.add()` and render a "queued" confirmation instead of starting a new run.
- `extension/session-manager.js` does the same: messages during an active run go to the queue. `webview/main.js` keeps the input enabled and renders the queue list below it.
- `src/orchestrator.js` checks `queue.next()` after a run stops. If a task is pending, it calls `orchestrator.start()` with the queued message automatically.
