---
title: "Provider Executor Composition Guide"
version: 3.8.51
lastUpdated: 2026-09-02
---

# Provider Executor Composition Guide

> **How to build and maintain provider executors using composition over
> inheritance.** This guide shows the shared utilities every executor should
> compose, with concrete code patterns from the LEV fork.

---

## 1. Why Composition Over Inheritance

The upstream OmniRoute has a `WebCookieExecutorBase` class that some providers
extend. The LEV fork moves away from this pattern because:

1. **Inheritance couples providers to base class changes.** When the base class
   changes, all providers break — even ones that don't need the changed behavior.
2. **Inheritance hides which utilities a provider actually uses.** You have to
   read the base class to know what's available.
3. **Inheritance prevents selective composition.** A provider that only needs
   cookie building still inherits account selection, retry logic, and error
   handling it may not want.
4. **Composition is testable in isolation.** Each utility module can be tested
   independently without mocking a base class hierarchy.

---

## 2. Shared Utility Modules

### 2.1 Browser Automation

**File:** `open-sse/executors/base/browserAutomationFallback.ts`

**Exports:**

```ts
// Check if browser pool is enabled
function isBrowserAutomationEnabled(): boolean;

// Run browser automation (UI fill + response intercept)
async function runBrowserAutomation(
  config: BrowserAutomationConfig
): Promise<BrowserAutomationResult | null>;

// Types
interface BrowserAutomationConfig {
  providerName: string;
  poolKey: string;
  pageUrl: string;
  cookieDomain: string;
  cookieString: string;
  userAgent: string;
  inputSelector: string;
  submitSelector: string;
  prompt: string;
  responseUrlMatch: RegExp | ((url: string) => boolean);
  responseTimeoutMs: number;
  postSubmitWaitMs: number;
  fillMode?: "evaluate" | "type";
  log?: LogFn;
  signal?: AbortSignal;
}

interface BrowserAutomationResult {
  status: number;
  body: string;
  contentType: string;
  headers: Record<string, string>;
}
```

**Usage:**

```ts
import { runBrowserAutomation, isBrowserAutomationEnabled } from "./base/browserAutomationFallback";

private async executeViaBrowser(input: ExecuteInput) {
  if (!isBrowserAutomationEnabled()) return null;
  const result = await runBrowserAutomation({
    providerName: "my-provider-web",
    poolKey: `my-provider-web:${token.slice(0, 24)}`,
    pageUrl: "https://chat.my-provider.ai/",
    cookieDomain: "my-provider.ai",
    cookieString: cookieHeader,
    userAgent: USER_AGENT,
    inputSelector: "textarea#chat-input",
    submitSelector: 'button[data-testid="send-button"]',
    prompt,
    responseUrlMatch: /\/api\/chat\/completions/,
    responseTimeoutMs: 60_000,
    postSubmitWaitMs: 30_000,
    fillMode: "evaluate",
    log,
    signal,
  });
  if (!result || result.status >= 300) return null;
  // Process result.body as SSE stream
}
```

### 2.2 Robust Tool-Call Parsing

**File:** `open-sse/translator/robustWebTools.ts`

**Exports:**

```ts
// Parse tool calls from model output (handles XML, bare JSON, narrated intent)
function parseAndRecoverToolCalls(
  content: string,
  reasoning: string,
  tools?: ToolDefinition[]
): ParsedToolCall[];

// Check if text looks like narrated tool intent
function looksLikeNarratedIntent(text: string): boolean;

// Synthesize a Grep tool call from narrated intent
function synthesizeGrepToolCall(text: string, tools?: ToolDefinition[]): ParsedToolCall | null;

// Build OpenAI-compatible tool-call response
function buildRobustToolAwareResult(
  toolCalls: ParsedToolCall[],
  content: string,
  reasoning: string,
  body: Record<string, unknown>,
  url: string
): ExecutorExecuteResult;
```

**Usage:**

```ts
import { parseAndRecoverToolCalls, buildRobustToolAwareResult } from "../translator/robustWebTools";

if (hasTools) {
  const toolCalls = parseAndRecoverToolCalls(content, reasoning, requestedTools);
  if (toolCalls.length > 0) {
    return buildRobustToolAwareResult(toolCalls, content, reasoning, bodyObj, url);
  }
}
```

### 2.3 Account Selection

**File:** `open-sse/services/accountSelector.ts`

**Exports:**

```ts
// Select an account from a list using a strategy
function selectAccount<T extends { id: string }>(
  accounts: T[],
  strategy: "fill-first" | "round-robin" | "p2c" | "random",
  context?: SelectionContext
): T | null;
```

