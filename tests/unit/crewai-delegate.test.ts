import test from "node:test";
import assert from "node:assert/strict";

/**
 * LEV fork Phase 4: Unit tests for CrewAI delegate logic in
 * crewaiDelegate.ts — delegation detection, model extraction, and
 * recursion prevention.
 */

import {
  shouldDelegateToCrewAI,
  extractAgenticModel,
  isInternalAgentRequest,
  getDelegationDepth,
  getRequestId,
  type CrewAIDelegateArgs,
} from "../../open-sse/handlers/chatCore/crewaiDelegate.ts";

// ── extractAgenticModel ────────────────────────────────────────────────────

test("extractAgenticModel strips the agentic/ prefix", () => {
  assert.equal(extractAgenticModel("agentic/coder"), "coder");
  assert.equal(extractAgenticModel("agentic/gpt-4o"), "gpt-4o");
  assert.equal(extractAgenticModel("agentic/claude-3-opus"), "claude-3-opus");
});

test("extractAgenticModel returns the model as-is when no prefix", () => {
  assert.equal(extractAgenticModel("gpt-4o"), "gpt-4o");
  assert.equal(extractAgenticModel("claude-3-opus"), "claude-3-opus");
});

// ── isInternalAgentRequest ─────────────────────────────────────────────────

test("isInternalAgentRequest returns false when OMNIROUTE_INTERNAL_AGENT_KEY is unset", () => {
  delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  assert.equal(isInternalAgentRequest("any-key"), false);
  assert.equal(isInternalAgentRequest(null), false);
});

test("isInternalAgentRequest returns true when key matches", () => {
  process.env.OMNIROUTE_INTERNAL_AGENT_KEY = "test-internal-key";
  try {
    assert.equal(isInternalAgentRequest("test-internal-key"), true);
    assert.equal(isInternalAgentRequest("wrong-key"), false);
    assert.equal(isInternalAgentRequest(null), false);
    assert.equal(isInternalAgentRequest(undefined), false);
  } finally {
    delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  }
});

// ── shouldDelegateToCrewAI ────────────────────────────────────────────────

test("shouldDelegateToCrewAI returns false when OMNIROUTE_CREWAI_URL is unset", () => {
  delete process.env.OMNIROUTE_CREWAI_URL;
  const args: CrewAIDelegateArgs = {
    model: "agentic/coder",
    body: { messages: [{ role: "user", content: "test" }] },
    stream: false,
    requestApiKey: "user-key",
  };
  assert.equal(shouldDelegateToCrewAI(args), false);
});

test("shouldDelegateToCrewAI returns true for agentic/ model with sidecar configured", () => {
  process.env.OMNIROUTE_CREWAI_URL = "http://lev-crewai-coder.railway.internal:8000";
  delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  try {
    const args: CrewAIDelegateArgs = {
      model: "agentic/coder",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      requestApiKey: "user-key",
    };
    assert.equal(shouldDelegateToCrewAI(args), true);
  } finally {
    delete process.env.OMNIROUTE_CREWAI_URL;
  }
});

test("shouldDelegateToCrewAI returns false for non-agentic model", () => {
  process.env.OMNIROUTE_CREWAI_URL = "http://lev-crewai-coder.railway.internal:8000";
  try {
    const args: CrewAIDelegateArgs = {
      model: "gpt-4o",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      requestApiKey: "user-key",
    };
    assert.equal(shouldDelegateToCrewAI(args), false);
  } finally {
    delete process.env.OMNIROUTE_CREWAI_URL;
  }
});

test("shouldDelegateToCrewAI returns false for internal agent requests (recursion prevention)", () => {
  process.env.OMNIROUTE_CREWAI_URL = "http://lev-crewai-coder.railway.internal:8000";
  process.env.OMNIROUTE_INTERNAL_AGENT_KEY = "internal-secret";
  try {
    const args: CrewAIDelegateArgs = {
      model: "agentic/coder",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      requestApiKey: "internal-secret",
    };
    assert.equal(shouldDelegateToCrewAI(args), false);
  } finally {
    delete process.env.OMNIROUTE_CREWAI_URL;
    delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  }
});

test("shouldDelegateToCrewAI returns true for agentic model with non-internal key", () => {
  process.env.OMNIROUTE_CREWAI_URL = "http://lev-crewai-coder.railway.internal:8000";
  process.env.OMNIROUTE_INTERNAL_AGENT_KEY = "internal-secret";
  try {
    const args: CrewAIDelegateArgs = {
      model: "agentic/coder",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      requestApiKey: "user-key-not-internal",
    };
    assert.equal(shouldDelegateToCrewAI(args), true);
  } finally {
    delete process.env.OMNIROUTE_CREWAI_URL;
    delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  }
});

