---
title: "Web Provider Browser Architecture"
version: 3.8.51
lastUpdated: 2026-09-02
---

# Web Provider Browser Architecture

> **Architecture specification for web-cookie provider executors in the LEV fork.**
> This document defines the transport layers, execution order, credential
> handling, and response processing that every web-cookie provider MUST follow.
> See [`LEV-FORK-CONSTITUTION.md`](./LEV-FORK-CONSTITUTION.md) for governing
> principles and hard rules.

---

## 1. Transport Layers

Every web-cookie provider has two transport layers:

### 1.1 Browser Transport (PRIMARY)

The browser transport uses a real browser context (Chromium via Browserless/CDP
or local Playwright) to interact with the provider. Three sub-patterns exist:

#### Pattern A: In-Browser API Call (deepseek-web, chatgpt-web)

The browser navigates to the provider's web UI, loads cookies, then uses
`page.evaluate()` to call the provider's internal API from within the browser
context. This gives us:

- Real browser fingerprint (TLS, headers, JS environment)
- Valid session cookies sent automatically
- WAF/Cloudflare bypass (real browser)
- Response interception via `page.on('response')`

```ts
// Pattern A: in-browser API call
const apiResult = await page.evaluate(async (payload) => {
  const res = await fetch("/api/v0/chat/completion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}, requestPayload);
```

#### Pattern B: UI Automation (qwen-web, t3-chat-web, perplexity-web, zai-web, blackbox-web, adapta-web, muse-spark-web)

The browser navigates to the provider's web UI, loads cookies, fills the chat
input field, clicks submit, and intercepts the API response via URL matching.
This uses `runBrowserAutomation()` from `base/browserAutomationFallback.ts`.

```ts
// Pattern B: UI automation via shared helper
const result = await runBrowserAutomation({
  providerName: "qwen-web",
  poolKey: `qwen-web:${token.slice(0, 24)}`,
  pageUrl: `${BASE_URL}/`,
  cookieDomain: "chat.qwen.ai",
  cookieString: cookieHeader,
  userAgent: USER_AGENT,
  inputSelector: "textarea#chat-input, textarea",
  submitSelector: 'button[data-testid="send-button"]',
  prompt,
  responseUrlMatch: /\/api\/v2\/chat\/completions/,
  responseTimeoutMs: 60_000,
  fillMode: "evaluate",
  log,
  signal,
});
```

#### Pattern C: Persistent Browser Context (gemini-web, claude-web, huggingchat)

The browser creates a persistent context with cookies, navigates to the
provider, and uses a combination of UI automation and API interception. This
pattern is used when the provider requires a full browser session state.

```ts
// Pattern C: persistent browser context
const browser = await browserPool.acquire(poolKey);
const context = await browser.newContext({ userAgent, viewport });
await context.addCookies(cookieList);
const page = await context.newPage();
await page.goto(GEMINI_URL);
// ... interact with page, intercept responses
```

### 1.2 Direct HTTP Transport (FALLBACK)

The direct HTTP transport uses `fetch()` to call the provider's API directly.
This is the fallback when browser automation is unavailable or fails.

```ts
// Direct HTTP fallback
const upstream = await fetch(completionUrl, {
  method: "POST",
  headers: this.buildApiHeaders(token, cookieHeader, chatId),
  body: JSON.stringify(msgPayload),
  signal,
});
```

**When to use direct HTTP:**

- Browser automation returns `null` (disabled, no credentials, or failed)
- Browser automation times out
- Browser automation returns an error response

**When NOT to use direct HTTP:**

- As the primary path for any web-cookie provider (violates LEV-1)
- For providers that require browser fingerprint/WAF bypass
- For providers with no direct API endpoint

---

## 2. Execution Order

Every web-cookie provider's `execute()` method MUST follow this order:

```ts
async execute(input: ExecuteInput) {
  // 1. Browser path (PRIMARY)
  const browserResult = await this.executeViaBrowser(input);
  if (browserResult) return browserResult;

  // 2. Direct HTTP path (FALLBACK)
  const directResult = await this.executeViaDirectHttp(input);
  if (directResult) return directResult;

  // 3. Error — both paths failed
  return makeErrorResult(502, "both browser automation and direct HTTP failed", ...);
}
```

**Why this order:**

- Browser path has higher success rate (real fingerprint, valid session)
- Direct HTTP fails on WAF/Cloudflare, expired tokens, missing fingerprint
- Falling back from browser to HTTP is safe; the reverse is not
- Browser path can detect provider-specific errors (mute, ban) that HTTP misses

---

## 3. Credential Handling

### 3.1 Credential Resolution

Credentials are resolved through `getProviderCredentials()` in
`src/sse/services/auth.ts`. The selector:

1. Loads active provider connections: `getCachedRawProviderConnections({ provider, isActive: true })`
2. Filters by cooldown: `rateLimitedUntil > Date.now()` → skip
3. Filters by status: `testStatus === "unavailable"` → skip
4. Applies selection strategy: `fill-first`, `round-robin`, `p2c`, `random`
5. Returns credentials with `apiKey`, `accessToken`, `providerSpecificData`

### 3.2 Cookie Extraction

Each provider has a cookie extraction utility that converts the raw credential
string into a browser-compatible cookie header or cookie list:

```ts
// qwen-web: buildQwenCookieHeader(rawCred) → "cna=...; ssxmod_itna=...; token=..."
// gemini-web: resolveGeminiWebCookie(credentials) → "__Secure-1PSID=...; __Secure-1PSIDTS=..."
// deepseek-web: buildDeepSeekCookieHeader(rawCred) → "userToken=...; cf_clearance=..."
```

### 3.3 Token Extraction

