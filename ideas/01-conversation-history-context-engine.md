# Conversation History Context Engine

## What It Is

An agent-accessible tool that lets the controller search and retrieve context from past conversations. The user can ask "what did we discuss yesterday?" or "find the chat where we fixed Windows quoting" and the agent looks it up — searching by date, time, keywords, or topic across all saved run transcripts. It can summarize matches, pull in relevant context, and even switch to a found run automatically.

## Why Users Would Want It

Past runs contain valuable context — decisions, approaches, gotchas — but today they are buried in log files nobody opens again. Users end up re-explaining the same things across sessions. With a searchable conversation history, the agent itself can look up what happened before, when you ask it to. This is not persistent memory that silently influences behavior — it is an explicit lookup the agent performs only when asked.

## MVP Shape

- A `conversation_history` tool available to the controller that accepts a query object with optional fields: `keywords`, `date_from`, `date_to`, `run_id`.
- The tool scans `transcript.jsonl` and `events.jsonl` across all runs in the state directory, matching against keywords and date/time filters. Every message carries its timestamp so the agent knows how old the information is.
- Results return a ranked list: run ID, date/time, a short summary of the run, and the matching message snippets with surrounding context.
- The agent can then offer to resume a found run via the existing `/resume` flow, or simply use the retrieved context to inform the current conversation.
- `/history <query>` in the shell lets the user trigger a search directly.

## Why It Fits cc-manager

Runs already persist full transcripts with timestamps in `.cc-manager/runs/`. The controller already receives tools via its system prompt. This adds one more tool that reads existing artifacts — no new data collection, just a retrieval layer over what is already saved.

## Implementation Notes

- Add `src/history.js` with `search(stateDir, { keywords, dateFrom, dateTo })` that iterates run directories, reads transcript files, and returns ranked matches with timestamps and snippets.
- Register the tool in `src/prompts.js` as part of the controller's available tools description, so the controller knows it can search history when the user asks about past work.
- Date/time filtering uses the timestamps already present in `events.jsonl` entries.
- Future extension: add an optional local embedding index using OpenAI embeddings and a lightweight engine like qdrant for semantic search across large histories.
