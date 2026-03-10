# Scope Boundaries

> **Deferred.** We do not yet have true filesystem-level enforcement. The current approach relies on prompt instructions and tool restriction flags, which are not strong enough to back the UX promise of hard boundaries. Revisit once we can enforce scope at the filesystem or process level rather than relying on the model to comply.

## What It Is

Declarative rules that define where the agent can and cannot operate within the repository — which directories are writable, which files are off-limits, which commands are allowed. The agent stays fully autonomous within the defined scope, but structurally cannot wander into areas the user wants protected. No approval prompts — just hard boundaries.

## Why Users Would Want It

Full autonomy is powerful, but not every part of a repo should be fair game for every task. A user asking the agent to refactor the API layer does not want it touching the database migration files or the CI config. Today, the only guard is the prompt ("don't touch X"), which models sometimes ignore. Scope boundaries enforce limits structurally so the user can grant full autonomy confidently, knowing certain areas are simply unreachable.

## MVP Shape

- A `.cc-manager/scope.json` file defines boundaries:
  ```json
  {
    "writable": ["src/", "tests/"],
    "readonly": ["migrations/", "infrastructure/"],
    "blocked": [".env", "secrets/"],
    "allowed_commands": ["npm test", "npm run build", "git status"]
  }
  ```
- The orchestrator reads the scope config and translates it into worker constraints: `--allowedTools` rules, `--disallowedTools` patterns, and a system prompt addendum listing the boundaries.
- Scope can also be set per-run via `--scope <path>` or inline: `--writable "src/,tests/"`.
- The controller's system prompt includes the scope rules so it avoids delegating out-of-scope work in the first place.

## Why It Fits cc-manager

The worker already supports `--allowedTools`, `--disallowedTools`, and `--worker-tools` flags configured in `src/claude.js`. Scope boundaries translate a user-friendly directory/file specification into those existing tool restriction flags. The controller prompt in `src/prompts.js` already accepts dynamic content — scope rules are one more injected block. No new enforcement mechanism, just a better interface to existing controls.

## Implementation Notes

- Add `src/scope.js` with `load(stateDir, overrides)` that reads `.cc-manager/scope.json` and CLI flags, and `toWorkerFlags()` that converts the scope into `--allowedTools` and `--disallowedTools` arguments.
- `src/orchestrator.js` calls `scope.load()` at run start and passes `scope.toWorkerFlags()` to `src/claude.js` when spawning the worker.
- `src/prompts.js` includes scope rules in the controller's system prompt: "You may only modify files in: src/, tests/. The following are off-limits: migrations/, .env."
- `src/cli.js` accepts `--scope`, `--writable`, and `--blocked` flags. Per-workflow scope can be defined in workflow frontmatter.
