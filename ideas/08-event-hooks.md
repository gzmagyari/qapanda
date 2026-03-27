# Event Hooks

## What It Is

User-defined shell commands that fire automatically on run lifecycle events: worker turn complete, run stopped, error encountered, loop count threshold reached. Hooks let users extend qapanda's behavior without modifying source code — play a sound when a run finishes, post to Slack, trigger a deploy, or log metrics to an external system.

## Why Users Would Want It

Every user has a slightly different workflow around their agent. One person wants a desktop notification when a run finishes. Another wants to pipe run summaries to a team channel. A third wants to auto-run the test suite after every worker turn. Today, none of this is possible without modifying qapanda's code. Event hooks give users a simple, universal extension point — just a shell command that runs at the right time.

## MVP Shape

- Hooks are defined in `.qpanda/hooks.json` (project-level) or `~/.qpanda/hooks.json` (global), mapping event names to shell commands:
  ```json
  {
    "on_run_stopped": "notify-send 'qapanda' 'Run finished'",
    "on_worker_done": "npm test --silent",
    "on_error": "echo 'Run error' >> ~/agent-errors.log"
  }
  ```
- Supported events: `on_run_started`, `on_worker_done`, `on_controller_done`, `on_run_stopped`, `on_error`, `on_loop_threshold` (fires every N loops).
- Hook commands receive environment variables: `$CC_RUN_ID`, `$CC_LOOP`, `$CC_EVENT`, `$CC_STATUS`, and `$CC_STATE_DIR` for context.
- Hooks run asynchronously and do not block the main loop. Failures are logged but do not interrupt the run.

## Why It Fits qapanda

The orchestrator in `src/orchestrator.js` already emits events at every lifecycle transition — controller done, worker done, stop, error. Hooks are a thin dispatch layer that fires shell commands at those same transition points. No changes to the core loop logic, just a listener that reads a config file and runs commands.

## Implementation Notes

- Add `src/hooks.js` with `load(stateDir)` that reads hook config from project and global locations (project takes precedence), and `fire(event, env)` that spawns the command with `child_process.exec` in fire-and-forget mode.
- `src/orchestrator.js` calls `hooks.fire()` at each lifecycle point, passing the relevant environment variables.
- `src/cli.js` adds a `hooks` subcommand: `qapanda hooks list` shows configured hooks, `qapanda hooks test <event>` fires a hook manually for testing.
- Hook output is captured and written to a `hooks.log` file in the run directory for debugging.
