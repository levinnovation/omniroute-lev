import test from "node:test";
import assert from "node:assert/strict";

/**
 * LEV fork Phase 3: Unit tests for Scrapling sidecar configuration and
 * WAF detection helpers in sidecars.ts and browserAutomationFallback.ts.
 */

import {
  getScraplingConfig,
  isWafBlocked,
  type ScraplingFetchRequest,
  type ScraplingFetchResult,
} from "../../open-sse/services/sidecars.ts";

import {
  shouldRetryViaScrapling,
  type ScraplingFallbackRequest,
} from "../../open-sse/executors/base/browserAutomationFallback.ts";

// ── getScraplingConfig ─────────────────────────────────────────────────────

test("getScraplingConfig returns null when OMNIROUTE_SCRAPLING_URL is unset", () => {
  delete process.env.OMNIROUTE_SCRAPLING_URL;
  delete process.env.OMNIROUTE_SCRAPLING_KEY;
  const config = getScraplingConfig();
  assert.equal(config, null);
});

test("getScraplingConfig returns config when OMNIROUTE_SCRAPLING_URL is set", () => {
  process.env.OMNIROUTE_SCRAPLING_URL = "http://scrapling-fetcher.railway.internal:8000";
  process.env.OMNIROUTE_SCRAPLING_KEY = "test-key";
  try {
    const config = getScraplingConfig();
    assert.ok(config);
    assert.equal(config?.url, "http://scrapling-fetcher.railway.internal:8000");
    assert.equal(config?.apiKey, "test-key");
    assert.equal(config?.timeoutMs, 30000);
  } finally {
    delete process.env.OMNIROUTE_SCRAPLING_URL;
    delete process.env.OMNIROUTE_SCRAPLING_KEY;
  }
});

test("getScraplingConfig works without an API key", () => {
  process.env.OMNIROUTE_SCRAPLING_URL = "http://scrapling-fetcher.railway.internal:8000";
  delete process.env.OMNIROUTE_SCRAPLING_KEY;
  try {
    const config = getScraplingConfig();
    assert.ok(config);
    assert.equal(config?.apiKey, undefined);
  } finally {
    delete process.env.OMNIROUTE_SCRAPLING_URL;
  }
});

// ── isWafBlocked ───────────────────────────────────────────────────────────

test("isWafBlocked returns true for Cloudflare 403", () => {
  assert.ok(isWafBlocked(403, { server: "cloudflare" }, "Access denied - cf-challenge"));
});

test("isWafBlocked returns true for Cloudflare 403 with cf-ray header in body", () => {
  assert.ok(isWafBlocked(403, { server: "cloudflare" }, "cf-ray: 12345"));
});

test("isWafBlocked returns true for DataDome 403", () => {
  assert.ok(isWafBlocked(403, { "x-datadome": "abc123" }, "DataDome challenge"));
});

test("isWafBlocked returns true for Cloudflare 429", () => {
  assert.ok(isWafBlocked(429, { server: "cloudflare" }, "Rate limited"));
});

test("isWafBlocked returns false for normal 403", () => {
  assert.equal(isWafBlocked(403, { server: "nginx" }, "Unauthorized"), false);
});

test("isWafBlocked returns false for normal 200", () => {
  assert.equal(isWafBlocked(200, { server: "nginx" }, "OK"), false);
});

test("isWafBlocked returns false for normal 429", () => {
  assert.equal(isWafBlocked(429, { server: "nginx" }, "Too Many Requests"), false);
});

// ── shouldRetryViaScrapling ────────────────────────────────────────────────

test("shouldRetryViaScrapling delegates to isWafBlocked", () => {
  assert.ok(shouldRetryViaScrapling(403, { server: "cloudflare" }, "cf-challenge"));
  assert.equal(shouldRetryViaScrapling(200, {}, "OK"), false);
});

// ── Type shape tests ───────────────────────────────────────────────────────

test("ScraplingFetchRequest has expected fields", () => {
  const req: ScraplingFetchRequest = {
    url: "https://example.com/api/chat",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"message":"hello"}',
    impersonate: "chrome131",
    timeoutMs: 30000,
  };
  assert.equal(req.method, "POST");
  assert.equal(req.impersonate, "chrome131");
});

test("ScraplingFetchResult has expected fields", () => {
  const result: ScraplingFetchResult = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: "data: hello\n\n",
    contentType: "text/event-stream",
    elapsedMs: 150,
  };
  assert.equal(result.status, 200);
  assert.ok(result.elapsedMs >= 0);
});

test("ScraplingFallbackRequest has expected fields", () => {
  const req: ScraplingFallbackRequest = {
    providerName: "test-provider",
    url: "https://example.com/api/chat",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"message":"hello"}',
  };
  assert.equal(req.providerName, "test-provider");
});
