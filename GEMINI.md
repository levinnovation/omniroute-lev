# GEMINI.md

> **Single source of truth:** all project rules for AI assistants live in
> [`AGENTS.md`](AGENTS.md). Read it in full before any change — it contains the 23 Hard Rules,
> quality gates, code conventions, file-placement / repo-root hygiene rules, the repository map
> and the local development access notes that used to live in this file.

## LEV Fork Architecture

Before editing any web-cookie provider executor (`open-sse/executors/*-web.ts`),
read the LEV Fork Architecture section in `AGENTS.md` and
[`docs/architecture/LEV-FORK-CONSTITUTION.md`](docs/architecture/LEV-FORK-CONSTITUTION.md).
Key rules: browser-first execution order (LEV-1), composition over inheritance
(LEV-6), shared tool-call parsing via `robustWebTools.ts` (LEV-3), and real live
testing only (LEV-7).

Gemini-specific notes:

- Skills activate via the `activate_skill` tool (skill metadata is loaded at session start and
  the full content is activated on demand).
- There are no other Gemini-only rules today. Do not re-add project rules here — edit
  `AGENTS.md` instead, so every assistant sees the same instructions.
