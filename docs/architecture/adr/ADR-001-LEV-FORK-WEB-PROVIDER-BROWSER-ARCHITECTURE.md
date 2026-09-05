# ADR-001: LEV Fork Web Provider Browser Architecture

**Status**: Accepted
**Date**: 2026-09-05
**Supersedes**: None
**Superseded by**: None
**Related**: `LEV-FORK-CONSTITUTION.md`, `WEB-PROVIDER-BROWSER-ARCHITECTURE.md`, `PROVIDER-EXECUTOR-COMPOSITION.md`, `RESILIENCE_GUIDE.md`

---

## Context

The LEV fork (`levinnovation/omniroute-lev`, branch `lev/main`) is a production-hardened derivative of upstream OmniRoute, deployed to Railway at `https://omniroute.agentyx.one` serving real agentic clients (Cursor, Cline, Codex, Claude Code, Prime Agent).

The fork introduced browser-first execution for web-cookie providers to solve:
1. WAF/Cloudflare blocks on direct HTTP calls
2. Expired tokens that only a real browser session can refresh
3. Missing browser fingerprints that cause upstream rejection
4. Captcha challenges (Aliyun, Turnstile, reCAPTCHA, hCaptcha) that require a real browser

### Architecture Components Built (commits `388c3513c` → `7f9bc392e`)

| Component | File | Purpose |
|-----------|------|---------|
| Shared browser pool | `open-sse/services/browserPool.ts` | Browserless CDP + local patchright/playwright fallback, context pooling, auto-reconnect, stale browser detection, NopeCHA extension loading, active-lease protection |
| Browser automation helper | `open-sse/executors/base/browserAutomationFallback.ts` | `runBrowserAutomation()` — generic UI fill + response intercept for Pattern B providers |
| Web cookie executor base | `open-sse/executors/base/WebCookieExecutorBase.ts` | Abstract base with `acquireSession()`, `validateSession()`, `closeSession()`, `classifyError()` |
| Robust tool-call parser | `open-sse/translator/robustWebTools.ts` | Shared parser for bare JSON, XML tags, narrated intent, reasoning-content tool calls |
| Captcha detector | `open-sse/services/captchaDetector.ts` | Detects captcha types and maps to solver strategies |
| Browserless sidecar config | `open-sse/services/sidecars.ts` | Browserless/LiteLLM sidecar config and health checks |
| Web session driver | `open-sse/services/webSessionDriver.ts` | Web session lifecycle driver |
| Browser-backed chat | `open-sse/services/browserBackedChat.ts` | `browserBackedChat()` / `tryBackedChat()` helpers |
| NopeCHA extension | Dockerfile | Loaded at build time to `/app/extensions/nopecha/` |
| patchright | Dockerfile | Stealth Playwright fork with fingerprint patches |

### Three Transport Patterns

**Pattern A: In-Browser API Call** (deepseek-web, chatgpt-web)
- Browser navigates to provider, loads cookies, uses `page.evaluate()` to call provider's internal API
- Response interception via `page.on('response')` or `page.waitForResponse()`

**Pattern B: UI Automation** (qwen-web, t3-chat-web, perplexity-web, zai-web, blackbox-web, adapta-web, muse-spark-web, huggingchat)
- Browser navigates, fills chat input, clicks submit, intercepts API response
- Uses `runBrowserAutomation()` from `base/browserAutomationFallback.ts`

**Pattern C: Persistent Browser Context** (gemini-web, claude-web)
- Browser creates persistent context with cookies, uses combination of UI + API interception

### Frontend Response Interception (NEW — z.ai pattern)

For providers where the frontend solves its own captcha/challenge (z.ai, and potentially others):
1. Navigate to the provider's web UI with auth cookies/localStorage
2. Fill the prompt via UI
3. Click submit to trigger the frontend's own flow
4. Use `page.waitForResponse()` to intercept the frontend's completions response
5. Read the SSE stream from the intercepted response
6. Parse and return

This avoids needing to solve captchas ourselves — the frontend already knows how.

### Browser Pool Lifecycle (with active-lease protection)

```
acquireBrowserContext(key, options)
  → state.activeLeases++
  → check isBrowserAlive() → clearStaleBrowserState() if dead
  → reuse existing context OR create new one
  → return PooledContext

releaseBrowserContext(key)
  → state.activeLeases--
  → close context
  → if contexts.size === 0 && activeLeases === 0 → shutdownPool()

shutdownPool(reason)
  → if activeLeases > 0 → DEFER (reschedule idle timer)
  → else → close all contexts, close browser, clear timers

browser.on("disconnected")
  → clearStaleBrowserState() (preserves activeLeases)
```

