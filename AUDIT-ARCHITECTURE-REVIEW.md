# OmniRoute-LEV — Architecture Audit, Code Review & Enhancement Roadmap

**Date:** 2026-09-01
**Repository:** `https://github.com/levinnovation/omniroute-lev.git`
**Branch:** `lev/main`
**Fork base:** `origin/release/v3.8.51` (upstream: `diegosouzapw/OmniRoute`)
**Production:** Railway `omniroute-llm-gateway` → `https://omniroute.agentyx.one`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Fork History — 45 Commits of Hardening](#2-fork-history--45-commits-of-hardening)
3. [Issues Experienced — Root-Cause Analysis](#3-issues-experienced--root-cause-analysis)
4. [Architecture Review](#4-architecture-review)
5. [Code Review — Provider-by-Provider](#5-code-review--provider-by-provider)
6. [Architecture Gaps](#6-architecture-gaps)
7. [Enhancement Research — Industry Best Practices 2026](#7-enhancement-research--industry-best-practices-2026)
8. [Roadmap — Taking OmniRoute-LEV to the Next Level](#8-roadmap--taking-omniroute-lev-to-the-next-level)
9. [Appendix: File Inventory & Metrics](#9-appendix-file-inventory--metrics)

---

## 1. Executive Summary

OmniRoute-LEV is a fork of the OmniRoute LLM gateway, hardened for LEV Innovation's agentic coding needs (Cursor, Cline, OpenCode, Codex, Prime Agent). Over 45 commits, the fork has addressed:

- **DeepSeek-web tool-call translation** (15+ commits) — parsing the model's ad-hoc `<tool>`, `<tool_calls>`, DSML, bare JSON, and code-fence output formats into OpenAI-compatible `tool_calls`.
- **DeepSeek-web prompt bloat** (8 commits) — schema compression, system-section truncation, user-query preservation, and budget reduction from 60K → 32K chars.
- **Z.ai-web browser transport** (6 commits) — endpoint migration, version detection, model-selection timeout, Svelte SPA input handling.
- **Perplexity-web context loss** (4 commits) — pre-gate truncation, query reordering, DSL prompt truncation.
- **Cross-cutting resilience** (7 commits) — WebSessionDriver, credential health sweeps, context-length gates, SSE watchdogs, re-auth WebSocket UI.

### Current State

| Dimension                                 | Status                     | Notes                                                                                          |
| ----------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| DeepSeek-web tool calls                   | **Stabilized**             | 15+ format variants parsed; narrated-intent retry + fallback synthesis                         |
| DeepSeek-web prompt size                  | **Stabilized**             | 32K char budget; schema compression 86% reduction                                              |
| Z.ai-web browser transport                | **Partially stabilized**   | Model-selection timeout fixed; 404 model-not-found still misclassified as rate-limited         |
| Perplexity-web                            | **Stabilized**             | Pre-gate truncation + query reordering                                                         |
| Generic OpenAI-compatible prompt overflow | **Not fixed**              | 122K tokens sent to 32K-limit model; no universal compression/truncation for API-key providers |
| SSE streaming reliability                 | **Adequate**               | Heartbeats exist but not universally wired; Railway 5-min idle cutoff not handled              |
| Architecture cohesion                     | **Needs work**             | 54+ web-cookie executors with duplicated session/cookie logic                                  |
| Test coverage                             | **Good for DeepSeek/Z.ai** | 23 DeepSeek test files, 16 Z.ai test files; other web providers less covered                   |
| Deployment                                | **Working**                | Railway Docker build, health checks, auto-deploy from `lev/main`                               |

### Top 5 Risks

1. **Web-cookie provider fragility** — 54+ executors each re-implement cookie extraction, session refresh, and error classification. A single provider UI change breaks one executor at a time.
2. **No proactive cookie refresh** — Cookies are refreshed after `401`/empty-content, not at 75% of lifetime. Users experience silent failures before refresh kicks in.
3. **Error misclassification** — Z.ai 404 model-not-found is classified as "rate limited," locking out the account for 120s. DeepSeek empty-stream is emitted as assistant `content`, not a structured error.
4. **Railway SSE idle cutoff** — Railway closes connections after 5 minutes of no data. Heartbeats exist but are disabled by default (`OMNIROUTE_SSE_COMMENTS=off`).
5. **Hardcoded magic numbers** — Prompt budgets, drain delays, cache sizes, version strings, and selectors are hardcoded. Provider UI/version changes require code changes and redeployment.

---

## 2. Fork History — 45 Commits of Hardening

### Phase 1: Foundation (commits `7b1b333` → `b3197d6`)

| Commit    | Description                                                                        |
| --------- | ---------------------------------------------------------------------------------- |
| `7b1b333` | `feat(docker): add Railway-optimized Dockerfile for building from source`          |
| `478b42f` | `feat(web-session): add WebSessionDriver and integrate into zai-web executor`      |
| `06ef5ef` | `feat(web-session): integrate WebSessionDriver into all 4 remaining web providers` |
| `b3197d6` | `feat(credential-health): 2-minute sweep interval for web-cookie providers`        |

**Impact:** Established the `WebSessionDriver` pattern for cookie-based session validation, stream watchdogs, and credential health sweeps. Created a Railway-ready Dockerfile.

### Phase 2: Re-Auth & Deployment (commits `9c7964f` → `32fd9c5`)

| Commit    | Description                                                                     |
| --------- | ------------------------------------------------------------------------------- |
| `9c7964f` | `test(web-session): add unit tests for WebSessionDriver and zai-web regression` |
| `68d5bb5` | `feat(re-auth): WebSocket-based re-authentication API and dashboard UI`         |
| `4ff63fc` | `chore(docker): make Railway Dockerfile the primary Dockerfile`                 |
| `1a4cd6c` | `chore: trigger Railway rebuild from fork source`                               |
| `32fd9c5` | `fix(re-auth): import getCachedProviderConnectionById from readCache`           |

**Impact:** Enabled in-dashboard re-authentication for expired web-cookie sessions via WebSocket.

### Phase 3: Z.ai Transport Fixes (commits `704b4c8` → `bbb4917`)

| Commit    | Description                                                                           |
| --------- | ------------------------------------------------------------------------------------- |
| `704b4c8` | `fix(zai-web): update browser transport for Z.ai's new /api/v1/chats/new endpoint`    |
| `bbb4917` | `fix(zai-web): use /api/chat/completions endpoint and detect version error in stream` |

**Impact:** Z.ai migrated from `/api/v2/chat/completions` to `/api/chat/completions` and introduced a chat-creation step (`/api/v1/chats/new`). The fork adapted to extract the chat ID from the browser-created chat and make a direct completion fetch.

### Phase 4: DeepSeek Tool-Call Translation (commits `72a878a` → `a0e357e`)

| Commit    | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| `72a878a` | `fix(deepseek-web): parse <tool_calls> wrapper format into OpenAI tool_calls` |
| `fba8205` | `fix(deepseek-web): handle DSML hybrid tool_call wrapper variant`             |
| `c972c39` | `fix(deepseek-web): parse bare JSON tool calls without XML wrapper`           |
| `1990599` | `fix(deepseek-web): strip unclosed/empty <tool_calls> wrappers`               |
| `1ac4ffa` | `fix(deepseek-web): strip markdown \`\`\`tool code fences from content`       |
| `a0e357e` | `fix(deepseek-web): validate tool call arguments to prevent empty responses`  |

**Impact:** DeepSeek-web's free chat interface emits tool calls in at least 6 different formats. The fork built a multi-format parser that tries: canonical `<tool>` tags → `<tool_calls>` wrapper → DSML → bare JSON → code fences → schema-based nameless fallback.

### Phase 5: Cross-Provider Fixes (commits `77ca23f` → `652ad10`)

| Commit    | Description                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------- |
| `77ca23f` | `fix: gemini-web timeout, zai-web version outdated, openrouter free-model 504, deepseek tool prompt` |
| `353fcc2` | `fix: zai-web browser transport version, qwen-web empty content, perplexity-web context loss`        |
| `23e8111` | `fix(perplexity-web): truncate system prompt and dsl_query to avoid input token limit exceeded`      |
| `bf2a4d6` | `fix(perplexity-web): add pre-gate message truncation for oversized Cursor requests`                 |
| `4eca37f` | `fix(browser-transport): use evaluate-based input for Svelte SPAs to fix fill timeout`               |
| `7e6fd71` | `fix(qwen-web,perplexity-web): SSE phase parsing, streaming watchdog, Cursor context folding`        |
| `652ad10` | `fix(perplexity-web): put actual user query before IDE context to survive truncation`                |

**Impact:** Fixed Svelte SPA `locator.fill()` hangs by switching to `page.evaluate()`-based input. Added streaming watchdogs and context folding for Qwen and Perplexity.

### Phase 6: DeepSeek Prompt Management (commits `f70f2fc` → `b979093`)

| Commit     | Description                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| `f70f2fc`  | `fix(deepseek-web): truncate tool conversation prompt and add empty-content watchdog`    |
| `e476eef`  | `fix(deepseek-web): detect narrated tool intent and retry with corrective nudge`         |
| `72925142` | `fix(deepseek-web): lower prompt limit to 80K and use minimal retry for narrated intent` |
| `2cbf95f`  | `fix(deepseek-web): preserve actual user question when truncating large prompts`         |
| `efae98d`  | `fix(deepseek-web): replace alarming truncation marker with informative system note`     |
| `6b6ce1d`  | `fix(deepseek-web): extract user_query tag content directly for robust preservation`     |
| `a447090`  | `fix(deepseek-web): detect bare JSON tool calls with nested braces`                      |
| `b979093`  | `fix(deepseek-web): preserve browser_element blocks in extracted user query`             |

**Impact:** Built the prompt-truncation pipeline that preserves the user's actual query (`<user_query>` tag), truncates the Cursor IDE system context, and detects when DeepSeek narrates a tool intent without emitting a tool block.

### Phase 7: DeepSeek Narrated-Intent & Fallback (commits `0c5834d` → `a3f9eea`)

| Commit    | Description                                                                        |
| --------- | ---------------------------------------------------------------------------------- |
| `0c5834d` | `fix(deepseek-web): improve narrated-intent retry and add fallback tool synthesis` |
| `13af9d0` | `fix(deepseek-web): auto-close truncated bare JSON tool calls at end-of-text`      |
| `a3f9eea` | `fix(deepseek-web): detect narrated intent at end of long content via tail check`  |

**Impact:** When DeepSeek says "I'll check the file..." without emitting a `<tool>` block, the fork detects this, retries with a corrective nudge, and if that fails, synthesizes a `Grep` tool call from the user query to keep the agent loop alive.

### Phase 8: Final Hardening (commits `7225962` → `c62c521`)

| Commit    | Description                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `7225962` | `fix(deepseek-web): compress tool schemas and truncate system section to prevent empty-stream failures` |
| `aaf93ec` | `fix(deepseek-web,zai-web): aggressive schema compression + zai model selection timeout`                |
| `c62c521` | `fix(deepseek-web): reduce prompt limit to 32K and system section to 12K`                               |

**Impact:** Schema compression reduced tool prompt from 60K → 8K chars (86% reduction). Prompt budget reduced from 60K → 32K chars. Z.ai model-selection timeout increased from 5s → 10s.

---

## 3. Issues Experienced — Root-Cause Analysis

### 3.1 DeepSeek-web: Empty Stream on Oversized Prompts

**Symptom:** DeepSeek-web returns HTTP 200 but no SSE content. OmniRoute logs:

```
prompt_len=71384, tool_sys_prompt_len=60253, messages_count=10
Completion response in 839ms, status=200
Stream ended before producing a non-ping SSE event
deepseek-web/deepseek-v4-pro closed the stream early before useful content — retrying once
```

**Root cause:** Cursor sends 20+ tool definitions with verbose JSON schemas. The serialized DeepSeek tool prompt was 60K chars. DeepSeek's free web chat interface has a much lower practical input limit (~8K tokens ≈ 32K chars) than its API. The oversized prompt caused DeepSeek to accept the request but return an empty stream.

**Fix trajectory:**

1. Schema compression (60K → 8K tool prompt) — commit `7225962`
2. System-section truncation (preserve tool protocol, truncate Cursor IDE context) — commit `7225962`
3. Prompt budget reduction (60K → 32K total, 12K system) — commit `c62c521`

**Remaining risk:** The 32K char budget is character-based, not token-based. A request with many multi-byte characters (CJK, emoji) could still exceed the token limit. The `0.3/0.7` budget split for older vs. recent context is arbitrary.

### 3.2 DeepSeek-web: Tool-Call Format Zoo

**Symptom:** DeepSeek-web emits tool calls in 6+ different formats:

- `<tool>{"name":"...","arguments":{...},"_nonce":"..."}</tool>` (canonical)
- `<tool_calls><tool>...</tool></tool_calls>` (wrapper)
- `<tool_calls><call name="...">...</call></tool_calls>` (DSML)
- `{"name":"...","arguments":{...}}` (bare JSON)
- ` ```tool\n{...}\n``` ` (code fence)
- `<tool_name="...">...</tool_name>` (name attribute)

**Root cause:** DeepSeek's free web model is not fine-tuned for structured tool output. It improvises formats based on the prompt, conversation context, and model version.

**Fix:** Built a multi-format parser (`parseDeepSeekToolCalls`) that tries each format in order, with a schema-based nameless fallback (`#5154`) and nonce validation (`#9343`).

**Remaining risk:** The parser's permissiveness creates false-positive risk. `parseBareJsonToolCalls` scans every `{` in the response with a 200-char lookahead — deeply nested JSON can be miscounted.

### 3.3 DeepSeek-web: Narrated Tool Intent

**Symptom:** DeepSeek says "I'll check the file..." or "Let me search for..." but never emits a `<tool>` block. The agent loop stalls because no tool call is returned.

**Root cause:** DeepSeek's web model sometimes narrates its plan instead of executing it, especially when the tool prompt is complex or the model is uncertain.

**Fix:** Built `looksLikeNarratedIntent` regex detector + retry with corrective nudge + fallback `Grep` tool synthesis (commits `e476eef`, `0c5834d`, `a3f9eea`).

**Remaining risk:** The regex is English-only. The stop-word list is arbitrary. The synthesized `Grep` call can trigger an irrelevant file search.

### 3.4 Z.ai-web: Model Selection Timeout

**Symptom:**

```
Z.ai browser transport failed (502; capture 0ms, total 13248ms):
browserBackedChat failed:
model selection: locator.waitFor: Timeout 5000ms exceeded.
```

**Root cause:** Z.ai's dropdown menu took >5s to render after click, especially under load. The Playwright `locator.waitFor` timeout was 5s.

**Fix:** Increased model-selection menu and confirmation timeouts from 5s → 10s (commit `aaf93ec`).

### 3.5 Z.ai-web: 404 Model-Not-Found Misclassified as Rate-Limited

**Symptom:**

```
model not found (404) for GLM-5V-Turbo - locking model for 120s
zai-web | all 1 active accounts rate limited
reset after 1m 37s
lastErrorCode=404.0
```

**Root cause:** Z.ai returned `404 {"detail":"Not Found"}` for `GLM-5v-Turbo` (likely the model was renamed or unavailable). OmniRoute's account selector classified this as "rate limited" and locked the only active account for 120s, blocking all subsequent Z.ai requests including for `glm-5.2`.

**Fix:** Not yet fixed. The account cooldown logic needs to distinguish 404 (model not found) from 429 (quota exceeded) and not lock the account for a model-level error.

### 3.6 Z.ai-web: Client Version Outdated

**Symptom:** Z.ai returns `[Z.ai error] Your client version (unknown) is outdated.` in a 200 response.

**Root cause:** Z.ai's completions endpoint requires `fe_version` and `client_version` query parameters. Without them, it rejects the request.

**Fix:** Added `resolveFrontendVersion` and `resolveClientVersion` that scrape the Z.ai homepage HTML for `prod-fe-*` and version strings, with a 15-minute cache (commits `77ca23f`, `353fcc2`).

**Remaining risk:** Version cache is module-level. In a multi-worker environment, each worker has its own cache. If Z.ai increments versions, all workers serve stale versions for up to 15 minutes.

### 3.7 Perplexity-web: Input Token Limit Exceeded

**Symptom:** Perplexity-web returns `input token limit exceeded` for Cursor requests.

**Root cause:** Cursor sends large system prompts with IDE context, code citations, and formatting rules. Perplexity's free web tier has a lower input limit.

**Fix:** Pre-gate message truncation + system prompt truncation + DSL query truncation + user query reordering (commits `23e8111`, `bf2a4d6`, `652ad10`).

### 3.8 Browser Transport: Svelte SPA Fill Timeout

**Symptom:** `locator.fill()` hangs for 30s on Svelte-based SPAs (Z.ai, Perplexity).

**Root cause:** Svelte's reactivity model doesn't always react to Playwright's synthetic `input` events. `locator.fill()` waits for the input event to be processed, which never fires.

**Fix:** Switched to `page.evaluate()`-based input that directly mutates `textarea.value` and dispatches synthetic `input`/`change` events (commit `4eca37f`).

### 3.9 Gemini: Quota Exceeded + Failed Fallback

**Symptom:**

```
Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count
```

OmniRoute attempted emergency fallback to NVIDIA but had no NVIDIA credentials, resulting in 401.

**Root cause:** Gemini free tier quota exhausted. Fallback target (NVIDIA) was not configured with credentials.

**Fix:** Not a code fix — operational configuration issue. Need to either provision NVIDIA credentials or remove it as a fallback target.

### 3.10 OpenAI-Compatible Provider: Input Token Limit Exceeded (Agentic Prompt Bloat)

**Symptom:**

```
PROVIDER: OPENAI-COMPATIBLE-CHAT-02F3E7D5-94E4-49CC-ABF2-1DA7E50357A6
TARGET: openai-compatible-chat-02f3e7d5-94e4-49cc-abf2-1da7e50357a6/qwen2.5-vl-72b
ERROR: Input exceeds maximum input tokens for openai-compatible-chat-02f3e7d5-94e4-49cc-abf2-1da7e50357a6/qwen2.5-vl-72b:
       estimated 122421 input tokens, max input 32768. Reduce the prompt or route to a model with a larger input limit.
LATENCY: 107ms
```

**Root cause:** This is the same fundamental class of problem as issue 3.1 (DeepSeek-web oversized prompts) and 3.7 (Perplexity-web input token limit), but on an API-key OpenAI-compatible provider rather than a web-cookie provider. An agentic client (Cursor/Cline) sent a request with ~122K estimated input tokens to a `qwen2.5-vl-72b` model with a 32K input limit — nearly 4x the limit. The request was rejected at the gateway's input-token gate (107ms latency, pre-dispatch).

The 122K token payload comes from the same source as the DeepSeek 71K-char prompt: Cursor sends 20+ tool definitions with verbose JSON schemas, full IDE context, code citations, formatting rules, and multi-turn conversation history. The gateway's context-length gate correctly detected the oversized input and refused to dispatch, but:

1. **No automatic truncation/compression was applied** for this provider class. The DeepSeek-web and Perplexity-web executors have custom prompt-truncation pipelines, but generic OpenAI-compatible providers rely only on the input-token-cap gate, which rejects without remediation.
2. **No fallback routing** was triggered. The combo engine could have routed to a model with a larger context window (e.g. a 128K model), but the request was a single-model dispatch, not a combo.
3. **The error message is correct but unhelpful to the agentic client.** Cursor/Cline cannot interpret "Reduce the prompt or route to a model with a larger input limit" — they just see a failed request and may retry the same oversized prompt.

**Fix:** Not yet implemented. This requires a cross-cutting solution (see Roadmap Phase 3):

1. **Universal pre-gate prompt compression** — Apply the existing `open-sse/services/compression/` pipeline (lite + rtk strategies) to all providers, not just web-cookie ones. Set `autoTriggerTokens` to 70-80% of the target model's context window.
2. **Universal prompt truncation for agentic sessions** — Generalize the DeepSeek-web `buildToolConversationPrompt` truncation logic (schema compression, system-section truncation, user-query preservation) into a shared pre-executor transform for all providers receiving tool-bearing requests.
3. **Combo fallback on input-overflow** — When the input-token gate rejects a request, automatically retry with a combo fallback to a model with a larger context window (e.g. `qwen2.5-vl-72b` → `qwen2.5-72b-instruct` with 128K, or `deepseek-v4-pro` with 128K).
4. **Token-aware budgeting** — Switch from character-based budgets to token-based budgets using the provider's tokenizer, so multi-byte content is accurately measured.

**Remaining risk:** Even with compression and truncation, some agentic sessions accumulate so much context (100+ turns with tool results) that no amount of compression fits within a 32K limit. The gateway must either:

- Route to a larger-context model automatically, or
- Implement aggressive context compaction (replace old tool results with `[COMPACTED]` stubs), or
- Return a structured error that the agentic client can interpret as "start a new session."

### 3.11 Railway Startup: Missing Table

**Symptom:** `no such table: compression_run_telemetry`

**Root cause:** A database migration for compression telemetry was not applied before the cleanup job ran.

**Fix:** Cleanup completed with one error; non-fatal. Migration ordering should be enforced in the Dockerfile `CMD`.

---

## 4. Architecture Review

### 4.1 High-Level Architecture

```
Client (Cursor/Cline/OpenCode/Codex)
  │  OpenAI-compatible HTTP/SSE
  ▼
┌─────────────────────────────────────────────────┐
│  Next.js 16 App (src/)                          │
│  ├─ API Routes (/v1/chat/completions, etc.)     │
│  ├─ Auth, Guardrails, Skills, Memory, A2A       │
│  └─ SSE Handlers (chat.ts → chatCore.ts)        │
├─────────────────────────────────────────────────┤
│  Open-SSE Streaming Engine (open-sse/)          │
│  ├─ Handlers (chatCore, jsonBodyToSse)          │
│  ├─ Combo Routing (combo.ts — 19 strategies)    │
│  ├─ Executors (357 providers)                   │
│  │  ├─ API-key providers (OpenAI, Anthropic...) │
│  │  └─ Web-cookie providers (54+ executors)     │
│  ├─ Services (134+ modules)                     │
│  │  ├─ browserBackedChat, browserPool           │
│  │  ├─ WebSessionDriver, accountFallback        │
│  │  ├─ compression (lite, caveman, rtk)         │
│  │  └─ circuitBreaker, quotaPreflight           │
│  ├─ Translators (deepseekWebTools, etc.)        │
│  ├─ Transformers (SSE → OpenAI format)          │
│  └─ Utils (streamReadiness, sseHeartbeat)       │
├─────────────────────────────────────────────────┤
│  Data Layer                                     │
│  ├─ PostgreSQL (connections, combos, logs)      │
│  ├─ Redis (session cache, rate limits)          │
│  └─ SQLite (compression telemetry)              │
└─────────────────────────────────────────────────┘
```

### 4.2 Request Pipeline

```
POST /v1/chat/completions
  → Auth (API key → user → connections)
  → Combo resolution (strategy → target provider+model+account)
  → Pre-flight (quota check, context-length gate, prompt compression)
  → Executor dispatch (API-key fetch OR browser-cookie transport)
  → Stream readiness check (peek first SSE bytes)
  → SSE transformation (provider format → OpenAI chat.completion.chunk)
  → Tool-call translation (if tools[] present)
  → Stream watchdog (empty-content detection, heartbeat injection)
  → Client response (SSE stream + [DONE])
  → Post-request (usage logging, credential health update)
```

### 4.3 Web-Cookie Provider Architecture

```
Client request (e.g. ds-web/deepseek-v4-pro)
  → Combo resolves to deepseek-web provider
  → Account selection (token hash → pool key)
  → WebSessionDriver pre-dispatch validation
  → Two transport paths:
    ├─ Browser transport (Playwright):
    │   → acquireBrowserContext (pool reuse)
    │   → navigate to provider URL
    │   → select model, configure toggles
    │   → fill prompt (evaluate-based for Svelte)
    │   → submit, capture response
    │   → extract chat ID / SSE stream
    │   → direct fetch completion (Z.ai) OR pass-through (others)
    │
    └─ Signed API transport (Z.ai only):
        → createRemoteChat (POST /api/v1/chats/new)
        → build HMAC signature
        → direct fetch completion (POST /api/chat/completions)
  → Stream readiness + SSE transformation
  → Tool-call parsing (if tools[] present)
  → WebSessionDriver stream watchdog
  → Client response
```

### 4.4 Combo Routing Engine

The combo engine (`open-sse/services/combo.ts`) supports 19 routing strategies:

| Strategy            | Description                      |
| ------------------- | -------------------------------- |
| `priority`          | Try providers in priority order  |
| `weighted`          | Distribute by weight             |
| `round-robin`       | Rotate through providers         |
| `random`            | Random selection                 |
| `least-used`        | Pick least-recently-used         |
| `cost-optimized`    | Pick cheapest                    |
| `reset-aware`       | Respect quota reset windows      |
| `reset-window`      | Window-based reset               |
| `strict-random`     | Random with strict constraints   |
| `auto`              | Auto-select strategy             |
| `fill-first`        | Fill first available             |
| `p2c`               | Power-of-two-choices             |
| `lkgp`              | Least-connections greedy p2c     |
| `context-optimized` | Optimize for context window      |
| `context-relay`     | Relay context                    |
| `headroom`          | Pick provider with most headroom |
| `fusion`            | Fuse multiple providers          |
| `pipeline`          | Pipeline execution               |

**Architecture gap:** Strategies appear to be branches in a large function rather than pluggable modules with a common `RoutingStrategy` interface. The file has very high fan-in (imports from DB, auth, circuit breakers, quota, compression, session stickiness).

### 4.5 Resilience Runtime State

Per `AGENTS.md`:

| Layer                      | Purpose                            | Thresholds                |
| -------------------------- | ---------------------------------- | ------------------------- |
| Provider circuit breaker   | Trip on repeated failures          | Configurable per provider |
| Connection cooldown        | Per-account cooldown after failure | 30s base, 600s max        |
| Model lockout              | Per-model lockout after 404/429    | 120s default              |
| Anti-thundering-herd guard | Prevent concurrent refresh storms  | Per-key dedup             |

**Architecture gap:** The 120s model lockout is applied uniformly — a 404 (model not found) and a 429 (quota exceeded) both trigger the same lockout. This is the root cause of issue 3.5.

---

## 5. Code Review — Provider-by-Provider

### 5.1 DeepSeek-web (`open-sse/executors/deepseek-web.ts` — 1369 lines)

**Strengths:**

- Comprehensive tool-call parser handling 6+ output formats
- Narrated-intent detection with retry and fallback synthesis
- Empty-content watchdog for both streaming and non-streaming paths
- PoW (proof-of-work) challenge solver for DeepSeek's anti-bot mechanism
- Session creation/deletion with caching

**Weaknesses:**

- `resp.body!` non-null assertions in 3+ places — will throw if fetch returns null body
- `collectSSEContent` silently swallows all `JSON.parse` errors — makes debugging empty responses impossible
- `buildToolAwareResult` emits empty-response errors as assistant `content` instead of structured error responses — clients treat it as a successful message
- `deleteSessionOnDeepSeek` is fire-and-forget with empty `catch` — session leaks on failure
- `resolveModelOptions` uses hardcoded substring matching (`r1`, `think`, `pro`, `search`) — brittle as DeepSeek adds model aliases
- `generateFakeCookie` uses `Math.random()` — not cryptographically secure

**Hardcoded values that should be configurable:**

- `CACHE_MAX_SIZE = 100` (token/session cache)
- Token expiry `+ 3600` (1 hour)
- `DEFAULT_AUTO_HISTORY_WINDOW = 20`
- `DEEPSEEK_FINISHED_DRAIN_MS = 3000`
- `NARRATED_INTENT_RE` (English-only regex)
- `lastUserText.slice(0, 8_000)` (retry prompt cap)
- `FAKE_HEADERS` and User-Agent

### 5.2 DeepSeek-web Tools (`open-sse/translator/deepseekWebTools.ts` — 1294 lines)

**Strengths:**

- Recursive schema compression (86% reduction)
- `<user_query>` tag extraction preserves the actual user request
- Token-aware truncation with budget splits
- Tool artifact stripping prevents history pollution
- Per-request nonce binding (`#9343`)

**Weaknesses:**

- All budget caps are character-based, not token-based
- `extractUserQuery` silently removes code blocks >500 chars — can strip user-provided code
- `parseBareJsonToolCalls` scans every `{` with 200-char lookahead — false-positive risk
- `<tool_calls>` wrapper regex can match to end-of-string and consume trailing text
- Budget split ratios (`0.3`, `0.5`, `0.7`) are arbitrary magic numbers

**Hardcoded values:**

- `MAX_TOOL_DESC_LEN = 80`
- `MAX_TOOL_LINE_LEN = 500`
- `compressSchema` depth cap = 3
- `MAX_TOOL_RESULT_LEN = 4000`
- `MAX_PROMPT_LEN = 32000`
- `MAX_SYSTEM_SECTION_LEN = 12000`
- `browser_element` cap = 2000/1800
- Code-block strip threshold = 500

### 5.3 Z.ai-web (`open-sse/executors/zai-web.ts` — 845 lines)

**Strengths:**

- Dual transport paths (browser + signed API)
- Version detection with 15-minute cache
- Chat ID extraction from browser-created chat
- WebSessionDriver integration for pre-dispatch validation

**Weaknesses:**

- `userId = ""` in browser transport completion fetch — fragile assumption
- JSON/SSE classification via `startsWith("{")` — can misclassify error pages
- No version refresh on browser path failure — only after non-streaming response parsing
- 10 LEV fork comments document significant divergence from upstream

**Hardcoded values:**

- `ZAI_DEFAULT_FE_VERSION = "prod-fe-1.1.92"`
- `ZAI_DEFAULT_CLIENT_VERSION = "1.0.91"`
- `ZAI_USER_AGENT` (macOS Chrome 150)
- `SIGNATURE_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%"`
- `ZAI_FE_VERSION_CACHE_TTL_MS = 15 * 60 * 1000`
- `cookieDomain = "chat.z.ai"`, `locale = "en-US"`, `timezone = "Asia/Seoul"`
- 30 hardcoded query params in `buildZaiCompletionUrl` (screen 1280x800, etc.)

### 5.4 Z.ai Browser Automation (`open-sse/executors/zai-web/browserAutomation.ts` — 153 lines)

**Fragile selectors:**

- `[aria-label="Select a model"]` — breaks if ARIA label changes
- `[role="menu"]` with `hasText: modelName` — text matching is case-sensitive
- `xpath=../../../following-sibling::div//button[@data-active]` — highly fragile relative XPath
- `[data-dropdown-menu-trigger]` with `hasText: "Deep Think"` — non-standard attribute

**Race conditions:**

- Model toggle → input fill race (500ms heuristic wait)
- Evaluate-based input vs `locator.fill` race
- Submit button click fallback to `Enter` key

### 5.5 Browser-Backed Chat (`open-sse/services/browserBackedChat.ts` — 879 lines)

**Strengths:**

- Cookie polling with 5s timeout and 500ms interval
- 10MB response cap
- 45s top-level abort controller
- Cookie refresh dedup via `pendingRefreshes` Map

**Weaknesses:**

- All Playwright/DOM/timeout errors collapsed into generic 502
- `context.close()` / `browser.close()` errors silently swallowed — can leak Chromium processes
- Warmup page errors swallowed — context returned cold
- `postSubmitWaitMs` capped at 30s — long SSE streams may be cut
- No streaming through Playwright — entire body buffered

### 5.6 Browser Pool (`open-sse/services/browserPool.ts` — 541 lines)

**Strengths:**

- Shared browser instance with per-key context reuse
- 10-minute context TTL with 1-minute eviction interval
- 5-minute idle shutdown
- CloakBrowser preferred over plain Playwright for stealth

**Weaknesses:**

- CloakBrowser module ID obfuscated as `["cloak","browser"].join("")`
- `parseCookieString` always sets `secure: true`, `sameSite: "Lax"` — may not match all providers
- Close failures silently swallowed — zombie process risk
- No enforcement that context is closed on unclean process exit

### 5.7 Stream Readiness (`open-sse/utils/streamReadiness.ts` — 648 lines)

**Strengths:**

- Ping-aware deadline extension (max 3x timeout)
- Structured error detection for OpenAI, Claude, and Responses APIs
- 64KB buffered chunk re-injection
- `STREAM_EARLY_EOF` (502) and `STREAM_READINESS_TIMEOUT` (504) classification

**Weaknesses:**

- `readWithTimeout` doesn't abort the underlying `fetch` — only cancels the reader
- 64KB `MAX_BUFFERED` can truncate very large first SSE frames
- Content-bearing key list is hardcoded — must be updated for new provider formats
- No metrics/tracing for time-to-first-token or readiness duration

### 5.8 SSE Heartbeat (`open-sse/utils/sseHeartbeat.ts`)

**Strengths:**

- 15s default interval
- 4 heartbeat shapes (comment, Anthropic ping, OpenAI chunk, Responses in-progress)

**Weaknesses:**

- Comment heartbeats disabled by default (`OMNIROUTE_SSE_COMMENTS=off`)
- Not universally wired into all executors
- No Railway-specific 4-minute proactive close

---

## 6. Architecture Gaps

### 6.1 No Shared Web-Cookie Executor Base

**Problem:** 54+ web-cookie executors each re-implement cookie extraction, localStorage probes, session refresh, and error classification. `browserBackedChat` exists but executors still do their own session handling.

**Impact:** A provider UI change breaks one executor at a time. Fixes are duplicated across executors. Testing is per-executor, not shared.

**Recommendation:** Create a `WebCookieExecutorBase` adapter that centralizes:

- Cookie extraction and validation
- localStorage probing
- Session refresh (proactive, at 75% of lifetime)
- Error classification (404 vs 429 vs empty-content vs timeout)
- Stream watchdog wiring
- Heartbeat injection

### 6.2 Error Misclassification

**Problem:** The account cooldown logic treats all non-2xx responses uniformly. A 404 (model not found) triggers the same 120s lockout as a 429 (quota exceeded). DeepSeek empty-stream errors are emitted as assistant `content` instead of structured error responses.

**Impact:** A single model-not-found error locks out all models for the provider for 120s. Clients receive error messages as successful assistant messages and try to interpret them as tool output.

**Recommendation:**

- Distinguish error codes in account cooldown: 404 → model lockout only, 429 → account cooldown, 401 → session refresh, 502/504 → transient retry.
- Emit empty-response errors as structured error responses with `finish_reason: "error"`, not as assistant `content`.

### 6.3 No Proactive Cookie Refresh

**Problem:** Cookies are refreshed after `401` or empty-content detection. Users experience silent failures before the refresh mechanism kicks in.

**Impact:** Every cookie expiry causes at least one failed request before the session is restored.

**Recommendation:** Refresh cookies at 75% of known lifetime. Add `tokenExpiryEstimate` to `WebSessionHealth`. Run refresh as a background sweep, not on the request path.

### 6.4 Character-Based Prompt Budgets

**Problem:** DeepSeek prompt budgets (`MAX_PROMPT_LEN = 32000`, `MAX_SYSTEM_SECTION_LEN = 12000`) are character-based, not token-based. Multi-byte characters (CJK, emoji) can cause the token count to exceed the limit even when the character count is within budget.

**Impact:** Requests with multi-byte content can still trigger empty-stream failures.

**Recommendation:** Use a fast tokenizer-based budget (tiktoken for OpenAI-compatible, provider-specific tokenizer for web providers). Fall back to character-based only if tokenizer is unavailable.

### 6.5 Railway SSE Idle Cutoff

**Problem:** Railway closes connections after 5 minutes of no data. SSE heartbeats exist but are disabled by default (`OMNIROUTE_SSE_COMMENTS=off`) and not universally wired into all executors.

**Impact:** Long tool-call reasoning gaps (DeepSeek thinking, Z.ai Deep Think) can cause Railway to close the connection before the model responds.

**Recommendation:**

- Default `OMNIROUTE_SSE_COMMENTS=on` for Railway deployments
- Wire `createSseHeartbeatTransform` into every streaming executor
- Implement 4-minute proactive close + `Last-Event-ID` resume
- Set `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform` on all streaming responses

### 6.6 Hardcoded Provider Versions and Selectors

**Problem:** Z.ai client/frontend versions, signature key, user agent, and DOM selectors are hardcoded. Provider UI/version changes require code changes and redeployment.

**Impact:** Z.ai version increments cause silent failures for up to 15 minutes (cache TTL). DOM restructures break model selection, toggle configuration, and input filling.

**Recommendation:**

- Externalize version strings to env vars or config with auto-detection fallback
- Add `data-testid` fallback selectors where possible
- Implement a provider health check that detects version/selector drift and alerts

### 6.7 No Upstream Cancellation on Client Disconnect

**Problem:** When a client disconnects, the upstream `fetch()` is not always cancelled. The model continues generating tokens that nobody receives.

**Impact:** Wasted provider quota, unnecessary load, and potential rate-limit triggers.

**Recommendation:** Wire `req.on('close')` / `AbortSignal` to cancel the upstream `fetch()` in every executor's `BaseExecutor`.

### 6.8 Combo Routing Tight Coupling

**Problem:** `combo.ts` imports from DB, auth, circuit breakers, quota, compression, session stickiness, and many `combo/` sub-modules. Strategies are branches in a large function, not pluggable modules.

**Impact:** Hard to test routing in isolation. Hard to add new strategies. Circular dependency risk.

**Recommendation:**

- Extract each strategy into `open-sse/services/combo/strategies/` with a common `RoutingStrategy` interface
- Move pre-flight helpers to `open-sse/services/combo/preflight.ts`
- Add a combo routing state machine for explicit retry/fallback logic

### 6.9 Module-Level Side Effects

**Problem:** `chat.ts` registers quota fetchers at module load time. Global `combosCache*` variables are shared across requests without concurrency controls.

**Impact:** Ordering bugs, test isolation issues, race conditions on cache.

**Recommendation:**

- Move quota fetcher registration to explicit `registerQuotaFetchers()` called during app boot
- Convert `combosCache` to a TTL-backed cache service

### 6.10 Docker Build Fragility

**Problem:** `cloakbrowser@0.5.9` is installed with `npm install --no-save` — not in `package-lock.json`. `wreq-js` binary check is non-fatal (only echoes). Playwright is a full dependency even for API-key-only deployments.

**Impact:** Version drift risk for cloakbrowser. Silent failure if wreq-js binary is missing. Bloated image for API-key-only use cases.

**Recommendation:**

- Pin `cloakbrowser` in `optionalDependencies`
- Make `wreq-js` check a hard failure
- Add a build-time flag for web-cookie support (`OMNIROUTE_ENABLE_WEB_COOKIES`)
- Run DB migrations in `CMD` before starting the server

---

## 7. Enhancement Research — Industry Best Practices 2026

### 7.1 Control-Plane / Data-Plane Split

Production gateways separate routing policy (control plane) from request execution (data plane). The control plane publishes immutable, signed snapshots of routing policies, budgets, and health tables. The data plane consumes these snapshots and only executes.

**Application to OmniRoute-LEV:**

- Pre-compute health/cost/latency tables out-of-band
- Read-only access in the hot path (<30ms routing decisions)
- Formalize `prod.*` model aliases that resolve to ranked candidate sets

### 7.2 Virtual Model Aliases

A logical name like `prod.chat.default` resolves to `(provider, model, region, account)` with a ranked choice of healthy candidates. Clients never see backend details.

**Application to OmniRoute-LEV:**

- Expose stable aliases like `lev.coding.default`, `lev.coding.cheap`, `lev.coding.fast`
- Each alias maps to a combo with fallback chain (e.g. DeepSeek-web → Z.ai-web → OpenRouter)
- Clients don't need to change when a provider goes down

### 7.3 Proactive Cookie Refresh

Best projects refresh cookies at 75% of known lifetime, not after `401`. They maintain a per-cookie health cache with `tokenExpiryEstimate`.

**Application to OmniRoute-LEV:**

- Extend `WebSessionDriver` to all 54+ web-cookie providers
- Add `tokenExpiryEstimate` plumbing
- Run refresh as a background sweep every 2 minutes (already have the sweep interval)

### 7.4 Tool-Call Adjudication

Production gateways hold proposed tool calls for adjudication, never stream raw tool JSON, and repair duplicate IDs. They validate `tool_choice` semantics (`auto`, `required`, `none`, named function).

**Application to OmniRoute-LEV:**

- Validate and normalize `tools` schemas before routing
- For providers without native tool streaming, buffer until the first tool-call proposal, then emit a single synthetic `chat.completion.chunk`
- Implement tool-call dedup + orphan cleanup
- Ensure `finish_reason: "tool_calls"` is propagated exactly

### 7.5 Content-Type-Aware Compression

2026 gateways compress per conversation, not per request. They use the provider's tokenizer and enforce a hard token budget. Stale tool outputs are replaced with `[COMPACTED] ...` stubs.

**Application to OmniRoute-LEV:**

- Set `autoTriggerTokens` to 70-80% of target model's context window
- For agentic sessions, prefer `lite` (whitespace removal) + `rtk` (tool output dedup) before aggressive compression
- Implement stale tool-output compaction for long agentic sessions
- Use the correct tokenizer for each target provider

### 7.6 SSE Streaming Reliability

- Do not buffer the full SSE stream — forward tokens per-event
- Use `: comment` heartbeats to keep idle connections alive
- Cancel upstream on client disconnect
- Handle backpressure to prevent unbounded memory growth
- Railway-specific: 4-minute proactive close + client reconnect at 3:45

**Application to OmniRoute-LEV:**

- Default `OMNIROUTE_SSE_COMMENTS=on` for Railway
- Set `X-Accel-Buffering: no` universally
- Wire `createSseHeartbeatTransform` into every executor
- Implement 4-minute proactive close + `Last-Event-ID` resume
- Cancel upstream `fetch()` on `req.on('close')`

### 7.7 Browser Fingerprint + Cookie Pairing

`cf_clearance` is bound to the browser TLS fingerprint that solved the Cloudflare challenge. The executor must spoof the same fingerprint.

**Application to OmniRoute-LEV:**

- Store `cf_clearance` alongside the TLS fingerprint that generated it
- Re-issue from the same `tls-client-node` config
- Pool multiple accounts/cookies per provider and rotate on empty-content or 403

---

## 8. Roadmap — Taking OmniRoute-LEV to the Next Level

### Phase 1: Stabilization (1-2 weeks)

| #   | Task                                                                              | Priority | Effort |
| --- | --------------------------------------------------------------------------------- | -------- | ------ |
| 1   | Fix Z.ai 404 misclassification (distinguish model-not-found from rate-limited)    | High     | S      |
| 2   | Enable `OMNIROUTE_SSE_COMMENTS=on` for Railway deployment                         | High     | XS     |
| 3   | Wire `createSseHeartbeatTransform` into all web-cookie executors                  | High     | M      |
| 4   | Set `X-Accel-Buffering: no` on all streaming responses                            | High     | XS     |
| 5   | Cancel upstream `fetch()` on client disconnect in `BaseExecutor`                  | High     | S      |
| 6   | Emit empty-response errors as structured error responses, not assistant `content` | High     | S      |
| 7   | Replace `resp.body!` assertions with null checks                                  | Medium   | S      |
| 8   | Stop swallowing `JSON.parse` errors in `collectSSEContent` — log at debug level   | Medium   | XS     |
| 9   | Pin `cloakbrowser` in `optionalDependencies`                                      | Medium   | XS     |
| 10  | Add Z.ai model-not-found regression test                                          | Medium   | S      |
| 11  | Add combo fallback on input-token-gate rejection (route to larger-context model)  | High     | M      |

### Phase 2: Web-Cookie Provider Hardening (2-4 weeks)

| #   | Task                                                       | Priority | Effort |
| --- | ---------------------------------------------------------- | -------- | ------ |
| 1   | Create `WebCookieExecutorBase` adapter                     | High     | L      |
| 2   | Extend `WebSessionDriver` to all 54+ web-cookie providers  | High     | L      |
| 3   | Implement proactive cookie refresh at 75% lifetime         | High     | M      |
| 4   | Add `tokenExpiryEstimate` to `WebSessionHealth`            | High     | S      |
| 5   | Pool multiple accounts/cookies per provider                | Medium   | L      |
| 6   | Add CAPTCHA-proof cache for Z.ai                           | Medium   | M      |
| 7   | Store `cf_clearance` with TLS fingerprint pairing          | Medium   | M      |
| 8   | Externalize Z.ai version strings to env vars               | Medium   | S      |
| 9   | Add `data-testid` fallback selectors for Z.ai              | Low      | M      |
| 10  | Implement provider health check for version/selector drift | Low      | M      |

### Phase 3: Agentic Client Compatibility (2-4 weeks)

| #   | Task                                                                              | Priority | Effort |
| --- | --------------------------------------------------------------------------------- | -------- | ------ |
| 1   | Validate and normalize `tools` schemas before routing                             | High     | M      |
| 2   | Implement tool-call dedup + orphan cleanup                                        | High     | M      |
| 3   | Ensure `finish_reason: "tool_calls"` propagation for all providers                | High     | S      |
| 4   | Test `tool_choice` modes (auto, required, none, named) across providers           | High     | M      |
| 5   | **Universal pre-gate prompt compression for ALL providers** (not just web-cookie) | High     | L      |
| 6   | **Generalize DeepSeek-web prompt truncation into shared pre-executor transform**  | High     | L      |
| 7   | Switch prompt budgets from character-based to token-based                         | Medium   | M      |
| 8   | Implement stale tool-output compaction for long agentic sessions                  | Medium   | L      |
| 9   | Set `autoTriggerTokens` to 70-80% of model context window                         | Medium   | S      |
| 10  | Add `x-omniroute-compression` trailer for client audit                            | Low      | S      |

### Phase 4: Architecture Refactor (4-8 weeks)

| #   | Task                                                                          | Priority | Effort |
| --- | ----------------------------------------------------------------------------- | -------- | ------ |
| 1   | Extract combo strategies into pluggable `RoutingStrategy` interface           | Medium   | L      |
| 2   | Move quota fetcher registration to boot-time                                  | Medium   | S      |
| 3   | Convert `combosCache` to TTL-backed cache service                             | Medium   | S      |
| 4   | Add Zod/JSON-schema validation for `REGISTRY` entries                         | Medium   | M      |
| 5   | Split `ensureStreamReadiness` into parser, deadline manager, response builder | Low      | M      |
| 6   | Make content-bearing key list extensible per provider                         | Low      | M      |
| 7   | Add OpenTelemetry metrics for `stream_readiness_ms`, `stream_early_eof_count` | Low      | M      |
| 8   | Group tests into `tests/unit/executors/web/` and `tests/unit/stream/`         | Low      | S      |
| 9   | Add build-time flag for web-cookie support in Dockerfile                      | Low      | M      |
| 10  | Run DB migrations in `CMD` before starting server                             | Low      | XS     |

### Phase 5: Advanced Features (8+ weeks)

| #   | Task                                                                    | Priority | Effort |
| --- | ----------------------------------------------------------------------- | -------- | ------ |
| 1   | Implement virtual model aliases (`lev.coding.default`, etc.)            | Medium   | L      |
| 2   | Add control-plane / data-plane split for routing policies               | Medium   | L      |
| 3   | Implement 4-minute proactive SSE close + `Last-Event-ID` resume         | Medium   | L      |
| 4   | Add canary routing for new providers (1-5% with kill-switch)            | Low      | M      |
| 5   | Add least-outstanding-requests routing for streaming targets            | Low      | M      |
| 6   | Implement key-hash routing for KV-cache locality                        | Low      | M      |
| 7   | Add structured usage event stream for cost attribution                  | Low      | M      |
| 8   | Implement browser fingerprint + cookie pairing for Cloudflare providers | Low      | L      |

---

## 9. Appendix: File Inventory & Metrics

### Key Source Files

| File                                                 | Lines | Role                                         |
| ---------------------------------------------------- | ----- | -------------------------------------------- |
| `open-sse/executors/deepseek-web.ts`                 | 1369  | DeepSeek-web main executor                   |
| `open-sse/translator/deepseekWebTools.ts`            | 1294  | DeepSeek tool prompt serialization + parsing |
| `open-sse/utils/streamReadiness.ts`                  | 648   | SSE stream readiness checker                 |
| `open-sse/services/browserBackedChat.ts`             | 879   | Browser-backed chat transport                |
| `open-sse/services/browserPool.ts`                   | 541   | Playwright browser pool                      |
| `open-sse/executors/zai-web.ts`                      | 845   | Z.ai-web main executor                       |
| `open-sse/executors/zai-web/browserAutomation.ts`    | 153   | Z.ai browser DOM automation                  |
| `open-sse/executors/zai-web/protocol.ts`             | 613   | Z.ai protocol (signing, headers, body)       |
| `open-sse/executors/deepseek-web-done-terminator.ts` | 73    | DeepSeek FINISHED drain scheduler            |
| `open-sse/handlers/chatCore/jsonBodyToSse.ts`        | 161   | JSON body → SSE converter                    |

### Test Files

| Category   | Count | Notable files                                                                 |
| ---------- | ----- | ----------------------------------------------------------------------------- |
| DeepSeek   | 23    | `deepseek-web.test.ts`, `deepseek-web-tool-prompt-truncation.test.ts`         |
| Z.ai       | 16    | `executor-zai-web.test.ts`, `zai-web-silent-empty-repro.test.ts`              |
| Stream     | many  | `stream-early-eof-breaker.test.ts`, `combo-stream-readiness-fallback.test.ts` |
| Web-cookie | many  | `web-cookie-providers-new.test.ts`, `web-session-credentials.test.ts`         |

### LEV Fork Comments

| File                              | Count | Purpose                                                                          |
| --------------------------------- | ----- | -------------------------------------------------------------------------------- |
| `deepseek-web.ts`                 | 11    | WebSessionDriver, empty-content watchdog, narrated-intent retry                  |
| `deepseekWebTools.ts`             | 18    | Schema compression, prompt truncation, tool-call parsing variants                |
| `zai-web.ts`                      | 10    | WebSessionDriver, version detection, chat ID extraction, empty-content detection |
| `browserAutomation.ts`            | 1     | Model selection timeout increase (5s → 10s)                                      |
| `protocol.ts`                     | 1     | Endpoint migration (/api/v2 → /api/chat)                                         |
| `browserBackedChat.ts`            | 2     | Svelte SPA settle wait, evaluate-based input                                     |
| `deepseek-web-done-terminator.ts` | 1     | FINISHED drain increase (750ms → 3000ms)                                         |

### Provider Coverage

| Type                 | Count | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-key providers    | ~300  | OpenAI, Anthropic, Google, Mistral, Cohere, OpenRouter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Web-cookie providers | 54+   | DeepSeek-web, Z.ai-web, Claude-web, ChatGPT-web, Gemini-web, Perplexity-web, Qwen-web, Grok-web, Kimi-web, Doubao-web, HuggingChat, Poe-web, Venice-web, V0-Vercel-web, Yuanbao-web, T3-Chat-web, Tencent-AIStudio-web, LM-Arena, DuckDuckGo-web, Felo-web, Muse-Spark-web, Notion-web, Copilot-web, Copilot-M365-web, Blackbox-web, Cloudflare-Playground, Adapta-web, Conol-web, Hailuo-web, Inner-AI, VeoAI-Free-web, Adobe-Firefly, Microsoft-Designer-web, CheaperInference, Chipotle, Cursor, Hyperagent, PromptQL, Zenmux-Free |

### Production Deployment

| Component         | Value                                  |
| ----------------- | -------------------------------------- |
| Railway project   | `omniroute-llm-gateway`                |
| Public URL        | `https://omniroute.agentyx.one`        |
| FreeLLMAPI URL    | `https://freellmapi.agentyx.one`       |
| Services          | redis, postgres, freellmapi, omniroute |
| Latest deployment | `5ba57b36-f344-40ed-9686-62e7b61a1c3d` |
| Health            | `/healthz` → `ok`                      |
| Docker base       | `node:26-trixie-slim`                  |
| Health check      | 30s interval, 300s start-period        |

---

_This document is a living audit. It should be updated as issues are resolved and new enhancements are implemented._