**Usage:**

```ts
import { selectAccount } from "../services/accountSelector";

// The selector is called by getProviderCredentials() in auth.ts
// Executors typically don't call this directly — they receive credentials
// from the handler. But if you need manual selection:
const account = selectAccount(activeAccounts, "p2c", { excludeConnectionId });
```

### 2.4 Account Fallback and Cooldown

**File:** `open-sse/services/accountFallback.ts`

**Exports:**

```ts
// Check if an account is evicted (terminal state)
function isAccountEvicted(provider: string, accountId: string): boolean;

// Check if an account is ready (not cooling down)
function isAccountReady(provider: string, accountId: string): boolean;

// Pick the next available account
function pickAccount(provider: string, excludeIds?: string[]): string | null;

// Mark an account as cooling down
function markCooldown(provider: string, accountId: string, error: ErrorInfo): void;

// Mark an account as successful (clear cooldown)
function markSuccess(provider: string, accountId: string): void;

// Check if a network error is rotatable
function isNetworkErrorRotatable(error: ErrorInfo): boolean;
```

### 2.5 Error Building

**File:** `open-sse/utils/error.ts` (or equivalent)

**Usage:**

```ts
import { makeErrorResult } from "../utils/error";

return makeErrorResult(
  429,
  "Account is muted by DeepSeek until 2026-09-03T11:47:02Z",
  bodyObj,
  url
);
```

---

## 3. Executor Template (Composition Pattern)

```ts
// open-sse/executors/my-provider-web.ts

import { runBrowserAutomation, isBrowserAutomationEnabled } from "./base/browserAutomationFallback";
import { parseAndRecoverToolCalls, buildRobustToolAwareResult } from "../translator/robustWebTools";
import { makeErrorResult } from "../utils/error";
import { buildMyProviderCookieHeader, extractMyProviderToken } from "./my-provider-web-utils";

const BASE_URL = "https://chat.my-provider.ai";
const API_URL = "https://chat.my-provider.ai/api/chat/completions";
const USER_AGENT = "Mozilla/5.0 ...";

export class MyProviderWebExecutor {
  async execute(input: ExecuteInput): Promise<ExecutorExecuteResult> {
    // LEV-1: Browser first, direct HTTP fallback
    const browserResult = await this.executeViaBrowser(input);
    if (browserResult) return browserResult;

    const directResult = await this.executeViaDirectHttp(input);
    if (directResult) return directResult;

    return makeErrorResult(
      502,
      "my-provider-web: both browser automation and direct HTTP failed",
      input.body as Record<string, unknown>,
      API_URL
    );
  }

  private async executeViaBrowser(input: ExecuteInput): Promise<ExecutorExecuteResult | null> {
    if (!isBrowserAutomationEnabled()) return null;

    const { credentials, signal, log, body } = input;
    const rawCred = String(credentials?.apiKey ?? "").trim();
    const cookieHeader = buildMyProviderCookieHeader(rawCred);
    let token = extractMyProviderToken(rawCred);
    if (!token && !cookieHeader) return null;

    const messages = (body as Record<string, unknown>).messages as Message[];
    const prompt = this.foldMessages(messages);

    const result = await runBrowserAutomation({
      providerName: "my-provider-web",
      poolKey: `my-provider-web:${token?.slice(0, 24) ?? "no-token"}`,
      pageUrl: `${BASE_URL}/`,
      cookieDomain: "my-provider.ai",
      cookieString: cookieHeader,
      userAgent: USER_AGENT,
      inputSelector: "textarea#chat-input",
      submitSelector: 'button[data-testid="send-button"]',
      prompt,
      responseUrlMatch: /\/api\/chat\/completions/,
      responseTimeoutMs: 60_000,
      postSubmitWaitMs: 30_000,
      fillMode: "evaluate",
      log,
      signal,
    });

    if (!result || result.status >= 300) return null;

    // Process the response
    const upstream = new Response(new Uint8Array(Buffer.from(result.body)), {
      status: result.status,
      headers: { "Content-Type": result.contentType || "text/event-stream" },
    });

    const { content, reasoning } = await this.collectStream(upstream);
    if (!content.trim() && !reasoning.trim()) return null;

    // Tool-call parsing (LEV-3)
    const hasTools = !!(body as Record<string, unknown>).tools;
    if (hasTools) {
      const toolCalls = parseAndRecoverToolCalls(content, reasoning);
      if (toolCalls.length > 0) {
        return buildRobustToolAwareResult(
          toolCalls,
          content,
          reasoning,
          body as Record<string, unknown>,
          API_URL
        );
      }
    }

    return {
      response: new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        })
      ),
      url: API_URL,
      headers: { "X-OmniRoute-Transport": "browser" },
      transformedBody: { browser_backed: true },
    };
  }

  private async executeViaDirectHttp(input: ExecuteInput): Promise<ExecutorExecuteResult | null> {
    const { credentials, signal, body } = input;
    const rawCred = String(credentials?.apiKey ?? "").trim();
    const cookieHeader = buildMyProviderCookieHeader(rawCred);
    let token = extractMyProviderToken(rawCred);
    if (!token && !cookieHeader) return null;

    const messages = (body as Record<string, unknown>).messages as Message[];
    const prompt = this.foldMessages(messages);

    try {
      const upstream = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Cookie: cookieHeader,
        },
        body: JSON.stringify({ prompt, model: "default" }),
        signal,
      });

      if (!upstream.ok) return null;

      const { content, reasoning } = await this.collectStream(upstream);
      if (!content.trim() && !reasoning.trim()) return null;

      return {
        response: new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          })
        ),
        url: API_URL,
        headers: { "X-OmniRoute-Transport": "direct-http" },
        transformedBody: { browser_backed: false },
      };
    } catch {
      return null;
    }
  }

  private foldMessages(messages: Message[]): string {
    return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  }

  private async collectStream(response: Response): Promise<{ content: string; reasoning: string }> {
    // Provider-specific SSE/JSON parsing
    // ...
    return { content: "", reasoning: "" };
  }
}
```

