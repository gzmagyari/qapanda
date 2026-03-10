# Smart Model Routing

## What It Is

An "Auto" option in the worker model selector that lets the controller choose the most cost-effective worker model each time it re-launches the Claude Code CLI. Instead of picking a fixed model, the user selects "Auto (balanced)" or "Auto (economy)" and the controller decides per-launch whether the upcoming work needs a powerful model or a fast cheap one. This only applies to the worker model — the controller model stays fixed, since there is nobody above the controller to make that decision for it.

## Why Users Would Want It

Not every worker turn needs the most expensive model. A turn that runs `npm test` and reads the output does not need Opus-level reasoning. But today, every turn uses whatever model was configured at startup regardless of what the turn actually involves. Auto routing saves significant cost on routine turns while preserving quality where it matters — and it happens autonomously, with no per-turn user input.

## MVP Shape

- The worker model dropdown (both CLI `--worker-model` and VS Code UI) gains new options: `auto`, `auto-balanced`, `auto-economy` alongside the existing concrete model choices.
- When an auto mode is selected, the controller's decision JSON gains an optional `model_hint` field: `"fast"`, `"standard"`, or `"powerful"`. The orchestrator maps these hints to concrete model names when launching the next CLI process.
- Model mapping via `--model-map fast=haiku,standard=sonnet,powerful=opus` or in `CCMANAGER.md`. Sensible defaults are built in.
- The controller's system prompt includes routing guidelines: fast for single-purpose turns (tests, reads, small patches), standard for typical multi-step coding, powerful for large-scope refactors or complex reasoning.
- If the controller omits `model_hint`, the strategy's default tier is used (balanced defaults to standard, economy defaults to fast).

## Why It Fits cc-manager

The worker CLI is already re-launched on each loop iteration by `src/orchestrator.js`, passing `--worker-model` to `src/claude.js`. Auto routing makes that flag dynamic per-launch based on the controller's judgment. This does not try to switch models mid-turn — it respects that each CLI launch runs many internal steps. The routing decision happens at the natural boundary where the orchestrator already configures the next spawn. The controller is the only entity that can make this call, which is why it only works for the worker model.

## Implementation Notes

- Extend `src/schema.js` to include an optional `model_hint` in the controller decision.
- Add `src/model-router.js` with `resolve(hint, modelMap, strategy)` returning the concrete model name. When `--worker-model` is not an auto variant, the router is a no-op passthrough.
- `src/orchestrator.js` calls `modelRouter.resolve()` before each worker spawn and passes the result as `--model` to `src/claude.js`.
- The VS Code extension's webview model dropdown in `webview/main.js` includes the auto options. `extension/session-manager.js` passes the selection through to the orchestrator.
- Pairs well with the live cost display (idea 04): the cost tracker can show which model was used per-turn so users see the savings.