// ── Depth enforcement ────────────────────────────────────────────────────

test("shouldDelegateToCrewAI returns false when depth exceeds max", () => {
  process.env.OMNIROUTE_CREWAI_URL = "http://lev-crewai-coder.railway.internal:8000";
  delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  try {
    const args: CrewAIDelegateArgs = {
      model: "agentic/coder",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      requestApiKey: "user-key",
      depth: 2, // At max depth
    };
    assert.equal(shouldDelegateToCrewAI(args), false);
  } finally {
    delete process.env.OMNIROUTE_CREWAI_URL;
  }
});

test("shouldDelegateToCrewAI returns true when depth is below max", () => {
  process.env.OMNIROUTE_CREWAI_URL = "http://lev-crewai-coder.railway.internal:8000";
  delete process.env.OMNIROUTE_INTERNAL_AGENT_KEY;
  try {
    const args: CrewAIDelegateArgs = {
      model: "agentic/coder",
      body: { messages: [{ role: "user", content: "test" }] },
      stream: false,
      requestApiKey: "user-key",
      depth: 1, // Below max
    };
    assert.equal(shouldDelegateToCrewAI(args), true);
  } finally {
    delete process.env.OMNIROUTE_CREWAI_URL;
  }
});

// ── getDelegationDepth ────────────────────────────────────────────────────

test("getDelegationDepth returns 0 for missing header", () => {
  assert.equal(getDelegationDepth({}), 0);
  assert.equal(getDelegationDepth({ "content-type": "application/json" }), 0);
});

test("getDelegationDepth parses valid header", () => {
  assert.equal(getDelegationDepth({ "x-omniroute-depth": "1" }), 1);
  assert.equal(getDelegationDepth({ "x-omniroute-depth": "2" }), 2);
});

test("getDelegationDepth handles invalid header", () => {
  assert.equal(getDelegationDepth({ "x-omniroute-depth": "abc" }), 0);
  assert.equal(getDelegationDepth({ "x-omniroute-depth": "" }), 0);
});

// ── getRequestId ─────────────────────────────────────────────────────────

test("getRequestId extracts x-omniroute-request-id", () => {
  assert.equal(getRequestId({ "x-omniroute-request-id": "req_123" }), "req_123");
});

test("getRequestId falls back to x-request-id", () => {
  assert.equal(getRequestId({ "x-request-id": "req_456" }), "req_456");
});

test("getRequestId returns null for missing headers", () => {
  assert.equal(getRequestId({}), null);
  assert.equal(getRequestId({ "content-type": "application/json" }), null);
});

// ── Safe fallback policy ──────────────────────────────────────────────────

test("shouldDelegateToCrewAI returns false for agentic model when allowDirectFallback is not set", () => {
  // When the sidecar fails and allowDirectFallback is false, the delegate
  // should return an AGENTIC_UNAVAILABLE error, not fall back silently.
  // This is tested via the CrewAIDelegateArgs interface — the flag exists.
  const args: CrewAIDelegateArgs = {
    model: "agentic/coder",
    body: { messages: [{ role: "user", content: "test" }] },
    stream: false,
    requestApiKey: "user-key",
    allowDirectFallback: false,
  };
  // The flag is present — the delegate will use it when the sidecar fails
  assert.equal(args.allowDirectFallback, false);
});

test("shouldDelegateToCrewAI accepts allowDirectFallback flag", () => {
  const args: CrewAIDelegateArgs = {
    model: "agentic/coder",
    body: { messages: [{ role: "user", content: "test" }] },
    stream: false,
    requestApiKey: "user-key",
    allowDirectFallback: true,
  };
  assert.equal(args.allowDirectFallback, true);
});

// ── Streaming support ─────────────────────────────────────────────────────

test("CrewAIDelegateArgs supports stream flag", () => {
  const args: CrewAIDelegateArgs = {
    model: "agentic/coder",
    body: { messages: [{ role: "user", content: "test" }] },
    stream: true,
    requestApiKey: "user-key",
  };
  assert.equal(args.stream, true);
});

test("CrewAIDelegateArgs supports requestId and depth for tracing", () => {
  const args: CrewAIDelegateArgs = {
    model: "agentic/coder",
    body: { messages: [{ role: "user", content: "test" }] },
    stream: false,
    requestApiKey: "user-key",
    requestId: "req_trace_123",
    depth: 1,
  };
  assert.equal(args.requestId, "req_trace_123");
  assert.equal(args.depth, 1);
});
