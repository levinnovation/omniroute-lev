---
title: "LEV Fork Constitution"
version: 3.8.51
lastUpdated: 2026-09-02
---

# LEV Fork Constitution

> **Governing document for the `levinnovation/omniroute-lev` fork.**
> This constitution defines the architectural principles, hard rules, and
> decision-making framework that distinguish the LEV fork from upstream
> OmniRoute. Every coding agent (Claude Code, Codex, Gemini, Copilot, Cursor,
> Cline, Prime Agent) working this repository MUST read and follow this
> document before making changes to executor, translator, or service code.

---

## 1. Fork Identity

| Field               | Value                                                |
| ------------------- | ---------------------------------------------------- |
| Upstream            | `diegosouzapw/OmniRoute`                             |
| Fork                | `levinnovation/omniroute-lev`                        |
| Branch              | `lev/main`                                           |
| Deployment          | Railway — `omniroute-llm-gateway` project            |
| Public URL          | `https://omniroute.agentyx.one`                      |
| Browserless sidecar | `https://browserless-production-39ee.up.railway.app` |
| LiteLLM sidecar     | `https://litellm-production-20e1.up.railway.app`     |

The LEV fork is a **production-hardened derivative** focused on:

1. **Browser-first web-cookie providers** — real browser automation as the
   primary transport, direct HTTP as fallback only.
2. **Robust tool-call parsing** — shared recovery layer that handles bare JSON,
   XML tags, narrated intent, and reasoning-content tool calls.
3. **Agentic-client compatibility** — OpenAI-compatible tool-call output for
   Cursor, Kiro, OpenCode, Cline, Prime Agent, Codex, and Claude Code.
4. **Operational resilience on Railway** — proper account selection, cooldown,
   fallback, and error propagation.

---

## 2. Core Principles

### 2.1 Browser-First, HTTP-Fallback

**Rule:** Every web-cookie provider executor MUST attempt browser automation
before direct HTTP. The `execute()` method MUST call `executeViaBrowser()` first
and `executeViaDirectHttp()` as fallback.

**Why:** Direct HTTP calls to web-cookie providers fail frequently due to WAF
blocks, expired tokens, missing browser fingerprints, and rate limiting. Browser
automation through Browserless/CDP provides real browser state, proper
fingerprints, and session validation that direct HTTP cannot replicate.

**Exception:** Providers that use in-browser API calls (like deepseek-web) may
use `page.evaluate()` inside the browser context instead of UI automation. The
key requirement is that a real browser context is active.

### 2.2 Composition Over Inheritance

**Rule:** Provider executors MUST compose shared utilities rather than inherit
from base classes with provider-specific logic. Shared behavior lives in
standalone modules that any executor can import.

**Why:** Inheritance creates tight coupling between providers and base classes.
When a base class changes, all providers break. Composition lets each provider
pick exactly the utilities it needs without inheriting unwanted behavior.

**Pattern:**

```ts
// GOOD — composition: import shared utilities
import { runBrowserAutomation } from "./base/browserAutomationFallback";
import { parseAndRecoverToolCalls } from "../translator/robustWebTools";
import { buildQwenCookieHeader, extractQwenToken } from "./qwen-web-utils";

class QwenWebExecutor {
  async execute(input: ExecuteInput) {
    const browserResult = await this.executeViaBrowser(input);
    if (browserResult) return browserResult;
    const directResult = await this.executeViaDirectHttp(input);
    if (directResult) return directResult;
    return makeErrorResult(502, "both paths failed", input.body, URL);
  }
}

// BAD — inheritance: provider-specific logic in base class
class QwenWebExecutor extends WebCookieExecutorBase {
  // base class has qwen-specific logic baked in
}
```

