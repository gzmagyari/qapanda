# Token Budget Management

## What It Is

A budget system that tracks the combined cost of both the controller (Codex) and the worker (Claude Code) across a run. The user sets a dollar budget, and the system accumulates spend from both CLIs until it approaches the limit, at which point the controller is informed via its system prompt and wraps up cleanly. The budget controls, current spend, and overall usage are displayed beneath the chat input box alongside the existing model dropdowns.

## Why Users Would Want It

Uncapped autonomous runs are a cost anxiety nightmare. Users either hover over the run watching spend, or they let it go and get surprised by the bill. A budget gives users a simple contract: "spend up to $10 on this task." The agent stays fully autonomous within that budget — no approval gates, no interruptions — but it finishes responsibly when the budget runs low, like a contractor tracking billable hours.

## MVP Shape

- **Cost tracking**: Both controller and worker costs are tracked. Codex returns usage metadata after each controller turn; Claude Code streams `usage` fields during worker turns. Both are summed into a single running total.
- **Budget UI**: Beneath the chat input box (where the model dropdowns are), a budget bar shows: `Budget: $2.00 / $10.00` with a percentage indicator, plus a separate `Overall: $20.00` metric that tracks all-time spend across runs. A budget input field lets the user set or change the budget, and a reset button zeroes the current budget counter.
- **Controller awareness**: The current budget status (used, remaining, percentage) is included in the controller's system prompt so it can factor cost into its decisions. When spend reaches 80% of the budget, the system prompt includes a budget warning instructing the controller to prioritize wrapping up. At 95%, a hard wind-down instruction is injected.
- **Budget checks** happen at loop boundaries — before the next worker launch — since a single worker turn may run many internal steps and overshoot the budget before the system can react. This is an inherent limitation: the budget is best-effort, not a hard kill switch.
- **Reset**: The reset button under the chat input zeroes the current run's budget counter without changing the budget limit or the overall usage metric. Useful when the user wants to restart tracking mid-session.

## Why It Fits cc-manager

The orchestrator in `src/orchestrator.js` already controls what the controller receives each turn and decides when to launch the next worker. Both `src/codex.js` and `src/claude.js` already process output that includes usage metadata. Budget management adds a cost aggregation layer and a conditional prompt injection at two thresholds, checked at loop boundaries. The budget is best-effort — a long worker turn can overshoot — but it prevents runaway multi-loop spend, which is the primary risk.

## Implementation Notes

- Add `src/budget.js` with `create(limit)`, `update(source, usageEvent)` (where source is `"controller"` or `"worker"`), `reset()`, `status()` returning `{ used, limit, percentage, overallUsed, warning }`.
- `src/orchestrator.js` calls `budget.update("controller", ...)` after each controller turn and `budget.update("worker", ...)` after each worker turn. At loop boundaries it consults `budget.status()` and injects warnings into the controller's system prompt via `src/prompts.js`.
- Overall usage is persisted in `.cc-manager/usage.json` and accumulates across all runs. Budget-per-run is stored in `manifest.json`: `{ budgetLimit, budgetUsed }`.
- The VS Code webview renders the budget bar beneath the input in `webview/main.js`: budget display, overall usage metric, budget input field, and reset button. Updates arrive via `budget-update` postMessages from `extension/session-manager.js`.
- `src/cli.js` accepts `--budget <amount>`. Budget config can also be set in `CCMANAGER.md` as a default for all runs.
