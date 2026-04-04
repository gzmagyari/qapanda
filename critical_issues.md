I went through the runtime flows feature-by-feature rather than leaning on tests. The biggest **new** bugs I found are below. These are the ones I’d treat as highest priority after setup/security issues.

## 1. Standalone web mode has broken session identity, so refresh/disconnect kills runs and strands session-linked resources

The web client already persists both `runId` and `panelId` and sends them back on `ready` (`extension/webview/main.js:5371-5377`, `5614-5617`). The VS Code host honors that and restores the old panel/session identity (`extension/extension.js:270-273`, `540-549`, `561-569`).

The standalone web server does not. It creates a brand new `panelId` on every WebSocket connection (`web/server.js:129-168`), ignores the saved `panelId` in the `ready` message (`web/server.js:218-233`), and disposes the whole session on socket close (`web/server.js:290-293`). `dispose()` aborts the active run (`extension/session-manager.js:870-873`, `1884-1891`).

Why this is critical:
A browser refresh, tab close, or transient network hiccup can kill a live run. Because desktop instance names are derived from `repoRoot + panelId` (`src/remote-desktop.js:47-52`), the refreshed browser is no longer “the same session”, so linked desktop instances cannot be cleanly reattached. This same identity bug likely affects Chrome/Codex prestart reuse too, because `prestart()` explicitly assumes panelId has already been restored before it runs (`extension/session-manager.js:1481-1482`), but the web server calls `session.prestart()` before `ready` (`web/server.js:154-168`).

How to fix it:
Make web mode use a stable client-provided `panelId`, or create the `SessionManager` lazily after `ready` so the restored `panelId` is known first. On disconnect, detach rather than fully dispose, or keep a short grace period for reconnect. Web mode should also mirror the extension flow: `reattachRun`, `sendTranscript`, `sendProgress`, and re-link any existing desktop instance.

## 2. Orchestrate mode breaks when wait mode is enabled, and can leave runs stuck in a fake “running” state

The product contract says Orchestrate should loop until done (`extension/README.md:187-191`). The code comment says the same (`extension/session-manager.js:1828-1844`).

But `_runLoop()` forces `singlePass` whenever `waitDelay` is set (`extension/session-manager.js:1864-1871`). In `runManagerLoop()`, single-pass mode returns after one controller→worker cycle **without stopping the run** (`src/orchestrator.js:572-580`). Normal Send mode handles that by calling `_scheduleNextPass()` afterward (`extension/session-manager.js:657-679`, `990-992`). Orchestrate mode does **not** schedule the next pass after `_runLoop()` returns (`extension/session-manager.js:1831-1846`).

Why this is critical:
If wait mode is configured, Orchestrate silently stops being “orchestrate until done”. It runs one cycle, returns, and can leave the manifest marked `running` even though nothing is actually continuing.

How to fix it:
Do not let wait-delay implicitly force `singlePass` for Orchestrate. The cleanest fix is to pass an explicit `singlePass: false` or `loopUntilStop: true` from `_handleOrchestrate()` and make `_runLoop()` honor that over wait-delay logic.

## 3. Continue mode persists temporary controller state to disk incorrectly

In the extension path, `_runControllerContinue()` temporarily appends a continue directive to `controllerSystemPrompt` and nulls the controller session id (`extension/session-manager.js:1762-1771`). It then runs the controller and saves the manifest **before** restoring the original prompt/session (`1791`, `1796-1799`).

That means the manifest on disk can end up containing the temporary continue prompt and a null controller session id.

This looks unintentional because the shell implementation does it the correct way: restore original prompt/session first, then save (`src/shell.js:432-446`).

Why this is critical:
After a Continue pass, a reload/resume can pick up a polluted controller prompt and a lost controller session. That is exactly the sort of bug that causes “why is the controller behaving weird now?” reports.

How to fix it:
Restore the original prompt and session id before saving, or save again after the restore in `finally`. Even better, avoid mutating the persisted manifest directly for one-shot continue directives.

## 4. Task/test persistence is not safe under real concurrent use