**Shared modules (compose, don't inherit):**

| Module                              | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `base/browserAutomationFallback.ts` | `runBrowserAutomation()`, `isBrowserAutomationEnabled()` |
| `base/WebCookieExecutorBase.ts`     | Shared cookie/session helpers (import, don't extend)     |
| `../translator/robustWebTools.ts`   | Tool-call parsing, narrated-intent recovery              |
| `../translator/deepseekWebTools.ts` | DeepSeek-specific tool parsing                           |
| `../services/accountSelector.ts`    | Account selection strategies                             |
| `../services/accountFallback.ts`    | Cooldown, eviction, rotation                             |

### 2.3 Robust Tool-Call Parsing

**Rule:** All web-cookie providers that support tool-mode MUST route response
parsing through the shared `robustWebTools.ts` module. Provider-specific parsers
MUST delegate to the shared parser for recovery.

**Why:** Agentic clients (Cursor, Cline, Codex) require OpenAI-compatible
`tool_calls` arrays with `finish_reason: "tool_calls"`. Web-cookie models often
emit tool calls in non-standard formats: bare JSON, XML tags, narrated intent,
or inside `reasoning_content`. The shared parser handles all these cases.

### 2.4 Error Propagation

**Rule:** Errors MUST identify the actual failure cause. Generic "both paths
failed" messages are acceptable only as a last resort. Provider-specific error
detection (mute, ban, quota, session expiry) MUST be classified and mapped to
the correct HTTP status code.

**Why:** Agentic clients and operators need actionable errors. "Both browser
automation and direct HTTP failed" is not actionable. "Account is muted by
DeepSeek until 2026-09-03T11:47:02Z" is actionable.

### 2.5 No Mockups, No Dummies

**Rule:** All code in the LEV fork MUST be production-ready. No mock
implementations, no dummy responses, no placeholder logic. Every code path
MUST work with real provider APIs and real browser automation.

**Why:** The LEV fork is deployed to production Railway and serves real agentic
clients. Mock code breaks under real load and hides bugs that surface only in
production.

---

## 3. Architecture Layers

```
Client Request (Cursor/Cline/Codex/Claude Code)
  → OmniRoute API (/v1/chat/completions)
    → Handler (open-sse/handlers/chat.ts)
      → Credential Selection (src/sse/services/auth.ts)
        → Account Selector (open-sse/services/accountSelector.ts)
        → Account Fallback (open-sse/services/accountFallback.ts)
      → Executor (open-sse/executors/<provider>.ts)
        → Browser Path (PRIMARY)
          → runBrowserAutomation() → Browserless/CDP
          → page.evaluate() for in-browser API calls
          → UI automation fallback
        → Direct HTTP Path (FALLBACK)
          → fetch() to provider API
        → Tool-Call Parsing (open-sse/translator/robustWebTools.ts)
      → Response Translation → SSE/JSON → Client
```

---

## 4. Web-Cookie Provider Registry

Every web-cookie provider in the LEV fork MUST follow the browser-first
pattern. The registry below tracks the current state of each provider.

| Provider       | Executor File       | Browser Path       | Direct HTTP Path   | Tool Parsing       | Status        |
| -------------- | ------------------- | ------------------ | ------------------ | ------------------ | ------------- |
| deepseek-web   | `deepseek-web.ts`   | In-browser API     | Direct fetch       | `deepseekWebTools` | Production    |
| qwen-web       | `qwen-web.ts`       | UI automation      | Direct fetch       | `robustWebTools`   | Browser-first |
| gemini-web     | `gemini-web.ts`     | Playwright context | Persistent browser | `robustWebTools`   | Browser-first |
| t3-chat-web    | `t3-chat-web.ts`    | UI automation      | Direct fetch       | `robustWebTools`   | Browser-first |
| perplexity-web | `perplexity-web.ts` | UI automation      | TLS-impersonated   | `robustWebTools`   | Browser-first |
| zai-web        | `zai-web.ts`        | UI automation      | Signed direct      | `robustWebTools`   | Browser-first |
| huggingchat    | `huggingchat.ts`    | WebSessionDriver   | Direct JSONL       | `robustWebTools`   | Browser-first |
| chatgpt-web    | `chatgpt-web.ts`    | In-browser API     | —                  | `chatgptWebTools`  | Browser-only  |
| claude-web     | `claude-web.ts`     | Browser transport  | —                  | —                  | Browser-only  |
| blackbox-web   | `blackbox-web.ts`   | UI automation      | Direct fetch       | `robustWebTools`   | Browser-first |
| duckduckgo-web | `duckduckgo-web.ts` | browserBackedChat  | —                  | `robustWebTools`   | Browser-only  |
| adapta-web     | `adapta-web.ts`     | UI automation      | Direct fetch       | `robustWebTools`   | Browser-first |
| muse-spark-web | `muse-spark-web.ts` | UI automation      | Direct fetch       | `robustWebTools`   | Browser-first |
| grok-web       | `grok-web.ts`       | grokClearance      | Direct fetch       | —                  | Browser-first |

---

## 5. Hard Rules (LEV Fork Additions)

These rules are ADDITIONS to the upstream OmniRoute Hard Rules (#1-#23 in
`AGENTS.md`). They apply ONLY to the LEV fork and are numbered starting at #LEV-1.

### LEV-1: Browser-First Execution Order

Every web-cookie provider's `execute()` method MUST call the browser path
before the direct HTTP path. Violating this rule breaks the core architecture.

### LEV-2: No Direct-HTTP-Only Providers

No web-cookie provider may be implemented as direct-HTTP-only. If a provider
has no browser path, it MUST be documented with a technical justification in
the executor file and in the registry above.

### LEV-3: Shared Tool-Call Parsing

All web-cookie providers that support tool-mode MUST use
`parseAndRecoverToolCalls()` from `robustWebTools.ts`. Provider-specific parsers
MAY add pre-processing but MUST delegate final parsing to the shared module.

### LEV-4: Error Classification

Provider-specific error detection MUST map to correct HTTP status codes:

- Account mute/ban → 429 (rate limit)
- Session expiry → 401 (auth)
- Quota exhausted → 429 (rate limit)
- Model unavailable → 503 (service unavailable)
- Empty response → 502 (bad gateway) with provider-specific message

### LEV-5: No Secrets in Logs

Account identifiers, cookies, tokens, and credentials MUST NOT appear in logs.
Use redacted fingerprints (first 8 chars) only. The `AUTH_LOG_INCLUDE_ACCOUNT_ID`
feature flag controls whether full account IDs are logged.

### LEV-6: Composition Over Inheritance

Provider executors MUST NOT inherit from base classes that contain
provider-specific logic. Shared behavior MUST be composed via imports of
standalone utility modules.

### LEV-7: Real Testing Only

All provider changes MUST be validated with real live LLM requests against the
production deployment. No mock tests for provider behavior. Unit tests for
shared utilities (parsing, selection, cooldown) are required.

---

## 6. Decision Framework

When adding a new web-cookie provider or modifying an existing one:

1. **Does it have a browser path?** If no, create one using `runBrowserAutomation()`.
2. **Is browser-first in `execute()`?** If no, swap the order.
3. **Does it support tools?** If yes, wire `robustWebTools.ts`.
4. **Does it have provider-specific errors?** If yes, add detection and status mapping.
5. **Does it compose shared utilities?** If no, refactor to composition.
6. **Is it tested live?** If no, run a real request against production.

---

## 7. Upstream Sync Policy

The LEV fork tracks upstream `diegosouzapw/OmniRoute`. When syncing:

1. **Never revert LEV fork architecture changes.** Browser-first order,
   robust tool parsing, and error classification MUST survive upstream sync.
2. **Conflict resolution priority:** LEV fork architecture > upstream bug fixes >
   upstream features > upstream refactors.
3. **Document syncs:** Every upstream sync MUST be a separate commit with
   `chore: sync upstream <commit-range>` message.
4. **Test after sync:** Run `npm run typecheck:core`, `npm run lint`, and live
   provider tests after every sync.
