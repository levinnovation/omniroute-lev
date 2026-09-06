import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  __resetFrontendFetchDependenciesForTest,
  __setFrontendFetchDependenciesForTest,
  interceptFrontendFetch,
  shouldFallbackToFFI,
  type FrontendFetchConfig,
} from "../../open-sse/executors/base/frontendFetchInterception.ts";

type Page = import("playwright").Page;
type PlaywrightResponse = import("playwright").Response;
type PooledContext = import("../../open-sse/services/browserPool.ts").PooledContext;

const fallbackCases = [
  "Cannot access 'T' before initialization",
  "Cannot read properties of undefined (reading 'value')",
  "Cannot set properties of undefined (setting 'value')",
  "keyboard.type: Target page, context or browser has been closed",
  "Target closed while browser was processing the request",
];

function baseConfig(overrides: Partial<FrontendFetchConfig> = {}): FrontendFetchConfig {
  return {
    providerName: "test-web",
    poolKey: "test-web:credential-fingerprint",
    pageUrl: "https://example.test/chat",
    cookieDomain: "example.test",
    cookieString: "session=redacted",
    userAgent: "test-agent",
    fetchUrl: "https://example.test/api/chat",
    fetchOptions: { method: "POST", body: "payload" },
    responseTimeoutMs: 1_000,
    ...overrides,
  };
}

describe("shouldFallbackToFFI", () => {
  for (const message of fallbackCases) {
    it(`recognizes ${message}`, () => {
      assert.equal(shouldFallbackToFFI(new Error(message)), true);
    });
  }

  it("rejects unrelated errors", () => {
    assert.equal(shouldFallbackToFFI(new Error("selector timed out")), false);
  });
});

describe("interceptFrontendFetch", () => {
  afterEach(() => {
    __resetFrontendFetchDependenciesForTest();
  });

  it("navigates, runs beforeFetch, returns the in-page fetch result, and releases", async () => {
    const events: string[] = [];
    const page = {
      goto: async (_url: string, options: { waitUntil: string }) => {
        events.push(`goto:${options.waitUntil}`);
      },
      evaluate: async () => {
        events.push("evaluate");
        return {
          status: 201,
          body: "created",
          contentType: "application/json",
          headers: { "content-type": "application/json", "x-test": "yes" },
        };
      },
      close: async () => {
        events.push("close");
      },
    } as unknown as Page;
    __setFrontendFetchDependenciesForTest({
      acquireBrowserContext: async (key) => {
        assert.match(key, /^test-web:credential-fingerprint:ffi:/);
        events.push("acquire");
        return {} as PooledContext;
      },
      openPage: async () => {
        events.push("open");
        return page;
      },
      releaseBrowserContext: async () => {
        events.push("release");
      },
    });

    const result = await interceptFrontendFetch(
      baseConfig({
        beforeFetch: async () => {
          events.push("beforeFetch");
        },
      })
    );

    assert.deepEqual(result, {
      status: 201,
      body: "created",
      contentType: "application/json",
      headers: { "content-type": "application/json", "x-test": "yes" },
    });
    assert.deepEqual(events, [
      "acquire",
      "open",
      // Default is domcontentloaded, NOT networkidle: chat SPAs hold persistent
      // connections so the network never goes idle and page.goto times out
      // (observed live as "FFI failed: page.goto: Timeout 30000ms exceeded" on
      // zai-web). Providers can opt into networkidle via config.waitUntil.
      "goto:domcontentloaded",
      "beforeFetch",
      "evaluate",
      "close",
      "release",
    ]);
  });

  it("arms response interception before evaluating fetch", async () => {
    const events: string[] = [];
    const intercepted = {
      url: () => "https://example.test/api/chat",
      status: () => 202,
      headers: () => ({ "Content-Type": "text/event-stream" }),
      finished: async () => null,
      text: async () => "data: done\n\n",
    } as unknown as PlaywrightResponse;
    const page = {
      goto: async () => undefined,
      waitForResponse: async (predicate: (response: PlaywrightResponse) => boolean) => {
        events.push("waitForResponse");
        assert.equal(predicate(intercepted), true);
        return intercepted;
      },
      evaluate: async () => {
        events.push("evaluate");
        return { status: 202, body: "", contentType: "", headers: {} };
      },
      close: async () => undefined,
    } as unknown as Page;
    __setFrontendFetchDependenciesForTest({
      acquireBrowserContext: async () => ({}) as PooledContext,
      openPage: async () => page,
      releaseBrowserContext: async () => undefined,
    });

    const result = await interceptFrontendFetch(baseConfig({ responseUrlMatch: /\/api\/chat$/ }));

    assert.deepEqual(events, ["waitForResponse", "evaluate"]);
    assert.deepEqual(result, {
      status: 202,
      body: "data: done\n\n",
      contentType: "text/event-stream",
      headers: { "content-type": "text/event-stream" },
    });
  });
});
