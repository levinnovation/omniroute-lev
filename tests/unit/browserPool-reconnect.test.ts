/**
 * Unit tests for browser pool reconnection logic.
 *
 * Tests the LEV fork additions that prevent "Target page, context or browser
 * has been closed" errors when the Browserless CDP connection times out or
 * disconnects.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetBrowserPoolMetricsForTest,
  __getBrowserPoolStateForTest,
  __simulateBrowserDisconnectForTest,
  __setBrowserForTest,
  __classifyContextErrorForTest,
  shutdownPool,
} from "../../open-sse/services/browserPool.ts";

// Minimal fake Browser that implements isConnected() and on()
interface FakeBrowser {
  isConnected(): boolean;
  on(event: string, handler: () => void): void;
  close(): Promise<void>;
  newContext(): Promise<unknown>;
  _disconnectedHandler?: () => void;
  _connected: boolean;
}

function createFakeBrowser(connected = true): FakeBrowser {
  const browser: FakeBrowser = {
    isConnected: () => connected,
    on: (event: string, handler: () => void) => {
      if (event === "disconnected") {
        browser._disconnectedHandler = handler;
      }
    },
    close: async () => {
      connected = false;
    },
    newContext: async () => {
      if (!connected) {
        throw new Error("Target page, context or browser has been closed");
      }
      return { close: async () => {} };
    },
    _connected: connected,
  };
  return browser;
}

describe("browserPool reconnection logic", () => {
  beforeEach(async () => {
    await shutdownPool("test-reset");
    __resetBrowserPoolMetricsForTest();
  });

  describe("classifyContextError", () => {
    it("classifies 'Target closed' as target-closed", () => {
      const err = new Error("Target page, context or browser has been closed");
      assert.strictEqual(__classifyContextErrorForTest(err), "target-closed");
    });

    it("classifies 429 as queue-full", () => {
      const err = new Error("429 Too Many Requests");
      assert.strictEqual(__classifyContextErrorForTest(err), "queue-full");
    });

    it("classifies 'queue' as queue-full", () => {
      const err = new Error("queue is full");
      assert.strictEqual(__classifyContextErrorForTest(err), "queue-full");
    });

    it("classifies 'concurrent' as queue-full", () => {
      const err = new Error("max concurrent sessions reached");
      assert.strictEqual(__classifyContextErrorForTest(err), "queue-full");
    });

    it("classifies other errors as other", () => {
      const err = new Error("something went wrong");
      assert.strictEqual(__classifyContextErrorForTest(err), "other");
    });

    it("handles string errors", () => {
      assert.strictEqual(
        __classifyContextErrorForTest("Target page, context or browser has been closed"),
        "target-closed"
      );
    });
  });

  describe("simulateBrowserDisconnect", () => {
    it("clears browser reference", () => {
      const fakeBrowser = createFakeBrowser(true) as unknown as import("playwright").Browser;
      __setBrowserForTest(fakeBrowser);

      __simulateBrowserDisconnectForTest();

      const state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.browser, null);
      assert.strictEqual(state.contextsCount, 0);
      assert.strictEqual(state.pendingCount, 0);
      assert.strictEqual(state.isAlive, false);
    });

    it("isAlive returns false after disconnect", () => {
      const fakeBrowser = createFakeBrowser(true) as unknown as import("playwright").Browser;
      __setBrowserForTest(fakeBrowser);

      // Before disconnect
      let state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.isAlive, true);

      __simulateBrowserDisconnectForTest();

      // After disconnect
      state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.isAlive, false);
    });
  });

  describe("isBrowserAlive", () => {
    it("returns false when no browser is set", () => {
      __setBrowserForTest(null);
      const state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.isAlive, false);
    });

    it("returns true when browser is connected", () => {
      const fakeBrowser = createFakeBrowser(true) as unknown as import("playwright").Browser;
      __setBrowserForTest(fakeBrowser);
      const state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.isAlive, true);
    });

    it("returns false when browser is disconnected", () => {
      const fakeBrowser = createFakeBrowser(false) as unknown as import("playwright").Browser;
      __setBrowserForTest(fakeBrowser);
      const state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.isAlive, false);
    });
  });

  describe("disconnected event listener", () => {
    it("clears state when disconnected event fires", () => {
      let disconnectedHandler: (() => void) | null = null;
      const fakeBrowser = {
        isConnected: () => true,
        on: (event: string, handler: () => void) => {
          if (event === "disconnected") {
            disconnectedHandler = handler;
          }
        },
        close: async () => {},
        newContext: async () => ({}),
      } as unknown as import("playwright").Browser;

      __setBrowserForTest(fakeBrowser);

      // Verify the handler was registered
      assert.ok(disconnectedHandler, "disconnected event handler should be registered");

      // Trigger the disconnect event
      disconnectedHandler!();

      const state = __getBrowserPoolStateForTest();
      assert.strictEqual(state.browser, null);
      assert.strictEqual(state.contextsCount, 0);
    });
  });
});
