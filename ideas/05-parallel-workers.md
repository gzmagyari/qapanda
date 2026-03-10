# Parallel Workers

## What It Is

The controller can split a complex task into independent subtasks and delegate them to multiple Claude Code worker sessions running simultaneously. Each worker operates in its own context, and the controller merges results when all workers finish — turning sequential loops into parallel execution.

## Why Users Would Want It

Large tasks often contain independent pieces: "update the API handler, add tests, and fix the docs." Today these run sequentially, one worker turn at a time. Parallel workers let the controller identify independent subtasks and farm them out simultaneously, cutting wall-clock time dramatically for tasks with natural parallelism. The user's time is valuable — full autonomy should also mean full speed.

## MVP Shape

- The controller can emit `action: "parallel"` with a `subtasks` array, each containing a `claude_message` and an optional `label`.
- `src/orchestrator.js` spawns one Claude Code session per subtask using separate session IDs. Each worker runs in its own subdirectory under the loop's request folder.
- When all workers complete, their results are concatenated into a single summary and fed back to the controller for the next decision. The controller merges, resolves conflicts, or delegates follow-up work.
- A `--max-parallel <n>` flag (default 3) caps concurrent workers to manage resource usage.

## Why It Fits cc-manager

The worker spawning logic in `src/claude.js` already handles session IDs and streaming. Parallel workers reuse that same spawn function multiple times with `Promise.allSettled`. The controller already receives worker results and decides next steps — it just receives a combined result instead of a single one.

## Implementation Notes

- Extend `src/schema.js` with `action: "parallel"` carrying a `subtasks` array of `{ label, claude_message }` objects.
- Add `src/parallel.js` that takes a subtask array, spawns workers via `src/claude.js`, streams all outputs to the renderer with labeled prefixes, and collects results.
- `src/orchestrator.js` handles the `parallel` action by calling `parallel.run(subtasks)` and feeding the combined result back to the controller.
- Each subtask's logs are stored in separate subdirectories: `requests/<req>/loop-<n>/worker-<label>/`.
- The renderer shows parallel workers as indented sub-timelines under the main loop.
