# cc-manager

`cc-manager` is an interactive terminal app that puts a **controller agent** (Codex CLI) in front of **Claude Code**.

The visible loop is:

1. **User** sends a message in the shell.
2. **Controller** (Codex) decides whether to:
   - reply directly and stop, or
   - launch **Claude Code** with the next worker prompt.
3. **Claude Code** runs and its output is streamed live in the terminal.
4. When Claude finishes, the **Controller** runs again, reviews the result and repository state, and decides the next Claude message or emits **STOP**.
5. The shell stays open after **STOP** and waits for the next user instruction.

That makes the controller behave like a developer using Claude Code on behalf of the human manager.

## What this implementation guarantees

- The shell remains open after `STOP`.
- The controller can answer simple messages directly without launching Claude Code.
- When the controller delegates, the app prints the exact Claude prompt it is sending.
- Claude output is streamed in real time.
- After Claude exits, the controller gets another turn and can inspect the repository before deciding the next step.
- The same Claude session is reused across worker turns in the same run.
- Runs are persisted under `.cc-manager/runs/<run-id>` and can be resumed later.

## Install

```bash
npm install
npm link
```

Node 18.17+ is required.

## Interactive shell

Start the shell in the repository you want to manage:

```bash
cd /path/to/repo
cc-manager
```

You can also point it at another repo/state directory:

```bash
cc-manager --repo /path/to/repo --state-dir /path/to/state
```

### Shell behavior

- If no run is attached, plain text starts a new run.
- If a run is attached, plain text becomes the next user message for that run.
- After the controller emits `STOP`, the shell stays attached to the run and waits for the next message.

### Shell commands

```text
/help                Show help
/new <message>       Start a brand new run and send the first message
/resume <run-id>     Attach to an existing run
/use <run-id>        Alias for /resume
/run                 Continue an interrupted request in the current run
/status              Show status for the attached run
/list                List saved runs
/logs [n]            Show the last n event lines for the attached run
/workflow [name]     List or run a workflow
/detach              Detach from the current run
/quit                Exit the shell
```

## One-shot usage

Start a new run, process until `STOP`, then exit:

```bash
cc-manager run "Please do fixes in this repository until all unit tests pass"
```

Resume an existing run with another user message:

```bash
cc-manager resume <run-id> "Good job. Thank you"
```

Show run status:

```bash
cc-manager status <run-id>
```

Show recent events:

```bash
cc-manager logs <run-id> --tail 80
```

List runs:

```bash
cc-manager list
```

Verify binaries:

```bash
cc-manager doctor
```

## Important defaults

### Controller (Codex)

By default the controller uses:

- `codex exec`
- `codex exec resume <session-id>` after the first controller turn
- `--json`
- `--output-schema`
- `--output-last-message`
- `--ask-for-approval never`
- `--sandbox workspace-write`

The controller prompt explicitly tells Codex to **inspect and verify only** and to avoid editing files itself. Claude Code is the worker that performs actual repository changes.

### Worker (Claude Code)

By default the worker uses:

- `claude -p`
- `--output-format stream-json`
- `--verbose`
- `--include-partial-messages`
- `--session-id <uuid>` for the first worker turn
- `--resume <session-id>` on later worker turns
- `--allowedTools "Bash,Read,Edit"`
- a default appended system prompt that encourages concise progress narration

## Useful options

```text
--repo <path>
--state-dir <path>
--codex-bin <path>
--claude-bin <path>
--controller-model <name>
--controller-profile <name>
--controller-sandbox <read-only|workspace-write|danger-full-access>
--controller-config <key=value>            repeatable
--controller-skip-git-repo-check
--controller-extra-instructions <text>
--worker-model <name>
--worker-session-id <uuid>
--worker-allowed-tools <rules>
--worker-tools <rules>
--worker-disallowed-tools <rules>
--worker-permission-prompt-tool <name>
--worker-max-turns <n>
--worker-max-budget-usd <amount>
--worker-add-dir <path>                    repeatable
--worker-append-system-prompt <text>
--raw-events
--quiet
```

## Saved run layout

Each run is stored under:

```text
.cc-manager/
  runs/
    <run-id>/
      manifest.json
      controller-decision.schema.json
      events.jsonl
      transcript.jsonl
      requests/
        req-0001/
          loop-0001/
            controller.prompt.txt
            controller.stdout.log
            controller.stderr.log
            controller.final.json
            worker.prompt.txt
            worker.stdout.log
            worker.stderr.log
            worker.final.json
```

## Workflows

Place workflow directories in `.cc-manager/workflows/` (project-level) or `~/.cc-manager/workflows/` (global). Each directory must contain a `WORKFLOW.md` with YAML frontmatter:

```yaml
---
name: autonomous-dev
description: Run the autonomous dev loop
---

Step-by-step instructions here...
```

Project-level workflows take precedence over global ones with the same name. Use `/workflow` in the shell to list available workflows, or `/workflow <name>` to run one.

## Tests

This repo includes fake Codex and Claude binaries plus integration tests that verify the exact visible control loop:

- greeting -> controller replies directly -> `STOP`
- real work -> controller delegates -> Claude streams -> controller reviews -> controller delegates again -> `STOP`
- follow-up user message on the same run -> controller replies directly -> `STOP`

Run them with:

```bash
npm test
```
