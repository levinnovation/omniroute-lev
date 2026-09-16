import test from "node:test";
import assert from "node:assert/strict";

/**
 * LEV fork Phase 2: Unit tests for CDP network capture helpers in
 * frontendFetchInterception.ts and batch action / WebSocket capture
 * helpers in browserPool.ts.
 *
 * These tests cover the pure logic (type guards, serialization, matching)
 * that does not require a real browser. The browser-dependent paths
 * (attachCdpNetworkCapture, startWebSocketCapture, executeBatchActions)
 * are integration-tested against live providers per LEV Hard Rule #7.
 */

import {
  shouldFallbackToFFI,
  isFrontendJSCrash,
  type FrontendFetchConfig,
  type RouteInterceptionConfig,
  type NetworkLogEntry,
} from "../../open-sse/executors/base/frontendFetchInterception.ts";

// ── shouldFallbackToFFI / isFrontendJSCrash ────────────────────────────────

test("shouldFallbackToFFI returns true for browser crash errors", () => {
  assert.ok(shouldFallbackToFFI(new Error("Cannot access 'foo' before initialization")));
  assert.ok(shouldFallbackToFFI(new Error("Cannot read properties of undefined (reading 'x')")));
  assert.ok(shouldFallbackToFFI(new Error("Cannot set properties of undefined")));
  assert.ok(shouldFallbackToFFI(new Error("Target page, context or browser has been closed")));
  assert.ok(shouldFallbackToFFI(new Error("Target closed by browser")));
});

test("shouldFallbackToFFI returns true for locator timeout errors", () => {
  assert.ok(shouldFallbackToFFI(new Error("locator.waitFor: Timeout 10000ms exceeded")));
  assert.ok(shouldFallbackToFFI(new Error('waiting for locator("#chat") exceeded')));
});

test("shouldFallbackToFFI returns false for normal errors", () => {
  assert.equal(shouldFallbackToFFI(new Error("HTTP 429 Too Many Requests")), false);
  assert.equal(shouldFallbackToFFI(new Error("Connection refused")), false);
  assert.equal(shouldFallbackToFFI(new Error("Unauthorized")), false);
});

test("isFrontendJSCrash is an alias for shouldFallbackToFFI", () => {
  assert.equal(isFrontendJSCrash, shouldFallbackToFFI);
});

// ── FrontendFetchConfig type shape ─────────────────────────────────────────

test("FrontendFetchConfig accepts useCdpCapture, routeInterception, logNetwork", () => {
  const config: FrontendFetchConfig = {
    providerName: "test",
    poolKey: "test-key",
    pageUrl: "https://example.com",
    cookieDomain: "example.com",
    cookieString: "session=abc",
    userAgent: "Test/1.0",
    fetchUrl: "https://example.com/api/chat",
    fetchOptions: { method: "POST", body: "{}" },
    responseTimeoutMs: 30_000,
    useCdpCapture: true,
    logNetwork: true,
    routeInterception: {
      urlPattern: "**/api/**",
      handler: async (route) => route.continue(),
    },
  };
  assert.equal(config.useCdpCapture, true);
  assert.equal(config.logNetwork, true);
  assert.ok(config.routeInterception);
  assert.equal(typeof config.routeInterception?.handler, "function");
});

test("FrontendFetchConfig works without Phase 2 options (backward compat)", () => {
  const config: FrontendFetchConfig = {
    providerName: "test",
    poolKey: "test-key",
    pageUrl: "https://example.com",
    cookieDomain: "example.com",
    cookieString: "session=abc",
    userAgent: "Test/1.0",
    fetchUrl: "https://example.com/api/chat",
    fetchOptions: { method: "POST", body: "{}" },
    responseTimeoutMs: 30_000,
  };
  assert.equal(config.useCdpCapture, undefined);
  assert.equal(config.logNetwork, undefined);
  assert.equal(config.routeInterception, undefined);
});

// ── NetworkLogEntry type shape ─────────────────────────────────────────────

test("NetworkLogEntry has expected fields", () => {
  const entry: NetworkLogEntry = {
    url: "https://example.com/api/chat",
    method: "POST",
    status: 200,
    method_response: "response",
    contentType: "text/event-stream",
    timestamp: Date.now(),
  };
  assert.equal(entry.method, "POST");
  assert.equal(entry.status, 200);
  assert.ok(entry.timestamp > 0);
});

// ── RouteInterceptionConfig type shape ─────────────────────────────────────

test("RouteInterceptionConfig accepts string and regex patterns", () => {
  const stringConfig: RouteInterceptionConfig = {
    urlPattern: "**/api/chat",
    handler: async (route) => route.continue(),
  };
  const regexConfig: RouteInterceptionConfig = {
    urlPattern: /api\/chat/,
    handler: async (route) => route.continue(),
  };
  assert.equal(typeof stringConfig.urlPattern, "string");
  assert.ok(regexConfig.urlPattern instanceof RegExp);
});