Some providers require a bearer token in addition to cookies:

```ts
let token = extractQwenToken(rawCred);
if (!token && credentials?.accessToken) token = String(credentials.accessToken).trim();
if (!token && !cookieHeader) return null; // can't proceed without either
```

---

## 4. Response Processing

### 4.1 Stream Collection

Browser responses are typically SSE streams. The executor collects the stream
into `content` and `reasoning` buffers:

```ts
const { content, reasoning } = await this.collectStream(upstream);
if (!content.trim() && !reasoning.trim()) return null; // empty → try fallback
```

### 4.2 Tool-Call Parsing

When the request includes tools, the response MUST be parsed through the shared
`robustWebTools.ts` module:

```ts
import { buildRobustToolAwareResult, parseAndRecoverToolCalls } from "../translator/robustWebTools";

if (hasTools) {
  const toolCalls = parseAndRecoverToolCalls(content, reasoning, requestedTools);
  if (toolCalls.length > 0) {
    return buildRobustToolAwareResult(toolCalls, content, reasoning, ...);
  }
}
```

The shared parser handles:

- `<tool>...</tool>` XML blocks
- Bare JSON tool calls: `{"name":"Shell","arguments":{"command":"..."}}`
- Tool calls in `content` field
- Tool calls in `reasoning_content` field
- Narrated intent: "I'll search for..." → synthesize Grep tool call
- Multi-tool calls in a single response

### 4.3 Error Detection

Provider-specific errors MUST be detected and classified:

```ts
// DeepSeek mute detection
const isDeepSeekError =
  bodyStr.length < 500 &&
  (bodyStr.includes('"biz_code"') || bodyStr.includes('"is_muted"'));
if (isDeepSeekError) {
  const payload = JSON.parse(bodyStr);
  if (payload.data?.biz_code === 5) {
    // Map to 429 rate-limit
    return makeErrorResult(429, `Account is muted until ${muteUntil}`, ...);
  }
}
```

---

## 5. Browser Pool Configuration

The browser pool is configured via environment variables:

| Env Var                           | Default | Purpose                           |
| --------------------------------- | ------- | --------------------------------- |
| `OMNIROUTE_BROWSER_POOL`          | `on`    | Enable/disable browser automation |
| `OMNIROUTE_BROWSERLESS_URL`       | —       | Browserless sidecar URL           |
| `OMNIROUTE_BROWSERLESS_TOKEN`     | —       | Browserless auth token            |
| `BROWSER_SESSION`                 | `true`  | Persistent browser sessions       |
| `RAILWAY_SERVICE_BROWSERLESS_URL` | —       | Railway internal browserless URL  |

**Pool behavior:**

- `OMNIROUTE_BROWSER_POOL=off` → `isBrowserAutomationEnabled()` returns false → all browser paths return `null` → direct HTTP only
- `OMNIROUTE_BROWSER_POOL=on` → browser paths active → Browserless/CDP used for remote, local Playwright for fallback

---

## 6. Adding a New Web-Cookie Provider

### Step 1: Create the Executor

Create `open-sse/executors/<provider>-web.ts`:

```ts
import { runBrowserAutomation, isBrowserAutomationEnabled } from "./base/browserAutomationFallback";
import { parseAndRecoverToolCalls, buildRobustToolAwareResult } from "../translator/robustWebTools";

export class MyProviderWebExecutor {
  async execute(input: ExecuteInput) {
    // Browser first
    const browserResult = await this.executeViaBrowser(input);
    if (browserResult) return browserResult;
    // Direct HTTP fallback
    const directResult = await this.executeViaDirectHttp(input);
    if (directResult) return directResult;
    return makeErrorResult(502, "both paths failed", input.body, URL);
  }

  private async executeViaBrowser(input: ExecuteInput) {
    if (!isBrowserAutomationEnabled()) return null;
    // ... use runBrowserAutomation or page.evaluate
  }

  private async executeViaDirectHttp(input: ExecuteInput) {
    // ... use fetch() to provider API
  }
}
```

### Step 2: Create Cookie/Token Utilities

Create `open-sse/executors/<provider>-web-utils.ts`:

```ts
export function buildMyProviderCookieHeader(rawCred: string): string { ... }
export function extractMyProviderToken(rawCred: string): string | null { ... }
```

### Step 3: Register the Executor

Add to the executor registry in `open-sse/executors/index.ts` (or equivalent).

### Step 4: Add to the Provider Registry

Update the registry table in [`LEV-FORK-CONSTITUTION.md`](./LEV-FORK-CONSTITUTION.md).

### Step 5: Test Live

Run a real request against the production deployment:

```bash
curl -s -X POST https://omniroute.agentyx.one/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -d '{"model":"<provider>-web/<model>","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

---

## 7. Debugging Browser Path Failures

When a web-cookie provider fails, check in this order:

1. **Is the browser pool enabled?** Check `OMNIROUTE_BROWSER_POOL` env var.
2. **Are credentials valid?** Check cookie expiry, token validity.
3. **Did the browser navigate?** Check Browserless logs for navigation errors.
4. **Did the browser find the input?** Check CSS selectors against current provider UI.
5. **Did the browser submit?** Check for button selector changes.
6. **Was the response intercepted?** Check `responseUrlMatch` regex against current API path.
7. **Was the response empty?** Check provider for mute/ban/quota errors.
8. **Did direct HTTP also fail?** Check direct HTTP error for provider-specific messages.

**Log tags to search:**

- `BROWSER` — browser pool events
- `BROWSERLESS` — Browserless sidecar events
- `<PROVIDER>-WEB` — provider-specific executor logs
- `AUTH` — credential selection and account status
- `CHAT` — request-level errors and retries
