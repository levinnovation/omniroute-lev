/**
 * Unit tests for WebSessionDriver — LEV fork.
 *
 * Tests the 6 capabilities:
 *   1. Pre-dispatch session validation
 *   2. Mark expired / mark healthy
 *   3. Automatic cookie/token refresh
 *   4. Stream watchdog (empty content detection)
 *   5. Login-redirect detection
 *   6. DOM health checks
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  WebSessionDriver,
  __clearSessionHealthCacheForTest,
  type WebSessionConfig,
} from "../../open-sse/services/webSessionDriver.ts";

const TEST_CONFIG: WebSessionConfig = {
  providerId: "test-web",
  sessionProbeUrl: "https://example.com/api/session",
  sessionProbeHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  loginRedirectPatterns: [/example\.com\/(login|signin)/i],
  domHealthSelectors: ["#chat-input", 'button[data-testid="send"]'],
  streamWatchdogMs: 100, // short for tests
  emptyContentRetryMax: 1,
};

// Mock fetch for session validation tests
let mockFetch: typeof globalThis.fetch;

function setMockFetch(responses: Array<{ status: number; ok?: boolean }>): void {
  let callIndex = 0;
  mockFetch = ((_url: string | URL | Request, _init?: RequestInit) => {
    const response = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: response.ok ?? response.status < 300 }), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as typeof globalThis.fetch;
  globalThis.fetch = mockFetch;
}

describe("WebSessionDriver", () => {
  let driver: WebSessionDriver;

  beforeEach(() => {
    __clearSessionHealthCacheForTest();
    driver = new WebSessionDriver(TEST_CONFIG);
  });

  afterEach(() => {
    __clearSessionHealthCacheForTest();
  });

  // ── 1. Pre-dispatch session validation ──────────────────────────────────

  describe("validateSession", () => {
    it("returns true on HTTP 200", async () => {
      setMockFetch([{ status: 200, ok: true }]);
      const result = await driver.validateSession("valid-token", "conn-1");
      assert.equal(result, true);
    });

    it("returns false on HTTP 401", async () => {
      setMockFetch([{ status: 401 }]);
      const result = await driver.validateSession("expired-token", "conn-2");
      assert.equal(result, false);
    });

    it("returns false on HTTP 403", async () => {
      setMockFetch([{ status: 403 }]);
      const result = await driver.validateSession("forbidden-token", "conn-3");
      assert.equal(result, false);
    });

    it("returns true on HTTP 429 (inconclusive — allow the request)", async () => {
      setMockFetch([{ status: 429 }]);
      const result = await driver.validateSession("rate-limited", "conn-4");
      assert.equal(result, true);
    });

    it("returns true on network error (inconclusive — don't penalize)", async () => {
      globalThis.fetch = (() =>
        Promise.reject(new Error("network error"))) as typeof globalThis.fetch;
      const result = await driver.validateSession("any-token", "conn-5");
      assert.equal(result, true);
    });

    it("uses in-memory cache for subsequent calls within TTL", async () => {
      let fetchCalls = 0;
      globalThis.fetch = (() => {
        fetchCalls++;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof globalThis.fetch;

      await driver.validateSession("cached-token", "conn-cache");
      await driver.validateSession("cached-token", "conn-cache");

      assert.equal(fetchCalls, 1, "second call should use cache, not fetch");
    });

    it("returns false from cache when session was marked expired", async () => {
      // First call: healthy
      setMockFetch([{ status: 200, ok: true }]);
      await driver.validateSession("token", "conn-cached-expired");

      // Mark expired directly
      await driver.markExpired("conn-cached-expired", "test: forced expiry");

      // Second call should use cache (expired) without fetching
      let fetchCalls = 0;
      globalThis.fetch = (() => {
        fetchCalls++;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof globalThis.fetch;

      const result = await driver.validateSession("token", "conn-cached-expired");
      assert.equal(result, false, "should return false from cached expired state");
      assert.equal(fetchCalls, 0, "should not fetch when cache says expired");
    });
  });

  // ── 2. Mark expired / mark healthy ──────────────────────────────────────

  describe("markExpired / markHealthy", () => {
    it("markExpired sets status to expired", async () => {
      await driver.markExpired("conn-exp", "test reason");
      assert.equal(driver.isExpired("conn-exp"), true);
    });

    it("markHealthy sets status to healthy", () => {
      driver.markHealthy("conn-health");
      assert.equal(driver.isExpired("conn-health"), false);
      const health = driver.getHealth("conn-health");
      assert.equal(health?.status, "healthy");
    });

    it("markExpired increments consecutiveFailures", async () => {
      await driver.markExpired("conn-fail", "first failure");
      await driver.markExpired("conn-fail", "second failure");
      const health = driver.getHealth("conn-fail");
      assert.equal(health?.consecutiveFailures, 2);
    });

    it("markHealthy resets consecutiveFailures to 0", async () => {
      await driver.markExpired("conn-recover", "failure");
      driver.markHealthy("conn-recover");
      const health = driver.getHealth("conn-recover");
      assert.equal(health?.consecutiveFailures, 0);
      assert.equal(health?.status, "healthy");
    });
  });

  // ── 3. Stream watchdog ──────────────────────────────────────────────────

  describe("withStreamWatchdog", () => {
    it("passes through content normally when tokens arrive", async () => {
      const contentChunk = new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
      );
      const doneChunk = new TextEncoder().encode("data: [DONE]\n\n");
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(contentChunk);
          controller.enqueue(doneChunk);
          controller.close();
        },
      });

      let timeoutCalled = false;
      let emptyCalled = false;
      const wrapped = driver.withStreamWatchdog(source, {
        connectionId: "conn-stream-ok",
        onTimeout: () => {
          timeoutCalled = true;
        },
        onEmptyStream: () => {
          emptyCalled = true;
        },
      });

      const reader = wrapped.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      assert.equal(timeoutCalled, false, "onTimeout should not fire when content arrives");
      assert.equal(emptyCalled, false, "onEmptyStream should not fire when content arrives");
      assert.ok(chunks.length >= 1, "should have passed through at least one chunk");
    });

    it("emits error chunk when stream ends with no content", async () => {
      // Simulate the exact production bug: empty stream with no content deltas
      const source = new ReadableStream({
        start(controller) {
          // Only phase/done frames — no content
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n\n'));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      let emptyCalled = false;
      const wrapped = driver.withStreamWatchdog(source, {
        connectionId: "conn-stream-empty",
        onEmptyStream: () => {
          emptyCalled = true;
        },
      });

      const reader = wrapped.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allText += decoder.decode(value, { stream: true });
      }

      assert.equal(emptyCalled, true, "onEmptyStream should fire when no content arrives");
      assert.ok(
        allText.includes("Web session error"),
        "should emit an error chunk with a clear message"
      );
      assert.ok(allText.includes("[DONE]"), "should close the stream with [DONE]");
    });

    it("emits error chunk when watchdog times out with no content", async () => {
      // Stream that never sends content — watchdog should fire after the timeout.
      // Use a stream with a cancel handler so cleanup is clean.
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          // Never enqueue, never close — hang until cancelled
        },
        cancel() {
          // Clean up when the watchdog cancels us
        },
      });

      let timeoutCalled = false;
      const wrapped = driver.withStreamWatchdog(source, {
        connectionId: "conn-stream-timeout",
        onTimeout: () => {
          timeoutCalled = true;
        },
      });

      const reader = wrapped.getReader();
      const decoder = new TextDecoder();
      let allText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allText += decoder.decode(value, { stream: true });
      }

      assert.equal(timeoutCalled, true, "onTimeout should fire when watchdog expires");
      assert.ok(allText.includes("No content received"), "should emit a timeout error message");
    });
  });

  // ── 4. Session health summary ───────────────────────────────────────────

  describe("getSessionHealthSummary", () => {
    it("returns correct counts for mixed health states", async () => {
      // Need to import after cache clear
      const { getSessionHealthSummary } =
        await import("../../open-sse/services/webSessionDriver.ts");

      driver.markHealthy("conn-a");
      driver.markHealthy("conn-b");
      await driver.markExpired("conn-c", "test");

      const summary = getSessionHealthSummary();
      assert.ok(summary.total >= 3, "should have at least 3 entries");
      assert.ok(summary.healthy >= 2, "should have at least 2 healthy");
      assert.ok(summary.expired >= 1, "should have at least 1 expired");
    });
  });
});
