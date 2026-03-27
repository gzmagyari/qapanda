# Project Handoff Notes

## What It Is

A lightweight, repo-specific handoff document that captures key decisions, known pitfalls, and project context across runs. New runs receive this context so the controller starts with relevant background instead of rediscovering constraints every session. The notes are user-curated — the controller can suggest updates, but the user decides what sticks.

## Why Users Would Want It

Starting a fresh run in a repo you worked on yesterday means re-explaining the same context: "we use Vitest not Jest," "don't touch the legacy auth module," "the Windows path workaround is intentional." Handoff notes carry forward the small but critical details that keep runs productive from the first turn — without the user having to repeat themselves.

## MVP Shape

- A `.qpanda/handoff.md` file stores the current notes in plain markdown — readable and editable by the user at any time.
- At the end of each run, the controller suggests a handoff update: "Here is what I think the next session should know." The suggestion is shown to the user, who can accept it as-is, edit it, or dismiss it. Nothing is written without the user's sign-off.
- At the start of each run, `src/prompts.js` includes the handoff contents in the controller's system prompt under a "Project Handoff Notes" section. The controller uses them as background context.
- Shell commands: `/handoff` shows the current notes, `/handoff edit` opens them in `$EDITOR`, `/handoff clear` resets the file.

## Why It Fits qapanda

The controller already receives a system prompt assembled in `src/prompts.js` with project-level instructions from `CCMANAGER.md`. Handoff notes extend that same injection path with run-learned context. No new infrastructure — just a file and a post-run suggestion step that keeps the user in control of what gets persisted.

## Implementation Notes

- Add `src/handoff.js` with `load(stateDir)`, `append(stateDir, entry)`, and `clear(stateDir)`.
- `src/orchestrator.js` adds a post-run controller turn that generates a handoff suggestion. The suggestion is displayed via `renderer.handoffPrompt(suggestion)` and the user accepts, edits, or dismisses it.
- `src/prompts.js` calls `handoff.load()` and appends the result if non-empty.
- Cap the handoff file at a configurable size (default 3000 characters) by trimming oldest entries when the limit is exceeded.
