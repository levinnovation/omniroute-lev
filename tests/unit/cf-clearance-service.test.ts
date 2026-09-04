import test from "node:test";
import assert from "node:assert/strict";

import {
  getCfClearance,
  injectCfClearance,
  invalidateCfClearance,
  isCfSolverConfigured,
  __setCfClearanceAcquireOverrideForTesting,
  __clearCfClearanceCacheForTesting,
} from "../../open-sse/services/cfClearanceService.ts";

// ─── Tests ──────────────────────────────────────────────────────────────────

test("injectCfClearance appends cf_clearance to empty cookie string", () => {
  const result = injectCfClearance("", "abc123");
  assert.equal(result, "cf_clearance=abc123");
});

test("injectCfClearance appends cf_clearance to existing cookies", () => {
  const result = injectCfClearance("session=xyz; theme=dark", "abc123");
  assert.equal(result, "session=xyz; theme=dark; cf_clearance=abc123");
});

test("injectCfClearance replaces existing cf_clearance", () => {
  const result = injectCfClearance("session=xyz; cf_clearance=old_value; theme=dark", "new_value");
  assert.ok(result.includes("cf_clearance=new_value"));
  assert.ok(!result.includes("old_value"));
  assert.ok(result.includes("session=xyz"));
  assert.ok(result.includes("theme=dark"));
});

test("getCfClearance returns null when sidecar is not configured", async () => {
  delete process.env.OMNIROUTE_CFSOLVER_URL;
  __clearCfClearanceCacheForTesting();
  const result = await getCfClearance("https://grok.com/");
  assert.equal(result, null);
});

test("getCfClearance uses test override when set", async () => {
  __clearCfClearanceCacheForTesting();
  const mockResult = {
    cfClearance: "test_cf_token",
    userAgent: "TestUA/1.0",
    cookies: {},
    expiresAt: Date.now() + 3300000,
  };
  __setCfClearanceAcquireOverrideForTesting(async () => mockResult);
  try {
    const result = await getCfClearance("https://grok.com/");
    assert.equal(result?.cfClearance, "test_cf_token");
    assert.equal(result?.userAgent, "TestUA/1.0");
  } finally {
    __setCfClearanceAcquireOverrideForTesting(null);
  }
});

test("getCfClearance caches results for the same URL", async () => {
  __clearCfClearanceCacheForTesting();
  let callCount = 0;
  __setCfClearanceAcquireOverrideForTesting(async () => {
    callCount++;
    return {
      cfClearance: `token_${callCount}`,
      userAgent: "TestUA/1.0",
      cookies: {},
      expiresAt: Date.now() + 3300000,
    };
  });
  try {
    // First call — should invoke the override
    const result1 = await getCfClearance("https://grok.com/");
    assert.equal(result1?.cfClearance, "token_1");
    assert.equal(callCount, 1);

    // Second call — should return cached result (no new override call)
    const result2 = await getCfClearance("https://grok.com/");
    assert.equal(result2?.cfClearance, "token_1");
    assert.equal(callCount, 1);
  } finally {
    __setCfClearanceAcquireOverrideForTesting(null);
  }
});

test("getCfClearance caches separately for different URLs", async () => {
  __clearCfClearanceCacheForTesting();
  const tokens = new Map<string, string>();
  __setCfClearanceAcquireOverrideForTesting(async (url) => {
    const token = `token_for_${url}`;
    tokens.set(url, token);
    return {
      cfClearance: token,
      userAgent: "TestUA/1.0",
      cookies: {},
      expiresAt: Date.now() + 3300000,
    };
  });
  try {
    const result1 = await getCfClearance("https://grok.com/");
    const result2 = await getCfClearance("https://claude.ai");
    assert.notEqual(result1?.cfClearance, result2?.cfClearance);
    assert.equal(result1?.cfClearance, "token_for_https://grok.com/");
    assert.equal(result2?.cfClearance, "token_for_https://claude.ai");
  } finally {
    __setCfClearanceAcquireOverrideForTesting(null);
  }
});

test("invalidateCfClearance removes cached entry", async () => {
  __clearCfClearanceCacheForTesting();
  let callCount = 0;
  __setCfClearanceAcquireOverrideForTesting(async () => {
    callCount++;
    return {
      cfClearance: `token_${callCount}`,
      userAgent: "TestUA/1.0",
      cookies: {},
      expiresAt: Date.now() + 3300000,
    };
  });
  try {
    await getCfClearance("https://grok.com/");
    assert.equal(callCount, 1);

    // Invalidate cache
    invalidateCfClearance("https://grok.com/");

    // Next call should invoke override again
    await getCfClearance("https://grok.com/");
    assert.equal(callCount, 2);
  } finally {
    __setCfClearanceAcquireOverrideForTesting(null);
  }
});

test("isCfSolverConfigured reflects env var state", () => {
  delete process.env.OMNIROUTE_CFSOLVER_URL;
  assert.equal(isCfSolverConfigured(), false);

  process.env.OMNIROUTE_CFSOLVER_URL = "http://localhost:8080";
  assert.equal(isCfSolverConfigured(), true);

  delete process.env.OMNIROUTE_CFSOLVER_URL;
  assert.equal(isCfSolverConfigured(), false);
});

test("getCfClearance returns null when override returns null", async () => {
  __clearCfClearanceCacheForTesting();
  __setCfClearanceAcquireOverrideForTesting(async () => null);
  try {
    const result = await getCfClearance("https://grok.com/");
    assert.equal(result, null);
  } finally {
    __setCfClearanceAcquireOverrideForTesting(null);
  }
});
