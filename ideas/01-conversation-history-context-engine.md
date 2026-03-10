# Conversation History Context Engine

## What It Is

An on-demand lookup tool that lets the controller search past conversations when the user explicitly asks. The user can say "what did we discuss yesterday?" or "find the chat where we fixed Windows quoting" and the controller searches by date, time, keywords, or topic across all saved run transcripts. It returns matches with summaries and context so the user can decide what to do with them. This is not persistent memory, not auto-discovery, and not background context gathering — it is a deliberate search the user or controller invokes when needed.

## Why Users Would Want It

Past runs contain valuable context — decisions, approaches, gotchas — but today they are buried in log files nobody opens again. Users end up re-explaining the same things across sessions. With a searchable conversation history, the agent itself can look up what happened before, when you ask it to. This is not persistent memory that silently influences behavior — it is an explicit lookup the agent performs only when asked.

## MVP Shape

- A `conversation_history` tool available to the controller that accepts a query object with optional fields: `keywords`, `date_from`, `date_to`, `run_id`.
- The tool scans `transcript.jsonl` and `events.jsonl` across all runs in the state directory, matching against keywords and date/time filters. Every message carries its timestamp so the agent knows how old the information is.
- Results return a ranked list: run ID, date/time, a short summary of the run, and the matching message snippets with surrounding context.
- The controller presents matches to the user, who can then choose to resume a found run via the existing `/resume` flow or ask the controller to pull in specific context.
- `/history <query>` in the shell lets the user trigger a search directly.

## Why It Fits cc-manager

Runs already persist full transcripts with timestamps in `.cc-manager/runs/`. The controller already receives tools via its system prompt. This adds one more tool that reads existing artifacts on demand — no background indexing, no silent context injection, just a retrieval layer the controller uses when the user asks for it.

## Implementation Notes

- Add `src/history.js` with `search(stateDir, { keywords, dateFrom, dateTo })` that iterates run directories, reads transcript files, and returns ranked matches with timestamps and snippets.
- Register the tool in `src/prompts.js` as part of the controller's available tools description, so the controller knows it can search history when the user asks about past work.
- Date/time filtering uses the timestamps already present in `events.jsonl` entries.
- Future extension: add an optional local embedding index using OpenAI embeddings and a lightweight engine like qdrant for semantic search across large histories.
