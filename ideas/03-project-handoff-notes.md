# Project Handoff Notes

## What It Is

A lightweight, repo-specific handoff document that cc-manager maintains across runs. It records current goals, key decisions, and known pitfalls. New runs automatically receive this context so the controller starts with relevant background instead of rediscovering constraints every session.

## Why Users Would Want It

Starting a fresh run in a repo you worked on yesterday means re-explaining the same context: "we use Vitest not Jest," "don't touch the legacy auth module," "the Windows path workaround is intentional." Handoff notes carry forward the small but critical details that keep runs productive from the first turn — without the user having to repeat themselves.

## MVP Shape

- A `.cc-manager/handoff.md` file stores the current notes in plain markdown — readable and editable by the user at any time.
- At the end of each run, the controller is prompted: "What should the next session know?" Its response is appended as a dated entry. This happens automatically as part of the run wind-down — no user interaction needed.
- At the start of each run, `src/prompts.js` includes the handoff contents in the controller's system prompt under a "Project Handoff Notes" section. The controller uses them as background context silently.
- Shell commands: `/handoff` shows the current notes, `/handoff edit` opens them in `$EDITOR`, `/handoff clear` resets the file.

## Why It Fits cc-manager

The controller already receives a system prompt assembled in `src/prompts.js` with project-level instructions from `CCMANAGER.md`. Handoff notes extend that same injection path with run-learned context. No new infrastructure — just a file and one extra post-run controller turn that runs autonomously.

## Implementation Notes

- Add `src/handoff.js` with `load(stateDir)`, `append(stateDir, entry)`, and `clear(stateDir)`.
- `src/orchestrator.js` adds a post-run controller turn with the transcript summary, asking for handoff-worthy notes. The response is passed to `handoff.append()` automatically.
- `src/prompts.js` calls `handoff.load()` and appends the result if non-empty.
- Cap the handoff file at a configurable size (default 3000 characters) by trimming oldest entries when the limit is exceeded.