Tasks and tests are stored as whole JSON files and every writer does read → mutate in memory → overwrite full file:

* tasks MCP: `extension/tasks-mcp-server.js:23-35`
* tests MCP: `extension/tests-mcp-server.js:27-47`
* UI handlers: `extension/message-handlers.js:108-121`, then direct CRUD in `124-157` and `237-287`

IDs are allocated from counters inside those same files, such as `nextId`, `nextStepId`, `nextRunId` (`extension/tasks-mcp-server.js:274-291`, `extension/tests-mcp-server.js:149-160`, `216-230`).

Why this is critical:
The app is built around user edits and agent edits both touching the same `.qpanda/*.json` files. With no lock and no atomic merge, concurrent writes can lose updates, roll back comments/progress, and even allocate duplicate IDs. On top of that, writes go straight to the final file path, so a crash during write can leave truncated/corrupt JSON.

How to fix it:
Move tasks/tests into a single shared store layer with a mutex or transactional backend. At minimum: write to a temp file and rename atomically, and serialize all writes through one process. Long term, this wants SQLite or an append-log model, not ad hoc full-file rewrites.

## 5. Tasks/tests have three separate implementations, and they already disagree

The same domain logic exists in at least three places:

* direct UI CRUD in `extension/message-handlers.js`
* stdio MCP in `extension/tests-mcp-server.js` / `tasks-mcp-server.js`
* HTTP MCP in `extension/tests-mcp-http.js` / `tasks-mcp-http.js`

Those implementations already diverge.

Concrete examples:

* UI `testDeleteStep` does **not** recompute test status (`extension/message-handlers.js:280-287`), while MCP `delete_test_step` does (`extension/tests-mcp-server.js:206-213`).
* UI `taskUpdate` accepts any status string (`extension/message-handlers.js:142-149`), while MCP validates status (`extension/tasks-mcp-server.js:294-301`).
* HTTP `update_step_result` / `complete_test_run` attach `_testCard` metadata (`extension/tests-mcp-http.js:124-125`), but stdio `cc-tests` does not (`extension/tests-mcp-server.js:252-288`).
* API mode auto-injects the stdio server (`src/mcp-injector.js:143-148`), while extension/web sessions prefer the HTTP server (`extension/session-manager.js:290-295`), so behavior changes by product mode.

Why this is critical:
Whether the same action behaves correctly depends on **how** it was reached: UI, extension MCP, web MCP, or API mode. That is a deep reliability bug.

How to fix it:
Create one shared task/test domain module with the real business logic. UI handlers and both MCP surfaces should call that shared code, not each have their own copy.

## 6. Referential integrity between tests and tasks is fundamentally broken

This is deeper than the earlier “one-sided linking” note.

Problems I verified:

* `link_test_to_task` only updates the test side and does not verify the task exists (`extension/tests-mcp-server.js:291-298`).
* `unlink_test_from_task` only updates the test side (`301-307`).
* `delete_task` and UI `taskDelete` do no backlink cleanup (`extension/tasks-mcp-server.js:315-320`, `extension/message-handlers.js:154-157`).
* `delete_test` and UI `testDelete` do no cleanup on linked tasks (`extension/message-handlers.js:250-254`).
* `create_bug_from_test` updates `tasks.json` and `tests.json` as two separate writes with no transaction (`extension/tests-mcp-server.js:310-329`).

Why this is critical:
You can create dangling links to nonexistent tasks, stale backlinks after deletes, and partial cross-file updates. Reports and issue classification then become wrong because other code assumes the link graph is trustworthy.

How to fix it:
Pick one canonical place for links, or enforce bidirectional updates transactionally in the shared store layer. Validate the target exists before linking. Cleanup backlinks on delete. Use set semantics to avoid duplicate ids.

## 7. The test MCP often reports logical failures as successful calls, and it silently accepts bad input

A lot of test-tool failure paths return JSON text like `{"error":"..."}` instead of throwing (`extension/tests-mcp-server.js:216-230`, `252-288`, `291-307`, `310-335`). The HTTP wrapper treats any returned string as normal tool output unless an exception is thrown (`extension/mcp-http-server.js:67-75`).