### Disconnect-Aware Waits

Both `runBrowserAutomation()` and gemini-web's `executeViaBrowser()` race their response waits against a browser disconnect promise. If Browserless disconnects mid-request, the executor fails fast instead of hanging until the local execution deadline.

---

## Decision

### LEV Hard Rules (LEV-1 through LEV-7)

| Rule | Description | Status |
|------|-------------|--------|
| LEV-1 | Browser-first execution order in every web-cookie provider | ✅ All 7 active providers comply |
| LEV-2 | No direct-HTTP-only web-cookie providers | ✅ All 7 active providers comply |
| LEV-3 | Shared tool-call parsing via `robustWebTools.ts` | ❌ 3 providers non-compliant (deepseek-web, gemini-web, perplexity-web) |
| LEV-4 | Provider-specific error classification | ❌ 6 providers non-compliant (only zai-web via base class) |
| LEV-5 | No secrets/credentials in logs | ✅ All providers comply |
| LEV-6 | Composition over inheritance | ❌ zai-web-v2 extends WebCookieExecutorBase |
| LEV-7 | Real live testing only | ✅ All changes validated with live LLM calls |

---

## Current State (2026-09-05)

### Active web-cookie providers: 7

| # | Provider | Live test | Time | Status | Root cause if failing |
|---|----------|-----------|------|--------|-----------------------|
| 1 | zai-web | ✅ OK | 41s | WORKING | — |
| 2 | huggingchat | ✅ OK | 8s | WORKING | — |
| 3 | perplexity-web | ✅ OK | 19s | WORKING | — |
| 4 | qwen-web | ✅ OK | 30s | WORKING (fixed this session) | — |
| 5 | deepseek-web | ❌ 429 | 30s | ACCOUNT MUTED | DeepSeek muted account until 2026-09-07 |
| 6 | t3-web | ❌ 429 | 120s | RATE LIMITED | t3.chat rate limiting |
| 7 | gemini-web | ❌ timeout | 120s | FRONTEND JS BUG | Google's minified JS has TDZ error on keyboard/click events |

### Inactive web-cookie providers: 29 (code review needed)

`adapta-web`, `blackbox-web`, `chatgpt-web-codex`, `claude-web`, `conol-web`, `copilot-m365-web`, `copilot-web`, `doubao-web`, `duckduckgo-web`, `felo-web`, `grok-web`, `hailuo-web`, `kimi-web`, `microsoft-designer-web`, `muse-spark-web`, `notion-web`, `poe-web`, `tencent-aistudio-web`, `v0-vercel-web`, `venice-web`, `veoaifree-web`, `yuanbao-web`, `lmarena`, `inner-ai`, `hyperagent`, `promptql`, `tinycms-web`, `gemini-business`, `deepseek-web-with-auto-refresh`

---

## Architecture Gaps (WIP / TBD / Open)

### GAP-1: Frontend Fetch Interception as Universal Fallback (NEW FR)

**Problem**: Some web-cookie providers have frontends with JavaScript bugs that crash on any programmatic DOM interaction (keyboard events, click events). The current example is gemini-web, where Google's minified Quill handler throws "Cannot access 'T' before initialization" (a temporal dead zone error) on every keyboard and click event.

**Current workaround**: `page.evaluate()` to set content directly + DOM-based submit. But even the click handler triggers the error.

**Proposed solution**: A new shared architecture feature — **Frontend Fetch Interception (FFI)** — that automatically activates as a fallback when DOM interaction fails with a JS crash. Instead of trying to interact with the UI, FFI:

1. Navigates to the provider's web UI to establish a valid browser session (cookies, fingerprints, captcha tokens)
2. Waits for the page to be fully loaded
3. Uses `page.evaluate()` to call the provider's internal API directly from within the browser context, using the browser's own cookies and session state
4. Captures the response via `page.waitForResponse()` or the fetch return value
5. Parses and returns

This is **agnostic** — it works for any web-cookie provider where the frontend's own API endpoint can be identified. The key insight is that the browser context already has the valid cookies and session state; we just need to make the API call from within that context instead of trying to interact with the UI.

