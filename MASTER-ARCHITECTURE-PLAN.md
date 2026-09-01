# OmniRoute-LEV — Master Architecture Plan

**The comprehensive blueprint for evolving OmniRoute-LEV into a robust, production-grade LLM gateway + harness for LEV Innovation's agentic coding needs.**

**Date:** 2026-09-01
**Repository:** `https://github.com/levinnovation/omniroute-lev.git`
**Branch:** `lev/main`
**Production:** Railway `omniroute-llm-gateway` → `https://omniroute.agentyx.one`
**Companion document:** `AUDIT-ARCHITECTURE-REVIEW.md` (root-cause analysis of all issues)

---

## Table of Contents

1. [Vision & End State](#1-vision--end-state)
2. [Current State Assessment](#2-current-state-assessment)
3. [Target Top-Level Architecture](#3-target-top-level-architecture)
4. [Service-by-Service Design](#4-service-by-service-design)
5. [OSS Integration Matrix](#5-oss-integration-matrix)
6. [Data Flow — Request Lifecycle](#6-data-flow--request-lifecycle)
7. [Railway Deployment Topology](#7-railway-deployment-topology)
8. [Implementation Phases](#8-implementation-phases)
9. [Risk Register & Mitigations](#9-risk-register--mitigations)
10. [Success Metrics](#10-success-metrics)
11. [Appendix: Technology Selection Rationale](#11-appendix-technology-selection-rationale)

---

## 1. Vision & End State

### What we're building

OmniRoute-LEV will become a **multi-layer LLM gateway** that serves as the single entry point for all LEV Innovation agentic coding tools (Cursor, Cline, OpenCode, Codex, Prime Agent, Claude Code). It will:

- **Route any request** to the best available provider — API-key or web-cookie — with automatic fallback.
- **Never fail silently** — every error is classified, logged, and either retried, fallback-routed, or returned as a structured error the client can act on.
- **Handle agentic prompt bloat** — 122K-token Cursor requests are compressed, truncated, or routed to a larger-context model before rejection.
- **Maintain web-cookie sessions proactively** — cookies refresh at 75% of lifetime, not after 401. Browser pools are managed externally with health checks and zombie process prevention.
- **Stream reliably on Railway** — heartbeats keep connections alive past the 5-minute idle cutoff. Upstream is cancelled on client disconnect.
- **Separate concerns architecturally** — routing policy (control plane) is decoupled from request execution (data plane). Web-cookie providers and API-key providers have distinct, purpose-built execution paths.

### Design Principles

1. **Separation of concerns** — Web-cookie providers, API-key providers, browser management, and context compression are separate services, not monolithic modules.
2. **Best-of-breed OSS** — Use battle-tested OSS for each layer instead of custom implementations where possible.
3. **Graceful degradation** — Every dependency failure (browserless down, LiteLLM down, Mem0 down) falls back to the existing OmniRoute path, not a hard failure.
4. **Observable by default** — Every routing decision, compression pass, cookie refresh, and fallback is logged with structured telemetry.
5. **Railway-native** — All services deploy as Railway services in the same project, with internal networking and shared Redis/Postgres.

---

## 2. Current State Assessment

### What works

| Component                           | Status                             | Evidence                                                    |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| OmniRoute core (Next.js + open-sse) | Working                            | 357 providers, 19 combo strategies, 45 LEV fork commits     |
| DeepSeek-web tool-call translation  | Stabilized                         | 6+ format variants parsed, narrated-intent retry            |
| DeepSeek-web prompt management      | Stabilized                         | 32K char budget, 86% schema compression                     |
| Z.ai-web browser transport          | Partially stabilized               | Endpoint migration, version detection, 10s model selection  |
| Perplexity-web                      | Stabilized                         | Pre-gate truncation, query reordering                       |
| Railway deployment                  | Working                            | Docker build, health checks, auto-deploy from `lev/main`    |
| WebSessionDriver                    | Working for Z.ai + DeepSeek        | Pre-dispatch validation, stream watchdog, credential health |
| Compression pipeline                | Exists but not universally applied | 141 files, lite/caveman/rtk/ultra strategies, 70% threshold |

### What's broken or missing

| Gap                                                | Audit ref  | Impact                                                 |
| -------------------------------------------------- | ---------- | ------------------------------------------------------ |
| 54+ web-cookie executors with duplicated logic     | §6.1       | Provider UI changes break one executor at a time       |
| No proactive cookie refresh                        | §6.3       | Every cookie expiry causes at least one failed request |
| Error misclassification (404 as rate-limited)      | §3.5, §6.2 | Z.ai 404 locks all models for 120s                     |
| Character-based prompt budgets                     | §6.4       | Multi-byte content can exceed token limit              |
| Railway SSE idle cutoff (5 min)                    | §6.5       | Long reasoning gaps kill connections                   |
| No upstream cancellation on client disconnect      | §6.7       | Wasted provider quota                                  |
| Combo routing tight coupling                       | §6.8       | Hard to test, hard to extend                           |
| Hardcoded provider versions/selectors              | §6.6       | Provider changes require code changes + redeployment   |
| No universal compression for API-key providers     | §3.10      | 122K tokens sent to 32K model, hard rejection          |
| Docker build fragility (cloakbrowser off-lockfile) | §6.10      | Version drift risk                                     |
| No combo fallback on input-overflow                | §3.10      | Client sees error instead of automatic rerouting       |

---

## 3. Target Top-Level Architecture

```
                              ┌─────────────────────────────────────────────────┐
                              │              LEV Innovation Agents              │
                              │  Cursor · Cline · OpenCode · Codex · Prime      │
                              │  Claude Code · Windsurf · Kiro                  │
                              └──────────────────────┬──────────────────────────┘
                                                     │
                                                     │ OpenAI-compatible HTTP/SSE
                                                     │
                              ┌──────────────────────▼──────────────────────────┐
                              │              OMNIROUTE-LEV (Gateway)             │
                              │         https://omniroute.agentyx.one            │
                              │                                                  │
                              │  ┌─────────────────────────────────────────────┐ │
                              │  │  Control Plane (Routing Policy)              │ │
                              │  │  • Virtual model aliases (lev.coding.*)      │ │
                              │  │  • Provider capability matrix                │ │
                              │  │  • Health/cost/latency tables (cached)       │ │
                              │  │  • Combo strategy selection                   │ │
                              │  │  • Input-token gate + fallback routing        │ │
                              │  └─────────────────────────────────────────────┘ │
                              │  ┌─────────────────────────────────────────────┐ │
                              │  │  Data Plane (Request Execution)              │ │
                              │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │ │
                              │  │  │ Web-Cookie│  │ API-Key  │  │ Context  │  │ │
                              │  │  │ Executor  │  │ Delegate │  │ Pre-Pro  │  │ │
                              │  │  │ (internal)│  │ (→LiteLLM)│  │ (→Mem0)  │  │ │
                              │  │  └─────┬────┘  └─────┬────┘  └─────┬────┘  │ │
                              │  └────────┼─────────────┼─────────────┼────────┘ │
                              └───────────┼─────────────┼─────────────┼──────────┘
                                          │             │             │
                              ┌───────────▼───┐  ┌──────▼──────┐  ┌──▼──────────┐
                              │  BROWSERLESS  │  │   LITELLM   │  │    MEM0     │
                              │  (Railway svc)│  │ (Railway svc)│  │(Railway svc)│
                              │               │  │             │  │             │
                              │  Browser pool │  │ API-key     │  │ Context     │
                              │  + sessions   │  │ routing +   │  │ compaction  │
                              │  + stealth    │  │ fallback +  │  │ + memory    │
                              │  + health     │  │ context-    │  │ + summariz. │
                              │  + zombie     │  │ aware route │  │             │
                              │    prevention │  │             │  │             │
                              └───────────────┘  └─────────────┘  └─────────────┘

                              ┌─────────────────────────────────────────────────┐
                              │              SHARED INFRASTRUCTURE               │
                              │  ┌─────────┐  ┌──────────┐  ┌───────────────┐  │
                              │  │  Redis  │  │ Postgres │  │  FreeLLMAPI   │  │
                              │  │ (cache, │  │ (connec- │  │  (keyless     │  │
                              │  │  rate   │  │  tions,  │  │   provider    │  │
                              │  │  limits)│  │  logs)   │  │   backends)   │  │
                              │  └─────────┘  └──────────┘  └───────────────┘  │
                              └─────────────────────────────────────────────────┘
```

### Architecture layers

| Layer                       | Responsibility                                                   | Technology                                         |
| --------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| **Client interface**        | Accept OpenAI-compatible requests, SSE streaming                 | OmniRoute-LEV (Next.js + open-sse)                 |
| **Control plane**           | Routing policy, model aliases, health tables, combo strategy     | OmniRoute-LEV (enhanced combo engine)              |
| **Data plane — web-cookie** | Browser automation, cookie management, session refresh           | Browserless (external) + OmniRoute executors       |
| **Data plane — API-key**    | Provider routing, fallback, context-aware routing                | LiteLLM (external sidecar)                         |
| **Context pre-processor**   | Prompt compression, token-aware truncation, context compaction   | Mem0 (external) + OmniRoute compression pipeline   |
| **Resilience**              | Circuit breaker, retry, timeout, bulkhead, upstream cancellation | Cockatiel (library) + eventsource-parser (library) |
| **Shared infrastructure**   | Cache, persistence, keyless providers                            | Redis, Postgres, FreeLLMAPI                        |

---

## 4. Service-by-Service Design

### 4.1 OmniRoute-LEV (Gateway — enhanced existing)

**Role:** The single public entry point. Accepts OpenAI-compatible requests, applies routing policy, delegates to the appropriate execution path, and returns SSE streams.

**What changes:**

```
Current:                              Target:
┌──────────────────────┐              ┌──────────────────────────────────┐
│  OmniRoute-LEV       │              │  OmniRoute-LEV (Gateway)         │
│                      │              │                                  │
│  • All 357 providers │     ──→      │  • Control plane (routing)       │
│  • Combo engine      │              │  • Web-cookie executors (54+)    │
│  • Compression       │              │  • SSE streaming + heartbeats    │
│  • Browser pool      │              │  • Compression pipeline (lite)   │
│  • Circuit breaker   │              │  • Cockatiel resilience layer    │
│  • SSE handling      │              │  • eventsource-parser SSE        │
│  • Everything        │              │  • API-key delegate → LiteLLM    │
│    in one process    │              │  • Context delegate → Mem0       │
└──────────────────────┘              │  • Browser delegate → Browserless│
                                      └──────────────────────────────────┘
```

**Specific enhancements:**

1. **Control plane separation** — Extract routing policy from `combo.ts` into a pre-computed health/cost/latency table that's refreshed out-of-band and read-only in the hot path. Add virtual model aliases (`lev.coding.default`, `lev.coding.cheap`, `lev.coding.fast`) that map to combo configs with fallback chains.

2. **API-key delegate** — For API-key providers (OpenAI, Anthropic, Qwen, OpenRouter, etc.), OmniRoute forwards the request to LiteLLM instead of executing the fetch directly. LiteLLM handles fallback, context-aware routing, and budget tracking. OmniRoute still handles auth, logging, and SSE transformation.

3. **Context pre-processor** — Before any executor dispatch, OmniRoute sends the request body to Mem0 for context compaction if the estimated token count exceeds 70% of the target model's context window. Mem0 returns a compacted body with old tool results summarized.

4. **Cockatiel resilience layer** — Replace `src/shared/utils/circuitBreaker.ts` with Cockatiel policies. Add `retry` with exponential backoff + jitter, `circuitBreaker` with error-type predicates (404 ≠ 429 ≠ 502), `timeout` per provider, and `bulkhead` to prevent thundering-herd.

5. **eventsource-parser** — Replace manual SSE frame scanning in `streamReadiness.ts` with `@eventsource-parser/parser`. Handles partial frames, multi-line data, and reconnection. Eliminates the 64KB buffer truncation risk.

6. **SSE heartbeats enabled by default** — Set `OMNIROUTE_SSE_COMMENTS=on` for Railway. Wire `createSseHeartbeatTransform` into every streaming executor. Add 4-minute proactive close + `Last-Event-ID` resume header.

7. **Upstream cancellation** — Wire `req.on('close')` / `AbortSignal` to cancel upstream `fetch()` in `BaseExecutor`. Every executor inherits this for free.

8. **Error classification** — Distinguish 404 (model not found → model lockout only), 429 (quota → account cooldown), 401 (auth → session refresh), 502/504 (transient → retry). Emit empty-response errors as structured error responses with `finish_reason: "error"`, not as assistant `content`.

9. **Input-overflow fallback** — When the input-token gate rejects a request (like the 122K → 32K qwen case), automatically retry with a combo fallback to a larger-context model before returning an error.

10. **Patchright** — Replace `playwright` import with `patchright` in `browserPool.ts`. Drop `cloakbrowser` dependency. Same API, better stealth, no version drift.

### 4.2 Browserless (new Railway service)

**Role:** External browser pool manager. Handles Chromium lifecycle, session reuse, cookie persistence, proxy rotation, health checks, and zombie process prevention.

**Why:** The audit found that `browserPool.ts` (541 lines) has silent close failures that can leak Chromium processes, warmup errors are swallowed, and the CloakBrowser module ID is obfuscated. Browserless solves all of these as a dedicated service.

**Deployment:**

```yaml
# Railway service: browserless
# Image: ghcr.io/browserless/browserless:latest
# Port: 3000
# Resources: 2GB RAM, 2 vCPU (minimum for headless Chromium)
# Internal URL: http://browserless.railway.internal:3000
```

**Integration:**

```
Current:                              Target:
browserPool.ts                        browserPool.ts (thin client)
├── launchBrowser()                   ├── acquireBrowserContext()
├── acquireBrowserContext()           │   → POST browserless/sessions
│   ├── newContext()                  │   → returns CDP endpoint URL
│   ├── seedContextSession()          │   → Playwright connectOverCDP()
│   └── warmupPage()                  ├── releaseBrowserContext()
├── evictStaleContexts()              │   → DELETE browserless/sessions/{id}
├── shutdownPool()                    └── (pool mgmt handled by browserless)
└── cloakbrowser dynamic import
```

**What Browserless gives us:**

- **Zombie process prevention** — Browserless tracks all browser processes and kills them on session close or timeout.
- **Session persistence** — Cookies and localStorage persist across requests without manual seeding.
- **Health checks** — Built-in `/health` endpoint and browser readiness probes.
- **Proxy rotation** — Per-session proxy configuration via API.
- **Stealth mode** — Built-in stealth patches (equivalent to cloakbrowser) without the version drift risk.
- **Scale** — Can run multiple Chromium instances with configurable concurrency limits.
- **Metrics** — Built-in Prometheus metrics for active sessions, queue depth, memory usage.

**Fallback:** If Browserless is down, `browserPool.ts` falls back to local Playwright (existing code path). This ensures graceful degradation.

### 4.3 LiteLLM (new Railway service)

**Role:** API-key provider router. Handles fallback chains, context-window-aware routing, budget tracking, and load balancing for all non-web-cookie providers.

**Why:** The audit found that the 122K-token qwen2.5-vl-72b error was a hard rejection with no fallback. LiteLLM would automatically route to a larger-context model. The combo engine's 19 strategies are tightly coupled in one file; LiteLLM provides battle-tested routing as a separate service.

**Deployment:**

```yaml
# Railway service: litellm
# Image: ghcr.io/berriai/litellm:main-latest
# Port: 4000
# Resources: 512MB RAM, 0.5 vCPU (lightweight Python proxy)
# Internal URL: http://litellm.railway.internal:4000
# Config: litellm_config.yaml (mounted from repo)
```

**LiteLLM config (example):**

```yaml
# litellm_config.yaml
model_list:
  # ── Coding models (API-key providers) ──
  - model_name: lev.coding.default
    litellm_params:
      model: openai/qwen2.5-72b-instruct
      api_base: https://api.openai.com/v1
      api_key: os.environ/OPENAI_API_KEY
    model_info:
      max_input_tokens: 131072

  - model_name: lev.coding.default
    litellm_params:
      model: deepseek/deepseek-chat
      api_key: os.environ/DEEPSEEK_API_KEY
    model_info:
      max_input_tokens: 131072

  - model_name: lev.coding.cheap
    litellm_params:
      model: openai/gpt-4o-mini
      api_key: os.environ/OPENAI_API_KEY
    model_info:
      max_input_tokens: 131072

  - model_name: lev.coding.fast
    litellm_params:
      model: groq/llama-3.3-70b-versatile
      api_key: os.environ/GROQ_API_KEY
    model_info:
      max_input_tokens: 131072

# ── Fallback chains ──
router_settings:
  routing_strategy: fallback
  fallbacks:
    - lev.coding.default:
        - lev.coding.cheap
        - lev.coding.fast
  context_window_fallbacks:
    - lev.coding.default:
        - lev.coding.large # 128K+ context model

  num_retries: 2
  retry_after: 5
  timeout: 120
```

**Integration:**

```
Current:                              Target:
chatCore.ts                           chatCore.ts
├── getExecutor(provider)             ├── if provider is web-cookie:
│   └── executor.execute()            │   → web-cookie executor (existing)
├── fetch(upstream)                   │
└── SSE transform                     ├── if provider is API-key:
                                      │   → POST litellm/v1/chat/completions
                                      │   → LiteLLM handles fallback + routing
                                      │   → SSE stream passthrough
                                      │
                                      └── SSE transform (both paths)
```

**What LiteLLM gives us:**

- **Context-window-aware routing** — Automatically routes to a model with sufficient context when the primary model's limit is exceeded. Solves the 122K → 32K problem.
- **Fallback chains** — Configurable fallback per model. If Qwen is down, fall back to DeepSeek, then OpenAI.
- **Budget tracking** — Per-key, per-model spend tracking with alerts.
- **Load balancing** — Round-robin, least-latency, or weighted across multiple keys for the same provider.
- **Retry with backoff** — Built-in retry with configurable attempts and backoff.
- **Prometheus metrics** — Request count, latency, error rate, token usage per model.
- **100+ provider support** — Battle-tested provider integrations for all major API-key providers.

**Fallback:** If LiteLLM is down, OmniRoute falls back to the existing executor path (direct fetch to the provider). This ensures the gateway still works if the sidecar is unavailable.

### 4.4 Mem0 (new Railway service)

**Role:** Context compaction and conversation memory. Replaces old tool results with semantic summaries, manages rolling context windows, and provides persistent memory across sessions.

**Why:** The audit found that DeepSeek-web's 32K char budget is character-based, not token-based. Long agentic sessions (100+ turns with tool results) can't fit in any 32K model. Mem0 provides semantic compaction instead of hard truncation.

**Deployment:**

```yaml
# Railway service: mem0
# Image: ghcr.io/mem0ai/mem0:latest
# Port: 8080
# Resources: 1GB RAM, 1 vCPU (includes embedding model)
# Internal URL: http://mem0.railway.internal:8080
# Backing store: Postgres (shared) + Redis (shared for cache)
```

**Integration:**

```
Current:                              Target:
chatCore.ts                           chatCore.ts
├── estimateTokens(messages)          ├── estimateTokens(messages)
├── if tokens > 70% limit:            ├── if tokens > 70% limit:
│   ├── compressContext(body)         │   ├── POST mem0/compact
│   │   (lite/caveman/rtk)            │   │   {messages, max_tokens, model}
│   └── body = compressed             │   │   → returns compacted messages
                                      │   │     with old tool results summarized
                                      │   ├── body = compacted
                                      │   └── if still > limit:
                                      │       → POST mem0/summarize
                                      │       → replace all but last 5 turns
                                      │         with a summary message
                                      │
                                      └── if still > limit:
                                          → input-overflow fallback (→ LiteLLM)
```

**What Mem0 gives us:**

- **Semantic compaction** — Instead of `[...tool result truncated]`, Mem0 generates a 1-2 sentence summary of each old tool result. The model knows what was found without seeing the full output.
- **Rolling context window** — Automatically keeps the last N turns verbatim and summarizes older turns. Configurable per model.
- **Persistent memory** — Cross-session memory for the same user/project. "This user is working on the retail portal" persists across sessions.
- **Token-aware** — Uses the correct tokenizer for the target model. No more character-based budgets.
- **Fidelity gate** — Only compacts if the fidelity score is above a threshold. Won't compact code blocks or critical tool results.

**Fallback:** If Mem0 is down, OmniRoute falls back to the existing `compressContext()` pipeline (lite/caveman/rtk). This ensures compression still works if the sidecar is unavailable.

### 4.5 Cockatiel (library — replaces custom circuit breaker)

**Role:** Resilience policies for all provider interactions. Circuit breaker, retry, timeout, bulkhead.

**Why:** The audit found that the custom circuit breaker treats 404 and 429 the same way, and the anti-thundering-herd guard is custom. Cockatiel provides all of this as a tested library.

**Integration:**

```typescript
// Current: src/shared/utils/circuitBreaker.ts (custom)
// Target: open-sse/services/resilience/policies.ts (Cockatiel-based)

import { retry, circuitBreaker, timeout, bulkhead, handleAll } from "cockatiel";

// Per-provider policy
export function createProviderPolicy(provider: string) {
  const retryPolicy = retry(handleAll, {
    maxAttempts: 3,
    backoff: new ExponentialBackoff({ initialDelay: 1000, maxDelay: 30000 }),
  });

  // 404 → model lockout only (don't trip breaker)
  // 429 → account cooldown (trip breaker with long reset)
  // 502/503/504 → transient (trip breaker with short reset)
  // 401 → session refresh (don't trip breaker)
  const breaker = circuitBreaker(handleAll, {
    halfOpenAfter: 60_000,
    breaker: (error) => {
      if (error.code === 404) return false; // model not found — don't trip
      if (error.code === 401) return false; // auth error — don't trip
      if (error.code === 429) return true; // quota — trip
      if (error.code >= 500) return true; // server error — trip
      return false;
    },
  });

  const timeoutPolicy = timeout(120_000); // 2 min per request
  const bulkheadPolicy = bulkhead(10); // max 10 concurrent per provider

  return wrap(retryPolicy, wrap(breaker, wrap(timeoutPolicy, bulkheadPolicy)));
}
```

### 4.6 eventsource-parser (library — replaces manual SSE parsing)

**Role:** Parse SSE frames from upstream providers. Handles partial frames, multi-line data, comments, and reconnection.

**Why:** The audit found that `streamReadiness.ts` has a 64KB buffer cap that can truncate large first SSE frames, and `readWithTimeout` doesn't abort the underlying fetch. eventsource-parser is used by Vercel AI SDK and handles all of this.

**Integration:**

```typescript
// Current: open-sse/utils/streamReadiness.ts (manual parsing, 648 lines)
// Target: open-sse/utils/streamReadiness.ts (eventsource-parser-based)

import { EventSourceParserStream } from "@eventsource-parser/server";

// Replace manual chunk scanning with:
const sseStream = response.body
  .pipeThrough(new TextDecoderStream())
  .pipeThrough(new EventSourceParserStream());

for await (const event of sseStream) {
  if (event.event === "ping" || event.data === "") {
    // extend deadline
    continue;
  }
  // useful content found — stream is ready
  break;
}
```

### 4.7 Patchright (library — replaces playwright + cloakbrowser)

**Role:** Anti-detect Playwright fork. Same API as Playwright with built-in stealth patches.

**Why:** The audit found that `cloakbrowser@0.5.9` is installed with `npm install --no-save` (not in lockfile), the module ID is obfuscated as `["cloak","browser"].join("")`, and version drift is a risk. Patchright is a drop-in replacement with no obfuscation.

**Integration:**

```typescript
// Current: browserPool.ts
// const { chromium } = await import("playwright");
// const cloakLaunch = await resolveCloakLaunch(); // obfuscated dynamic import

// Target: browserPool.ts
import { chromium } from "patchright";

// That's it. Same API. No cloakbrowser. No obfuscation.
// If using Browserless, this becomes:
// const browser = await chromium.connectOverCDP("http://browserless:3000");
```

---

## 5. OSS Integration Matrix

| Problem (audit ref)                 | OSS solution       | Type            | Effort | Fallback if unavailable        |
| ----------------------------------- | ------------------ | --------------- | ------ | ------------------------------ |
| §6.1 — 54+ duplicated executors     | Browserless        | Railway service | M      | Local Playwright pool          |
| §6.6 — zombie process leaks         | Browserless        | Railway service | M      | Existing browserPool           |
| §6.10 — cloakbrowser version drift  | Patchright         | npm dependency  | XS     | Plain Playwright               |
| §3.4, §3.8 — browser detection      | Patchright         | npm dependency  | XS     | cloakbrowser                   |
| §3.10 — 122K tokens to 32K model    | LiteLLM            | Railway service | M      | Existing executor + input gate |
| §6.8 — combo routing tight coupling | LiteLLM            | Railway service | M      | Existing combo engine          |
| §6.2 — error misclassification      | Cockatiel          | npm dependency  | S      | Existing circuit breaker       |
| §6.7 — no upstream cancellation     | Cockatiel          | npm dependency  | S      | Manual AbortController         |
| §6.5 — Railway SSE idle cutoff      | eventsource-parser | npm dependency  | S      | Manual SSE parsing             |
| §6.5 — SSE frame truncation         | eventsource-parser | npm dependency  | S      | Manual buffer management       |
| §6.4 — character-based budgets      | Mem0               | Railway service | L      | Existing compressContext       |
| §3.1 — prompt bloat                 | Mem0               | Railway service | L      | Existing compression pipeline  |
| §3.3 — narrated intent              | (existing)         | —               | —      | Already handled                |
| §3.5 — 404 as rate-limited          | Cockatiel          | npm dependency  | S      | Manual error classification    |

---

## 6. Data Flow — Request Lifecycle

### 6.1 Normal request (API-key provider)

```
Client → POST /v1/chat/completions
  → OmniRoute auth + Zod validation
  → Control plane: resolve virtual alias → combo config
  → Control plane: select strategy → resolve target (provider + model)
  → Context pre-processor:
      → estimateTokens(messages)
      → if tokens > 70% of model context limit:
          → POST mem0/compact {messages, max_tokens, model}
          → if still > limit:
              → POST mem0/summarize {messages, keep_last_n: 5}
      → body = compacted body
  → Input-token gate:
      → if still exceeds limit:
          → combo fallback to larger-context model (via LiteLLM context_window_fallbacks)
  → Data plane: API-key delegate
      → POST litellm/v1/chat/completions {body, model: lev.coding.default}
      → LiteLLM routes to best API-key provider
      → LiteLLM handles retry/fallback within its model list
      → SSE stream returned
  → SSE transform: eventsource-parser → OpenAI chat.completion.chunk
  → SSE heartbeat: 15s comment heartbeats (OMNIROUTE_SSE_COMMENTS=on)
  → Client receives SSE stream
  → On client disconnect: AbortSignal cancels LiteLLM upstream
  → Post-request: usage logging, credential health update
```

### 6.2 Web-cookie request (DeepSeek-web, Z.ai-web, etc.)

```
Client → POST /v1/chat/completions
  → OmniRoute auth + Zod validation
  → Control plane: resolve target (web-cookie provider)
  → Context pre-processor:
      → Same as above (Mem0 compaction)
      → Plus: DeepSeek-web specific truncation (32K char budget)
      → Plus: schema compression (86% reduction)
  → WebSessionDriver: pre-dispatch validation
      → Check cookie health (age, last success, error count)
      → If cookie at 75% lifetime: background refresh
      → If cookie expired: synchronous refresh (one-time penalty)
  → Data plane: web-cookie executor
      → Browserless: acquire session (POST browserless/sessions)
      → Playwright connectOverCDP(browserless endpoint)
      → Navigate to provider URL
      → Select model, configure toggles
      → Fill prompt (evaluate-based for Svelte)
      → Submit, capture response
      → Extract chat ID / SSE stream
      → Direct fetch completion (Z.ai) or pass-through
  → Tool-call parsing (if tools[] present):
      → parseDeepSeekToolCalls (6+ format variants)
      → Narrated-intent detection + retry
      → Fallback tool synthesis
  → SSE transform: eventsource-parser → OpenAI chat.completion.chunk
  → SSE heartbeat + stream watchdog (empty-content detection)
  → Client receives SSE stream
  → On client disconnect: AbortSignal cancels upstream fetch + closes browserless session
  → Post-request: WebSessionDriver health update, usage logging
```

### 6.3 Input-overflow fallback flow

```
Client → POST /v1/chat/completions {122K tokens, model: qwen2.5-vl-72b}
  → Context pre-processor:
      → Mem0 compaction: 122K → 80K tokens (summarize old tool results)
      → Still > 32K limit
  → Input-token gate:
      → REJECTED: 80K > 32K
  → Combo fallback (NEW):
      → Check combo config for fallback models with larger context
      → Found: deepseek-chat (128K context)
      → Re-route to LiteLLM with model: lev.coding.default
      → LiteLLM routes to deepseek-chat
      → SSE stream returned
  → Client receives response (no error visible to client)
```

---

## 7. Railway Deployment Topology

### Current state (4 services)

```
Railway project: omniroute-llm-gateway
├── redis          (cache, rate limits)
├── postgres       (connections, logs)
├── freellmapi     (keyless provider backends)
└── omniroute      (gateway — all providers, all logic)
```

### Target state (7 services)

```
Railway project: omniroute-llm-gateway
├── redis          (cache, rate limits)                    [existing]
├── postgres       (connections, logs, Mem0 store)         [existing, shared]
├── freellmapi     (keyless provider backends)             [existing]
├── omniroute      (gateway — control plane + web-cookie)  [enhanced]
├── browserless    (browser pool + sessions)               [NEW]
├── litellm        (API-key provider routing)              [NEW]
└── mem0           (context compaction + memory)           [NEW]
```

### Resource estimates

| Service     | RAM      | vCPU     | Storage | Monthly cost (est.) |
| ----------- | -------- | -------- | ------- | ------------------- |
| redis       | 256MB    | 0.25     | —       | $5                  |
| postgres    | 512MB    | 0.5      | 1GB     | $10                 |
| freellmapi  | 512MB    | 0.5      | —       | $5                  |
| omniroute   | 1GB      | 1.0      | —       | $20                 |
| browserless | 2GB      | 2.0      | —       | $40                 |
| litellm     | 512MB    | 0.5      | —       | $5                  |
| mem0        | 1GB      | 1.0      | —       | $20                 |
| **Total**   | **~6GB** | **~6.0** | **1GB** | **~$105/mo**        |

### Internal networking

All services communicate via Railway's internal network (`*.railway.internal`). No public exposure except:

- `omniroute` → `https://omniroute.agentyx.one` (public)
- `freellmapi` → `https://freellmapi.agentyx.one` (public, for external access)

Internal-only:

- `browserless.railway.internal:3000`
- `litellm.railway.internal:4000`
- `mem0.railway.internal:8080`

### Environment variables (new)

```bash
# ── Browserless ──
BROWSERLESS_URL=http://browserless.railway.internal:3000
BROWSERLESS_API_KEY=***  # if using browserless cloud or auth
BROWSERLESS_MAX_CONCURRENT=5

# ── LiteLLM ──
LITELLM_URL=http://litellm.railway.internal:4000
LITELLM_API_KEY=sk-litellm-***  # LiteLLM master key
# LiteLLM provider keys (passed to LiteLLM service):
OPENAI_API_KEY=***
DEEPSEEK_API_KEY=***
GROQ_API_KEY=***
ANTHROPIC_API_KEY=***

# ── Mem0 ──
MEM0_URL=http://mem0.railway.internal:8080
MEM0_API_KEY=***
MEM0_POSTGRES_URL=postgresql://...  # shared postgres

# ── OmniRoute enhancements ──
OMNIROUTE_SSE_COMMENTS=on  # enable comment heartbeats for Railway
OMNIROUTE_BROWSER_POOL=off  # disable local pool when using browserless
OMNIROUTE_API_KEY_DELEGATE=litellm  # delegate API-key providers to LiteLLM
OMNIROUTE_CONTEXT_DELEGATE=mem0  # delegate context compaction to Mem0
OMNIROUTE_INPUT_OVERFLOW_FALLBACK=on  # auto-fallback on input-token gate rejection
```

---

## 8. Implementation Phases

### Phase 0: Prerequisites (1-2 days)

| #   | Task                                                | Why first               |
| --- | --------------------------------------------------- | ----------------------- |
| 0.1 | Verify Railway project can add 3 new services       | Confirm resource limits |
| 0.2 | Backup current OmniRoute config and env vars        | Safety net              |
| 0.3 | Create `lev/main` worktree for parallel development | Isolation per AGENTS.md |

### Phase 1: Quick Wins (1 week)

**Goal:** Fix the highest-impact issues with the lowest effort.

| #    | Task                                                                      | OSS        | Audit ref   | Effort |
| ---- | ------------------------------------------------------------------------- | ---------- | ----------- | ------ |
| 1.1  | Replace `playwright` with `patchright` in `browserPool.ts`                | Patchright | §6.10, §3.4 | XS     |
| 1.2  | Remove `cloakbrowser` from Dockerfile, pin `patchright` in `package.json` | Patchright | §6.10       | XS     |
| 1.3  | Set `OMNIROUTE_SSE_COMMENTS=on` in Railway env vars                       | —          | §6.5        | XS     |
| 1.4  | Wire `createSseHeartbeatTransform` into all web-cookie executors          | —          | §6.5        | S      |
| 1.5  | Set `X-Accel-Buffering: no` on all streaming responses                    | —          | §6.5        | XS     |
| 1.6  | Wire `req.on('close')` to cancel upstream `fetch()` in `BaseExecutor`     | —          | §6.7        | S      |
| 1.7  | Fix Z.ai 404 misclassification (model lockout only, not account cooldown) | —          | §3.5        | S      |
| 1.8  | Add input-overflow combo fallback in `chatCore.ts`                        | —          | §3.10       | M      |
| 1.9  | Emit empty-response errors as structured error responses                  | —          | §6.2        | S      |
| 1.10 | Replace `resp.body!` assertions with null checks                          | —          | §5.1        | S      |

**Verification:** Deploy to Railway, send a 122K-token request to a 32K model, verify it falls back to a larger model instead of erroring.

### Phase 2: Sidecar Services (2-3 weeks)

**Goal:** Deploy LiteLLM and Browserless as Railway sidecar services.

| #   | Task                                                                  | OSS         | Audit ref            | Effort |
| --- | --------------------------------------------------------------------- | ----------- | -------------------- | ------ |
| 2.1 | Deploy Browserless as Railway service                                 | Browserless | §6.1, §6.6           | M      |
| 2.2 | Update `browserPool.ts` to connect via CDP to Browserless             | Browserless | §6.1                 | M      |
| 2.3 | Add fallback to local Playwright if Browserless is down               | —           | graceful degradation | S      |
| 2.4 | Deploy LiteLLM as Railway service with `litellm_config.yaml`          | LiteLLM     | §3.10, §6.8          | M      |
| 2.5 | Add API-key delegate path in `chatCore.ts` (forward to LiteLLM)       | LiteLLM     | §3.10                | M      |
| 2.6 | Add fallback to existing executor if LiteLLM is down                  | —           | graceful degradation | S      |
| 2.7 | Migrate API-key provider credentials from OmniRoute to LiteLLM config | —           | §6.8                 | M      |
| 2.8 | Verify all API-key providers work through LiteLLM                     | —           | —                    | M      |
| 2.9 | Verify all web-cookie providers work through Browserless              | —           | —                    | M      |

**Verification:** Send requests to both API-key and web-cookie providers. Verify fallback when Browserless/LiteLLM are manually stopped.

### Phase 3: Resilience & SSE (1-2 weeks)

**Goal:** Replace custom resilience with Cockatiel and manual SSE parsing with eventsource-parser.

| #   | Task                                                                          | OSS                           | Audit ref     | Effort |
| --- | ----------------------------------------------------------------------------- | ----------------------------- | ------------- | ------ |
| 3.1 | `npm install cockatiel @eventsource-parser/parser`                            | Cockatiel, eventsource-parser | —             | XS     |
| 3.2 | Replace `circuitBreaker.ts` with Cockatiel policies                           | Cockatiel                     | §6.2, §6.7    | S      |
| 3.3 | Add error-type predicates (404 ≠ 429 ≠ 502)                                   | Cockatiel                     | §3.5, §6.2    | S      |
| 3.4 | Replace manual SSE parsing in `streamReadiness.ts`                            | eventsource-parser            | §6.5          | M      |
| 3.5 | Add 4-minute proactive SSE close + `Last-Event-ID` resume                     | —                             | §6.5          | M      |
| 3.6 | Add OpenTelemetry metrics for `stream_readiness_ms`, `stream_early_eof_count` | —                             | observability | M      |
| 3.7 | Run full test suite, fix any regressions                                      | —                             | —             | M      |

**Verification:** Simulate provider failures (404, 429, 502, timeout) and verify Cockatiel handles each correctly. Verify SSE streams survive >5 minute idle gaps on Railway.

### Phase 4: Context Compaction (2-3 weeks)

**Goal:** Deploy Mem0 and integrate semantic context compaction.

| #   | Task                                                                            | OSS  | Audit ref            | Effort |
| --- | ------------------------------------------------------------------------------- | ---- | -------------------- | ------ |
| 4.1 | Deploy Mem0 as Railway service with shared Postgres                             | Mem0 | —                    | M      |
| 4.2 | Add context delegate path in `chatCore.ts` (call Mem0 before gate)              | Mem0 | §6.4, §3.1           | M      |
| 4.3 | Configure Mem0 compaction rules (summarize old tool results, keep last 5 turns) | Mem0 | §6.4                 | S      |
| 4.4 | Add fidelity gate (don't compact code blocks or critical results)               | Mem0 | §6.4                 | S      |
| 4.5 | Replace DeepSeek-web character budgets with Mem0 token-aware budgets            | Mem0 | §6.4                 | M      |
| 4.6 | Add fallback to existing `compressContext()` if Mem0 is down                    | —    | graceful degradation | S      |
| 4.7 | Test long agentic sessions (100+ turns) with Mem0 compaction                    | —    | §3.1                 | M      |
| 4.8 | Add `x-omniroute-compression` trailer for client audit                          | —    | observability        | S      |

**Verification:** Send a 100-turn agentic session to a 32K model. Verify Mem0 compacts it to fit. Verify the model can still reference earlier tool results via summaries.

### Phase 5: Control Plane Refactor (3-4 weeks)

**Goal:** Separate routing policy from request execution. Add virtual model aliases.

| #   | Task                                                                | OSS | Audit ref | Effort |
| --- | ------------------------------------------------------------------- | --- | --------- | ------ |
| 5.1 | Extract combo strategies into pluggable `RoutingStrategy` interface | —   | §6.8      | L      |
| 5.2 | Pre-compute health/cost/latency tables out-of-band                  | —   | §7.1      | L      |
| 5.3 | Add virtual model aliases (`lev.coding.default`, etc.)              | —   | §7.2      | M      |
| 5.4 | Move quota fetcher registration to boot-time                        | —   | §6.9      | S      |
| 5.5 | Convert `combosCache` to TTL-backed cache service                   | —   | §6.9      | S      |
| 5.6 | Add Zod schema validation for provider registry entries             | —   | §4.3      | M      |
| 5.7 | Add canary routing for new providers (1-5% with kill-switch)        | —   | §7.1      | M      |
| 5.8 | Add structured usage event stream for cost attribution              | —   | §7.1      | M      |

**Verification:** Add a new provider via config only (no code changes). Verify virtual aliases resolve correctly. Verify canary routing isolates new-provider failures to 5% of traffic.

### Phase 6: Web-Cookie Executor Consolidation (4-6 weeks)

**Goal:** Create shared `WebCookieExecutorBase` and consolidate the 54+ executors.

| #    | Task                                                           | OSS         | Audit ref | Effort |
| ---- | -------------------------------------------------------------- | ----------- | --------- | ------ |
| 6.1  | Design `WebCookieExecutorBase` interface                       | —           | §6.1      | M      |
| 6.2  | Implement base class with Browserless integration              | Browserless | §6.1      | L      |
| 6.3  | Implement proactive cookie refresh at 75% lifetime             | —           | §6.3      | M      |
| 6.4  | Implement error classification (404/429/401/502/empty-content) | Cockatiel   | §6.2      | M      |
| 6.5  | Migrate Z.ai-web executor to base class                        | —           | §6.1      | M      |
| 6.6  | Migrate DeepSeek-web executor to base class                    | —           | §6.1      | M      |
| 6.7  | Migrate Claude-web executor to base class                      | —           | §6.1      | M      |
| 6.8  | Migrate remaining web-cookie executors (batch)                 | —           | §6.1      | L      |
| 6.9  | Add `data-testid` fallback selectors for Z.ai                  | —           | §6.6      | S      |
| 6.10 | Externalize provider versions to env vars with auto-detection  | —           | §6.6      | M      |

**Verification:** Verify all 54+ web-cookie providers work through the base class. Verify proactive cookie refresh prevents 401 failures. Verify a provider UI change only requires updating one base class, not 54 executors.

---

## 9. Risk Register & Mitigations

| Risk                                                  | Probability | Impact | Mitigation                                                                                                   |
| ----------------------------------------------------- | ----------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| Browserless introduces breaking API change            | Low         | High   | Pin Docker image version. Fallback to local Playwright.                                                      |
| LiteLLM doesn't support a provider OmniRoute needs    | Medium      | Medium | Keep OmniRoute executor as fallback. LiteLLM handles common providers; OmniRoute handles exotic ones.        |
| Mem0 compaction loses critical context                | Medium      | High   | Fidelity gate prevents compacting code blocks. Keep last 5 turns verbatim. Fallback to existing compression. |
| Patchright doesn't support a Playwright feature       | Low         | Medium | Patchright is API-compatible. If issue arises, fall back to plain Playwright.                                |
| Cockatiel policy doesn't match OmniRoute's needs      | Low         | Low    | Cockatiel is highly configurable. Custom policies can be composed.                                           |
| Railway service limit reached (max services)          | Low         | High   | Check Railway plan limits. If needed, combine LiteLLM + Mem0 into one Python service.                        |
| Sidecar latency adds overhead                         | Medium      | Low    | Internal Railway networking is <1ms. LiteLLM and Mem0 add ~5-10ms per request. Acceptable for LLM gateway.   |
| Browserless memory exhaustion on Railway              | Medium      | High   | Set `MAX_CONCURRENT=5` sessions. Monitor memory. Railway will restart on OOM.                                |
| LiteLLM config drift from OmniRoute provider registry | Medium      | Medium | Single source of truth: generate LiteLLM config from OmniRoute's provider registry on deploy.                |
| Mem0 embedding model uses too much RAM                | Low         | Medium | Use lightweight embedding model (e.g. `all-MiniLM-L6-v2`). Monitor Railway memory.                           |

---

## 10. Success Metrics

### Operational metrics

| Metric                           | Current  | Target  | How to measure                                 |
| -------------------------------- | -------- | ------- | ---------------------------------------------- |
| Request success rate (non-error) | ~95%     | >99%    | Railway logs: 2xx vs 4xx/5xx                   |
| Silent empty-stream failures     | ~2-3/day | <1/week | `STREAM_EARLY_EOF` log count                   |
| Cookie expiry-caused failures    | ~5/day   | 0       | `401` after successful auth count              |
| Z.ai 404-caused account lockouts | ~2/week  | 0       | `lastErrorCode=404` + `rate limited` log count |
| SSE disconnects on Railway       | ~5/day   | <1/week | Client reconnect count                         |
| Input-overflow hard rejections   | ~10/day  | 0       | `context_length_exceeded` error count          |
| Time-to-first-token (P95)        | ~3s      | <2s     | SSE first chunk timestamp                      |
| Browser zombie processes         | unknown  | 0       | Browserless `/metrics` endpoint                |

### Architectural metrics

| Metric                                        | Current | Target              | How to measure                           |
| --------------------------------------------- | ------- | ------------------- | ---------------------------------------- |
| Web-cookie executors with duplicated logic    | 54      | 1 (base class)      | Code search: `browserBackedChat` imports |
| Hardcoded magic numbers in DeepSeek executor  | 15+     | 0                   | Code review: all values in config        |
| Character-based prompt budgets                | 5       | 0 (all token-based) | Code search: `MAX_.*_LEN`                |
| Providers requiring code changes on UI update | 54      | 0 (config only)     | Incident count                           |
| Test coverage for web-cookie providers        | ~30%    | >70%                | `npm run test:coverage`                  |
| Combo strategies as pluggable modules         | 0       | 19                  | `RoutingStrategy` implementations        |

### Client experience metrics

| Metric                                | Current     | Target            | How to measure                     |
| ------------------------------------- | ----------- | ----------------- | ---------------------------------- |
| Cursor tool-call success rate         | ~90%        | >99%              | `finish_reason: "tool_calls"` rate |
| DeepSeek-web narrated intent recovery | ~50%        | >90%              | Narrated-intent retry success log  |
| Long session (>50 turns) success rate | ~70%        | >95%              | Session completion rate            |
| Client-perceived error messages       | Generic 502 | Structured errors | Error response format audit        |

---

## 11. Appendix: Technology Selection Rationale

### Why not just fix the existing code?

The existing OmniRoute codebase is well-architected for its original purpose: a unified proxy for 357 providers. But the LEV fork has been patching web-cookie provider issues one at a time (45 commits), and each fix is provider-specific. The fundamental problems — duplicated logic, no proactive refresh, error misclassification, no context-aware fallback — are architectural, not implementation bugs. Adding more patches would continue the whack-a-mole pattern.

### Why LiteLLM instead of fixing OmniRoute's combo engine?

OmniRoute's combo engine is tightly coupled to its DB, auth, and compression layers. Extracting strategies into a pluggable interface (Phase 5) is a 3-4 week refactor with high regression risk. LiteLLM provides the same functionality (fallback, context-aware routing, load balancing) as a battle-tested external service with 10K+ GitHub stars and active development. The integration is a thin delegate path in `chatCore.ts`, not a rewrite.

**Trade-off:** OmniRoute loses direct control of API-key provider routing. But it gains LiteLLM's community-maintained provider integrations, budget tracking, and Prometheus metrics. The combo engine still handles web-cookie providers, which are OmniRoute's unique value.

### Why Browserless instead of fixing browserPool.ts?

`browserPool.ts` is 541 lines and has silent close failures, warmup error swallowing, and CloakBrowser obfuscation. Browserless is a dedicated browser-as-a-service with 20K+ GitHub stars, built-in zombie prevention, session persistence, and health checks. The integration is a CDP connection, not a rewrite.

**Trade-off:** Adds a service dependency. But the fallback to local Playwright ensures the gateway still works if Browserless is down.

### Why Mem0 instead of fixing the compression pipeline?

The compression pipeline (141 files) is sophisticated but character-based and per-request, not per-conversation. Mem0 adds semantic summarization (not just truncation) and persistent memory across sessions. It uses the correct tokenizer for the target model.

**Trade-off:** Adds a service dependency and embedding model overhead. But the fallback to existing `compressContext()` ensures compression still works if Mem0 is down.

### Why Cockatiel instead of fixing circuitBreaker.ts?

The custom circuit breaker doesn't distinguish 404 from 429, and the anti-thundering-herd guard is custom. Cockatiel is a 2K-star Node.js resilience library with circuit breaker, retry, timeout, and bulkhead policies that are composable and well-tested. The integration is a drop-in replacement.

**Trade-off:** Adds a dependency. But Cockatiel is small (no native modules), well-maintained, and TypeScript-native.

### Why eventsource-parser instead of fixing streamReadiness.ts?

`streamReadiness.ts` is 648 lines of manual SSE frame parsing with a 64KB buffer cap and no upstream fetch cancellation. eventsource-parser is a 200-line, well-tested library used by Vercel AI SDK that handles partial frames, multi-line data, and reconnection. It eliminates the buffer truncation risk and simplifies the codebase.

**Trade-off:** Adds a small dependency. But it's maintained by the Vercel AI SDK team and has no native modules.

### Why Patchright instead of cloakbrowser?

`cloakbrowser@0.5.9` is installed with `npm install --no-save` (not in lockfile), the module ID is obfuscated as `["cloak","browser"].join("")`, and version drift is a risk. Patchright is a drop-in Playwright replacement with the same API, better stealth patches, and a proper npm package with version pinning.

**Trade-off:** Patchright is newer than cloakbrowser. But it's API-compatible with Playwright, so falling back to plain Playwright is a one-line change.

---

_This plan is a living document. It should be updated as phases are completed and new requirements emerge. Cross-reference with `AUDIT-ARCHITECTURE-REVIEW.md` for root-cause analysis of all issues._
