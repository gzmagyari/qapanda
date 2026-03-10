# Token Budget Management

## What It Is

Set a token or dollar budget per run, and the controller autonomously manages its spend within that limit. As the run approaches the budget ceiling, the controller wraps up cleanly — finishing the current task, summarizing what was done, and noting what remains — instead of getting cut off mid-work or burning through an unlimited budget.

## Why Users Would Want It

Uncapped autonomous runs are a cost anxiety nightmare. Users either hover over the run watching spend, or they let it go and get surprised by the bill. A budget gives users a simple contract: "spend up to $2 on this task." The agent stays fully autonomous within that budget — no approval gates, no interruptions — but it finishes responsibly when the budget runs low, like a contractor tracking billable hours.

## MVP Shape

- `--budget <amount>` sets a dollar budget for the run (e.g., `--budget 2.00`). `--token-budget <n>` sets a raw token limit as an alternative.
- The cost tracker (from idea 04) feeds running totals to the orchestrator. When spend reaches 80% of the budget, the controller's next prompt includes a "budget warning" instructing it to prioritize wrapping up.
- At 95%, the orchestrator injects a hard wind-down instruction: finish the current subtask, write a summary of remaining work, and stop.
- The run's final event includes a `budget_used` field so the user sees exactly what was spent.
- Budget status is visible in the live cost display throughout the run.

## Why It Fits cc-manager

The orchestrator in `src/orchestrator.js` already controls what the controller receives each turn. Budget management adds a conditional prompt injection at two thresholds — that is it. Combined with the cost tracker reading token usage from `src/claude.js` streaming events, the entire feature is a feedback loop between existing components with no new external dependencies.

## Implementation Notes

- Add `src/budget.js` with `create(limit, type)`, `update(tokenCount)`, `status()` returning `{ used, remaining, percentage, warning }`.
- `src/orchestrator.js` consults `budget.status()` before each controller turn. At 80%, it appends a budget warning to the controller prompt. At 95%, it appends a wind-down instruction.
- `src/cli.js` accepts `--budget` and `--token-budget` flags. Budget config can also be set in `CCMANAGER.md` as a default for all runs.
- Budget status is included in `manifest.json` on run completion: `{ budgetLimit, budgetUsed, budgetType }`.
