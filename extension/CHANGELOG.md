# Changelog

All notable user-facing changes for the VS Code extension are documented here in the order they were added.

## 2026-04-24

- Added lower-cost **BYOK/API sessions** with **prompt caching**, native/manual compaction, compact tool replay, and batched QA/test/task updates.
- Added **custom API providers** with custom base URLs and API keys for local or self-hosted models.
- Added built-in **Git review** actions in the input bar for unstaged, staged, or combined diffs.
- Added **image attachments** in chat via paste, drag-and-drop, and file picker, with backend support across Codex and API mode.
- Added a per-agent **Browser** toggle so any agent can be given Chrome DevTools access for the current run.
- Added **external chat import** for Codex sessions, plus replay/restore support for those imported chats.
- Added a **VS Code Activity Bar launcher sidebar** with new session, resume latest, and recent session restore flows.
- Added **GPT-5.5** to the supported Codex model catalog.
- Added reusable **Panda Tests** and the new markdown-based test runner flow for structured QA coverage.
- Added hosted/cloud sync, workflow, and workspace groundwork behind feature flags; the extension cloud UI is now hidden by default for the marketplace build.
- Fixed major stability issues across browser page binding, screenshot replay symmetry, huge-run restore, compaction visibility, agent browser toggles, agent editing, and Continue controller target locking.

## 2026-04-03

- 🧠 Added built-in **App Info** plus agent-maintained **Memory** so agents can start with your app facts, update what they learn automatically, and reuse that context in later sessions.

## 2026-04-01

- 🔥 Added full **BYOK API mode** with curated provider/model support for OpenAI, Gemini, Anthropic, and OpenRouter.
- 🔐 Kept **Codex + your ChatGPT subscription** as the primary no-key-required path.
- 📸 Fixed browser screenshot memory for API mode so later turns can reason about earlier screenshots correctly.
- ⚡ Added proper live MCP/tool cards for API-based runs.
- 🧪 Added live QA progress cards plus cleaner final test summaries.
- 📋 Added a unified **QA Report** card with `This Run` and `This Session` views.
- 📤 Added QA Report actions for copying single items, bulk copying tests/issues, and **Export PDF**.
- 🎨 Upgraded QA Report PDF export with styled, color-coded output.
- 🏷️ Renamed user-facing **Tasks** to **Issues** across the UI.
- 🔢 Added clearer test/issue IDs with short numeric badges plus raw IDs across cards, tabs, reports, and detail views.
- ✂️ Added proper copy buttons across chat messages, cards, overlays, tests, issues, and QA reports.
- 🧠 Added automatic context compaction plus manual `/compact` for long sessions.
- 🪶 Tightened compaction so older history is summarized, older images are dropped, and only the latest image context is preserved.
- 🐼 Added the animated panda beside the chat input.