There is also silent bad-input handling. In `update_step_result`, an invalid `status` does not error; it is just ignored and the tool still returns success (`extension/tests-mcp-server.js:252-269`).

Why this is critical:
Agents can keep going after failed `run_test`, `update_step_result`, `complete_test_run`, or linking operations because the tool call looks successful. And malformed statuses can “succeed” while not actually changing anything.

How to fix it:
Throw on all not-found and invalid-input cases. Validate enums strictly. Let the MCP wrapper mark those calls as `isError`. Do not encode logical failure inside a successful text payload.

## 8. Re-testing can inherit stale status from previous runs

`run_test` creates a new run with fresh `stepResults`, but it does **not** reset the stored step states on the test object itself (`extension/tests-mcp-server.js:216-230`). `reset_test_steps` exists, but it is optional (`233-249`). Then `complete_test_run` computes the run status from the current run’s `stepResults`, but computes `test.status` from `test.steps` (`272-288`).

Why this is critical:
If a rerun starts without `reset_test_steps`, old pass/fail state remains on `test.steps` and bleeds into the new overall test status. So the current run can say one thing while the saved test status says another.

How to fix it:
Either auto-reset test steps inside `run_test`, or make `complete_test_run` derive `test.status` from the current run results and then sync step state from that run in one place.

## 9. Instance lifecycle controls are wrong in several places

There are multiple bugs here, and they stack.

First, the webview’s “Restart this session” button is not wired to restart. It changes the button action to `restartLinked`, but `restartLinked` calls `instanceStart`, not `instanceRestart` (`extension/webview/main.js:2640-2655`).

Second, `restartInstance(name, repoRoot, panelId)` stops the named instance, then starts `ensureDesktop(repoRoot, panelId)` (`src/remote-desktop.js:247-249`), which derives a fresh instance name from the **current** `repoRoot + panelId` (`src/remote-desktop.js:47-52`), not from the instance that was actually requested.

Third, `instanceRestartAll` loops over every listed instance, but for each one calls that same flawed restart path (`extension/message-handlers.js:416-420`). So it can stop many instances and keep starting only the current session’s instance.

Why this is critical:
Restart controls are not trustworthy. A button labeled restart can be a no-op, restart the wrong instance, or in the “restart all” path stop a bunch of instances but only recreate one.

How to fix it:
Separate “start” from “restart” for real. Make restart take an exact instance identity and restart that same identity. For restart-all, restart each listed instance by its own name/workspace rather than calling `ensureDesktop(repoRoot, panelId)` in a loop.

## 10. Loop auto-continue can fire after the session has been disposed

`_scheduleLoopContinue()` uses a bare `setTimeout()` and does not store the timer handle (`extension/session-manager.js:1818-1824`). `dispose()` clears wait timers, aborts the active run, and stops MCP/interactive sessions, but it does not cancel that loop-continue timeout (`1884-1891`).

Why this is critical:
If loop mode is on and a continue pass has just scheduled the next one, closing the panel/browser can still trigger a new hidden Continue 500ms later. In standalone web mode, that compounds the disconnect bug.

How to fix it:
Store the timeout handle and clear it in `dispose()`, `abort()`, and whenever a new foreground action begins. It should also be tied to a run token so an old timer cannot wake a newer session.

---

The common root causes are pretty clear:

1. **Web mode does not preserve stable session identity.**
2. **SessionManager has a couple of real state-machine bugs.**
3. **Tasks/tests have no single source of truth and no safe persistence layer.**

The first fixes I’d make are:

* stable web `panelId` + detach/reattach instead of dispose-on-disconnect,
* fix Orchestrate/Continue state handling,
* replace ad hoc JSON rewrites with one shared transactional store layer for tasks/tests.

The earlier bugs I mentioned still stand too: missing PDF export in standalone web, missing `apiCatalog` there, severity not being persisted, and the earlier task/test link/report issues.