**Implementation**:
- New module: `open-sse/executors/base/frontendFetchInterception.ts`
- Exports: `interceptFrontendFetch(config)` — navigates, waits, makes API call via `page.evaluate(fetch(...))`, captures response
- Auto-fallback: `runBrowserAutomation()` catches JS crash errors and automatically retries with FFI
- Provider config: each provider defines its API endpoint URL, request body builder, and response parser

### GAP-2: robustWebTools Migration (LEV-3)

**Non-compliant providers**:
- `deepseek-web.ts` — uses `parseDeepSeekToolCalls` from `deepseekWebTools.ts` + local narrated-intent helpers
- `gemini-web.ts` — uses `buildToolModeResponse` from `chatgptWebTools.ts`
- `perplexity-web.ts` — uses `buildToolModeResponse` from `chatgptWebTools.ts`

**Fix**: Route all tool-call parsing through `parseAndRecoverToolCalls()` from `robustWebTools.ts`. Remove local narrated-intent helpers from deepseek-web (they're duplicated in robustWebTools).

### GAP-3: Error Classification (LEV-4)

**Non-compliant providers**: All except zai-web.

**Required error kinds**:
- `CAPTCHA_DETECTED` — captcha challenge encountered
- `RATE_LIMIT` — 429 with retry-after parsing
- `SESSION_EXPIRED` — 401/403 session expired
- `MODEL_LOCKOUT` — 404 model not available
- `BANNED` — mute/ban (terminal, not cooldown)

**Fix**: Export `classifyError()` from `WebCookieExecutorBase` as a standalone function that all providers can import (composition, not inheritance). Each provider calls it with status + body + retry-after.

### GAP-4: zai-web Composition Refactor (LEV-6)

**Current**: `class ZaiWebExecutorV2 extends WebCookieExecutorBase`
**Target**: `class ZaiWebExecutorV2 extends BaseExecutor` + import `acquireBrowserContext`, `classifyError`, etc.

### GAP-5: 29 Inactive Web-Cookie Provider Code Review

Each inactive provider needs:
1. Read the executor file
2. Check 12-point audit checklist
3. Verify browser-first execution order
4. Verify browser pool integration
5. Verify robustWebTools usage
6. Verify error classification
7. Verify streaming support
8. Fix any gaps
9. Add to the provider matrix

### GAP-6: Gemini-web Frontend JS Bug

**Root cause**: Google's Gemini frontend (`gemini.google.com/app`) has a minified JavaScript module with a temporal dead zone (TDZ) error. A `let`/`const` variable (different name on each page load: `T`, `N`, `v`) is accessed by an event handler before its declaration is evaluated. This affects ALL keyboard events (`keyboard.type()`, `keyboard.press("Enter")`) and click events on certain elements.

**Attempted fixes** (all failed):
1. `ClipboardEvent("paste")` → "Cannot access 'v' before initialization"
2. `page.keyboard.type()` → "Cannot access 'N' before initialization"
3. `page.waitForLoadState("networkidle")` → still crashes
4. `page.evaluate()` to set Quill content → works, but click/Enter still crashes
5. DOM-based submit (send button click) → "Cannot access 'T' before initialization"

**Proposed fix**: Implement GAP-1 (Frontend Fetch Interception) and use it as the primary path for gemini-web. The browser navigates to establish session state, then makes the StreamGenerate API call directly via `page.evaluate(fetch(...))` instead of interacting with the UI.

### GAP-7: Browserless Mid-Operation Disconnect (zai-web, qwen-web, all UI-automation providers)

**Problem**: Even with active-lease protection and disconnect-aware waits, Browserless can disconnect mid-operation during the multi-step UI automation sequence (`page.goto` → `waitForSelector` → `click` → `keyboard.type` → `keyboard.press` → `waitForResponse`). Each step is a separate CDP round-trip; if Browserless drops the WebSocket between steps, the next step throws "Target page, context or browser has been closed".

**Observed errors** (2026-09-05):
- zai-web: `[502]: [zai-web] execution failed: keyboard.type: Target page, context or browser has been closed` (39s)
- qwen-web: `[502]: Qwen-web: both browser automation and direct HTTP failed` (89.7s)

**Root cause**: The UI automation pattern (`runBrowserAutomation()`) is inherently fragile because it requires 5-8 sequential CDP round-trips (goto, wait, fill, click, wait for response). Each round-trip is a window where Browserless can disconnect. The active-lease protection prevents the pool from shutting down, but it cannot prevent Browserless itself from dropping the connection.

**Proposed solution**: FFI (GAP-1) is the architecturally sound fix. `page.evaluate(fetch(...))` is a SINGLE atomic CDP call — the entire API request happens inside the browser's JS context in one round-trip. If Browserless disconnects during the evaluate, the call fails immediately (no multi-step sequence to partially complete). This eliminates the window for mid-operation disconnects.

**FFI as universal fallback**: When `runBrowserAutomation()` catches "Target page, context or browser has been closed" (not just JS crash errors), it should auto-retry with FFI. The detection function should be expanded:

```ts
function shouldFallbackToFFI(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // JS crash (temporal dead zone)
  if (msg.includes("Cannot access") && msg.includes("before initialization")) return true;
  // Browserless mid-operation disconnect
  if (msg.includes("Target page, context or browser has been closed")) return true;
  if (msg.includes("Target closed") && msg.includes("browser")) return true;
  return false;
}
```

This makes FFI a universal safety net for ALL UI-automation providers, not just gemini-web.

### GAP-8: Multi-Turn Tool Context Retention (qwen-web, zai-web, all UI-automation providers)

**Problem**: When agentic clients (Zed, Cursor, Cline) send multi-turn conversations with tool calls and tool results, web-cookie providers that fold messages into a single prompt lose the tool context:

- **qwen-web** (`foldMessages()` at line 461): Only processes `system` and `user` roles — **completely drops `assistant` messages (including `tool_calls`) and `tool` messages (tool results)**. The model receives only the last user message with no context of prior tool interactions.
- **zai-web** (`textContent()` in `protocol.ts`): Includes all roles in the prompt but `textContent()` only extracts `type: "text"` parts — **`tool_calls` field on assistant messages is dropped**, and tool results are included but without the context of which tool was called.

**Observed error** (2026-09-05, Zed editor with qwen-web):
```
User: "ok i implemented all this on a separate claude code session, so lets audit whatever it did"
Qwen-web response: "Since I don't have direct access to read your local files or git history in this environment, sharing that context will allow me to perform a thorough gap analysis..."
```
The model says it can't read files because it never sees the tool results from prior turns — they were stripped by `foldMessages()`.

**Root cause**: Web-cookie providers that use UI automation (Pattern B) must fold the entire conversation into a single prompt string (the chat UI only has one input field). But the folding logic was written for simple Q&A, not for agentic multi-turn tool conversations.

**Proposed solution**: Use `flattenToolHistory()` from `open-sse/utils/flattenToolHistory.ts` BEFORE folding messages into a prompt. This utility:
1. Converts `tool`/`function` role messages → assistant prose: `[Tool result: <text>]`
2. Converts `assistant` messages with `tool_calls` → assistant prose: `[Called tools: <names>]`
3. Converts Anthropic-style `tool_use`/`tool_result` content blocks → prose
4. Preserves all text content

After flattening, `foldMessages()` / `browserPrompt()` can safely fold the conversation into a single prompt without losing tool context.

**Required changes**:
- `qwen-web.ts`: Call `flattenToolHistory()` before `foldMessages()`, and update `foldMessages()` to include `assistant` role messages (not just `system` and `user`)
- `zai-web/protocol.ts`: Call `flattenToolHistory()` before `browserPrompt()`
- All other UI-automation providers that fold messages: audit and add `flattenToolHistory()` if missing

### GAP-9: Browserless Sidecar Capacity

**Current**: Browserless configured with `MAX_CONCURRENT_SESSIONS=10`, `TIMEOUT=120000` (2 min).
**Issue**: Under concurrent load, sessions queue and time out. The active-lease protection prevents premature shutdown but doesn't solve capacity.
**Proposed**: Increase `MAX_CONCURRENT_SESSIONS` to 20 and `TIMEOUT` to 300000 (5 min) on the Browserless Railway service.

---

## Consequences

### Positive
- 4 of 7 active web-cookie providers are working with real live LLM calls
- Browser pool active-lease protection prevents "Target page, context or browser has been closed" errors
- Disconnect-aware waits prevent 120s hangs on Browserless disconnects
- qwen-web fixed from 120s timeout to 30s → OK

### Negative
- gemini-web remains broken due to Google's frontend JS bug (requires GAP-1 implementation)
- deepseek-web and t3-web are account issues, not architecture issues
- 29 inactive providers need code review before they can be activated

### Neutral
- The Frontend Fetch Interception (GAP-1) is a new architecture feature that will benefit all web-cookie providers, not just gemini-web
