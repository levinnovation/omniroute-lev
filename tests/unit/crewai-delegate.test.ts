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