---

## 4. Anti-Patterns to Avoid

### 4.1 Direct HTTP First

```ts
// BAD — violates LEV-1
async execute(input: ExecuteInput) {
  const directResult = await this.executeViaDirectHttp(input);  // ← WRONG ORDER
  if (directResult) return directResult;
  const browserResult = await this.executeViaBrowser(input);
  if (browserResult) return browserResult;
}
```

### 4.2 Inheriting Provider-Specific Logic

```ts
// BAD — tight coupling, hidden dependencies
class QwenWebExecutor extends WebCookieExecutorBase {
  // base class has qwen-specific cookie logic baked in
  // changing the base class breaks all providers
}
```

### 4.3 Skipping Tool-Call Parsing

```ts
// BAD — violates LEV-3, agentic clients won't get tool_calls
if (hasTools) {
  // just return content as-is, no parsing
  return { response: ..., ... };
}
```

### 4.4 Generic Error Messages

```ts
// BAD — not actionable
return makeErrorResult(502, "request failed", body, url);

// GOOD — actionable
return makeErrorResult(429, "Account is muted by DeepSeek until 2026-09-03T11:47:02Z", body, url);
```

### 4.5 Mock Implementations

```ts
// BAD — violates LEV-7
if (process.env.NODE_ENV === "test") {
  return { response: new Response('{"choices":[{"message":{"content":"mock"}}]}'), ... };
}
```

---

## 5. Testing Executors

### 5.1 Unit Tests for Shared Utilities

Test `robustWebTools.ts`, `accountSelector.ts`, `accountFallback.ts` in
isolation:

```ts
// tests/unit/robustWebTools.test.ts
import { parseAndRecoverToolCalls } from "../../open-sse/translator/robustWebTools";

test("parses bare JSON tool call", () => {
  const content = '{"name":"Shell","arguments":{"command":"ls"}}';
  const result = parseAndRecoverToolCalls(content, "");
  expect(result).toHaveLength(1);
  expect(result[0].name).toBe("Shell");
});
```

### 5.2 Live Tests for Providers

Test providers with real requests against the production deployment:

```bash
# Simple completion
curl -s -X POST https://omniroute.agentyx.one/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -d '{"model":"qwen-web/qwen3.8-max","messages":[{"role":"user","content":"Say hello"}],"stream":false}'

# Tool-call test
curl -s -X POST https://omniroute.agentyx.one/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -d '{
    "model": "qwen-web/qwen3.8-max",
    "messages": [{"role": "user", "content": "List files in current directory"}],
    "tools": [{"type": "function", "function": {"name": "Shell", "parameters": {"command": {"type": "string"}}}}],
    "stream": false
  }'
```

### 5.3 Browser Path Verification

Check logs for browser transport indicators:

```
[INFO] Browser-backed API success: 1234 bytes ...
[INFO] X-OmniRoute-Transport: browser
```

If logs show `X-OmniRoute-Transport: direct-http` for a web-cookie provider,
the browser path is failing and needs debugging.
