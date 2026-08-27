/**
 * Regression test for the zai-web empty-content session-expired bug.
 *
 * LEV fork addition.
 *
 * Reproduces the exact scenario from the production logs:
 *   - Session token is expired
 *   - Browser transport captures an empty 200 response
 *   - The stream watchdog detects no content
 *   - The driver emits an error chunk (not a silent 200 with content: null)
 *
 * Production log evidence:
 *   [15:13:31] 📊 [USAGE] ZAI-WEB | in=111 | out=0 | account=59f08f3d...
 *   [15:13:31] 🌊 [STREAM] ZAI-WEB | glm-5.2 | 443ms | error: Provider returned empty content
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  WebSessionDriver,
  __clearSessionHealthCacheForTest,
} from "../../open-sse/services/webSessionDriver.ts";
import { ZAI_WEB_SESSION_CONFIG } from "../../open-sse/executors/zai-web/sessionConfig.ts";

describe("zai-web empty-content session-expired regression", () => {
  let driver: WebSessionDriver;

  beforeEach(() => {
    __clearSessionHealthCacheForTest();
    driver = new WebSessionDriver(ZAI_WEB_SESSION_CONFIG);
  });

  afterEach(() => {
    __clearSessionHealthCacheForTest();
  });

  it("marks session as expired when stream completes with no content", async () => {
    // Simulate the exact production failure: an empty SSE stream
    // (the browser hit a login redirect and captured an empty 200)
    const emptyStream = new ReadableStream({
      start(controller) {
        // Only metadata frames — no content deltas, like the production bug
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n'
          )
        );
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
          )
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const connectionId = "zai-web-regression-test";
    let emptyStreamCalled = false;

    const wrappedStream = driver.withStreamWatchdog(emptyStream, {
      connectionId,
      onEmptyStream: () => {
        emptyStreamCalled = true;
        // In the real executor, this callback calls driver.markExpired()
        driver.markExpired(
          connectionId,
          "Stream completed with no content — session is likely expired"
        );
      },
    });

    // Read the entire wrapped stream
    const reader = wrappedStream.getReader();
    const decoder = new TextDecoder();
    let allText = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      allText += decoder.decode(value, { stream: true });
    }

    // The watchdog should have detected the empty content
    assert.equal(
      emptyStreamCalled,
      true,
      "onEmptyStream must fire — this is the core regression fix"
    );

    // The session should be marked as expired in the cache
    assert.equal(
      driver.isExpired(connectionId),
      true,
      "session must be marked expired after empty content"
    );

    // The client should see a clear error message, not a silent empty 200
    assert.ok(
      allText.includes("Web session error"),
      "client must receive a clear error message, not silent empty content"
    );
    assert.ok(
      allText.includes("no content") || allText.includes("No content"),
      "error message must mention the empty content issue"
    );
    assert.ok(allText.includes("[DONE]"), "stream must close cleanly with [DONE]");
  });

  it("detects expired session via pre-dispatch validation (401 from probe)", async () => {
    // Mock fetch to return 401 — session is expired
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        })
      )) as typeof globalThis.fetch;

    try {
      const connectionId = "zai-web-expired-probe";
      const isValid = await driver.validateSession("expired-jwt-token", connectionId);

      assert.equal(isValid, false, "expired session must be detected by pre-dispatch validation");
      assert.equal(driver.isExpired(connectionId), true, "expired session must be marked in cache");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks session healthy after a successful stream with content", async () => {
    // Simulate a successful stream with actual content
    const successStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"Hello!"},"index":0}]}\n\n'
          )
        );
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n'
          )
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const connectionId = "zai-web-success";
    let emptyCalled = false;
    let timeoutCalled = false;

    const wrappedStream = driver.withStreamWatchdog(successStream, {
      connectionId,
      onEmptyStream: () => {
        emptyCalled = true;
      },
      onTimeout: () => {
        timeoutCalled = true;
      },
    });

    const reader = wrappedStream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    assert.equal(emptyCalled, false, "onEmptyStream must NOT fire when content arrives");
    assert.equal(timeoutCalled, false, "onTimeout must NOT fire when content arrives");
  });
});
