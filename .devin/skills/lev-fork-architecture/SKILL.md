---
name: lev-fork-architecture
description: LEV fork architecture for OmniRoute web-cookie providers. Use when creating, modifying, or debugging web-cookie provider executors, browser automation transport, tool-call parsing, or account selection in the omniroute-lev fork.
keywords:
  - omniroute
  - web-provider
  - browser-automation
  - tool-call
  - executor
  - lev-fork
  - qwen-web
  - gemini-web
  - deepseek-web
---

# LEV Fork Architecture Skill

## When to Use

Activate this skill when:

- Creating or modifying a web-cookie provider executor (`open-sse/executors/*-web.ts`)
- Debugging browser automation failures in web-cookie providers
- Adding tool-call support to a web-cookie provider
- Changing account selection or fallback behavior
- Working on the `omniroute-lev` fork (branch `lev/main`)

## Core Rules

1. **Browser-First (LEV-1):** Every web-cookie provider's `execute()` MUST call
   `executeViaBrowser()` before `executeViaDirectHttp()`.
2. **Composition Over Inheritance (LEV-6):** Import shared utilities, do not
   extend base classes with provider-specific logic.
3. **Shared Tool Parsing (LEV-3):** Use `robustWebTools.ts` for all tool-call
   parsing in web-cookie providers.
4. **Error Classification (LEV-4):** Map provider-specific errors to correct
   HTTP status codes (mute→429, expiry→401, quota→429).
5. **No Mockups (LEV-7):** All code must be production-ready, tested with real
   live LLM requests.

## Key Files

- `docs/architecture/LEV-FORK-CONSTITUTION.md` — governing principles and hard rules
- `docs/architecture/WEB-PROVIDER-BROWSER-ARCHITECTURE.md` — transport layers and execution order
- `docs/architecture/PROVIDER-EXECUTOR-COMPOSITION.md` — composition patterns and templates
- `open-sse/executors/base/browserAutomationFallback.ts` — `runBrowserAutomation()`
- `open-sse/translator/robustWebTools.ts` — `parseAndRecoverToolCalls()`
- `open-sse/services/accountSelector.ts` — account selection strategies
- `open-sse/services/accountFallback.ts` — cooldown and rotation

## Execution Order Template

```ts
async execute(input: ExecuteInput) {
  const browserResult = await this.executeViaBrowser(input);  // PRIMARY
  if (browserResult) return browserResult;
  const directResult = await this.executeViaDirectHttp(input); // FALLBACK
  if (directResult) return directResult;
  return makeErrorResult(502, "both browser and HTTP failed", ...);
}
```

## Provider Registry

| Provider       | Browser Path       | Status        |
| -------------- | ------------------ | ------------- |
| deepseek-web   | In-browser API     | Production    |
| qwen-web       | UI automation      | Browser-first |
| gemini-web     | Playwright context | Browser-first |
| t3-chat-web    | UI automation      | Browser-first |
| perplexity-web | UI automation      | Browser-first |
| zai-web        | UI automation      | Browser-first |
| huggingchat    | WebSessionDriver   | Browser-first |
| chatgpt-web    | In-browser API     | Browser-only  |
| claude-web     | Browser transport  | Browser-only  |
| blackbox-web   | UI automation      | Browser-first |
| duckduckgo-web | browserBackedChat  | Browser-only  |
| adapta-web     | UI automation      | Browser-first |
| muse-spark-web | UI automation      | Browser-first |
| grok-web       | grokClearance      | Browser-first |

## Environment Variables

- `OMNIROUTE_BROWSER_POOL=on` — enable browser automation
- `OMNIROUTE_BROWSERLESS_URL` — Browserless sidecar URL
- `OMNIROUTE_BROWSERLESS_TOKEN` — Browserless auth token

## Deployment

- Railway project: `omniroute-llm-gateway`
- Public URL: `https://omniroute.agentyx.one`
- Branch: `lev/main`
- Deploy command: `railway redeploy --yes`
- Logs: `railway logs`
