import test from "node:test";
import assert from "node:assert/strict";

import {
  computeSimilarity,
  storeFingerprint,
  getFingerprint,
  clearFingerprint,
  getAllFingerprints,
  resolveSelector,
  captureFingerprint,
  type ElementFingerprint,
  type SelectorRole,
} from "../../open-sse/executors/base/adaptiveSelectors.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFingerprint(overrides: Partial<ElementFingerprint> = {}): ElementFingerprint {
  return {
    tagName: "textarea",
    attributes: {
      id: "chat-input",
      class: "composer text-area",
      placeholder: "Send a message",
      "data-testid": "chat-input",
      role: "textbox",
    },
    textContent: "",
    placeholder: "Send a message",
    boundingRect: { x: 100, y: 800, width: 600, height: 48 },
    isContentEditable: false,
    inputType: "textarea",
    capturedAt: Date.now(),
    ...overrides,
  };
}

/**
 * Minimal Page stub for testing captureFingerprint / resolveSelector.
 * Implements only `locator()` and `evaluate()` with a tiny in-memory DOM.
 */
interface FakeDomElement {
  tagName: string;
  id: string;
  attributes: Record<string, string>;
  textContent: string;
  placeholder: string;
  rect: { x: number; y: number; width: number; height: number };
  isContentEditable: boolean;
  inputType: string | null;
}

function makeFakePage(elements: FakeDomElement[], selectorMap?: Record<string, number>) {
  // selectorMap: cssSelector -> index into elements (for locator().count())
  const lookup: Record<string, number> = selectorMap ?? {};
  // Auto-build lookup from element ids/data-testid if not provided
  if (!selectorMap) {
    elements.forEach((el, i) => {
      if (el.id) lookup[`#${el.id}`] = i;
      if (el.attributes["data-testid"])
        lookup[`[data-testid="${el.attributes["data-testid"]}"]`] = i;
    });
  }

  const page: Record<string, unknown> = {
    locator(selector: string) {
      const idx = lookup[selector];
      const exists = idx !== undefined;
      return {
        count: async () => (exists ? 1 : 0),
        first: () => ({
          waitFor: async () => undefined,
          count: async () => (exists ? 1 : 0),
        }),
      };
    },
    async evaluate(fn: (...args: unknown[]) => unknown, arg?: unknown) {
      // Simulate the captureFingerprint evaluate: it queries by selector
      // and returns a fingerprint. We approximate by finding the element
      // via the lookup map.
      if (typeof fn === "function") {
        // captureFingerprint passes a selector string
        if (typeof arg === "string") {
          const idx = lookup[arg];
          if (idx === undefined) return null;
          const el = elements[idx];
          return {
            tagName: el.tagName.toLowerCase(),
            attributes: el.attributes,
            textContent: el.textContent,
            placeholder: el.placeholder,
            boundingRect: el.rect,
            isContentEditable: el.isContentEditable,
            inputType: el.inputType,
            capturedAt: Date.now(),
          } as ElementFingerprint;
        }
        // findAdaptiveElement passes a stored fingerprint
        // Return all elements as candidate fingerprints
        const storedFp = arg as ElementFingerprint;
        const targetTag = storedFp.tagName;
        const candidates = elements
          .filter((el) => {
            if (targetTag === "textarea" || targetTag === "input") {
              return (
                el.tagName.toLowerCase() === targetTag ||
                el.isContentEditable ||
                el.attributes["role"] === "textbox"
              );
            }
            return el.tagName.toLowerCase() === targetTag;
          })
          .map((el) => ({
            selector: el.id
              ? `#${el.id}`
              : el.attributes["data-testid"]
                ? `[data-testid="${el.attributes["data-testid"]}"]`
                : el.attributes["aria-label"]
                  ? `[aria-label="${el.attributes["aria-label"]}"]`
                  : `${el.tagName.toLowerCase()}:nth-of-type(1)`,
            fingerprint: {
              tagName: el.tagName.toLowerCase(),
              attributes: el.attributes,
              textContent: el.textContent,
              placeholder: el.placeholder,
              boundingRect: el.rect,
              isContentEditable: el.isContentEditable,
              inputType: el.inputType,
              capturedAt: Date.now(),
            } as ElementFingerprint,
          }));
        return candidates;
      }
      return null;
    },
  };
  return page;
}

// ── Tests ──────────────────────────────────────────────────────────────────

test("computeSimilarity returns 1.0 for identical fingerprints", () => {
  const fp = makeFingerprint();
  const score = computeSimilarity(fp, fp);
  assert.equal(score, 1.0);
});

test("computeSimilarity returns a high score for the same element with minor attribute drift", () => {
  const stored = makeFingerprint();
  const candidate = makeFingerprint({
    attributes: {
      ...stored.attributes,
      class: "composer text-area new-class", // added a class
      id: "chat-input", // same
    },
  });
  const score = computeSimilarity(stored, candidate);
  assert.ok(score >= 0.7, `Expected score >= 0.7, got ${score}`);
});

test("computeSimilarity returns a low score for a completely different element", () => {
  const stored = makeFingerprint();
  const candidate = makeFingerprint({
    tagName: "button",
    attributes: { id: "submit-btn", class: "btn primary", role: "button" },
    textContent: "Send",
    placeholder: "",
    boundingRect: { x: 700, y: 800, width: 80, height: 40 },
    isContentEditable: false,
    inputType: "submit",
  });
  const score = computeSimilarity(stored, candidate);
  assert.ok(score < 0.5, `Expected score < 0.5 for unrelated element, got ${score}`);
});

test("computeSimilarity handles class-list Jaccard similarity", () => {
  const stored = makeFingerprint({
    attributes: { class: "a b c d" },
  });
  const candidate = makeFingerprint({
    attributes: { class: "a b c e" },
  });
  const score = computeSimilarity(stored, candidate);
  // 3 shared out of 5 union → class Jaccard = 0.6
  assert.ok(score > 0.5, `Expected score > 0.5 for 3/4 shared classes, got ${score}`);
});

test("computeSimilarity returns 1.0 when both fingerprints have no text/placeholder", () => {
  const stored = makeFingerprint({ textContent: "", placeholder: "" });
  const candidate = makeFingerprint({ textContent: "", placeholder: "" });
  const score = computeSimilarity(stored, candidate);
  assert.equal(score, 1.0);
});

test("storeFingerprint / getFingerprint round-trip", () => {
  const provider = "test-provider";
  const role: SelectorRole = "input";
  clearFingerprint(provider, role);
  const fp = makeFingerprint();
  storeFingerprint(provider, role, fp);
  const retrieved = getFingerprint(provider, role);
  assert.ok(retrieved, "Fingerprint should be retrievable after storing");
  assert.deepEqual(retrieved, fp);
});

test("getFingerprint returns null when nothing stored", () => {
  const provider = "nonexistent-provider";
  const role: SelectorRole = "submit";
  clearFingerprint(provider, role);
  const retrieved = getFingerprint(provider, role);
  assert.equal(retrieved, null);
});

test("clearFingerprint removes a stored fingerprint", () => {
  const provider = "clear-test";
  const role: SelectorRole = "input";
  storeFingerprint(provider, role, makeFingerprint());
  assert.ok(getFingerprint(provider, role));
  clearFingerprint(provider, role);
  assert.equal(getFingerprint(provider, role), null);
});

test("getAllFingerprints returns all stored entries", () => {
  // Store two known entries
  storeFingerprint("fp-all-1", "input", makeFingerprint({ attributes: { id: "a" } }));
  storeFingerprint("fp-all-2", "submit", makeFingerprint({ attributes: { id: "b" } }));
  const all = getAllFingerprints();
  const keys = all.map((e) => e.key);
  assert.ok(keys.includes("fp-all-1:input"), "Should include fp-all-1:input");
  assert.ok(keys.includes("fp-all-2:submit"), "Should include fp-all-2:submit");
  // Cleanup
  clearFingerprint("fp-all-1", "input");
  clearFingerprint("fp-all-2", "submit");
});

test("fingerprints are provider-scoped (do not cross-contaminate)", () => {
  const providerA = "scope-a";
  const providerB = "scope-b";
  const role: SelectorRole = "input";
  clearFingerprint(providerA, role);
  clearFingerprint(providerB, role);
  const fpA = makeFingerprint({ attributes: { id: "input-a" } });
  storeFingerprint(providerA, role, fpA);
  const fpB = makeFingerprint({ attributes: { id: "input-b" } });
  storeFingerprint(providerB, role, fpB);
  assert.deepEqual(getFingerprint(providerA, role), fpA);
  assert.deepEqual(getFingerprint(providerB, role), fpB);
  assert.notDeepEqual(getFingerprint(providerA, role), getFingerprint(providerB, role));
  clearFingerprint(providerA, role);
  clearFingerprint(providerB, role);
});

test("resolveSelector returns the original selector when it matches and stores a fingerprint", async () => {
  const provider = "resolve-original";
  const role: SelectorRole = "input";
  clearFingerprint(provider, role);
  const el: FakeDomElement = {
    tagName: "textarea",
    id: "chat-input",
    attributes: { id: "chat-input", class: "composer", placeholder: "Send a message" },
    textContent: "",
    placeholder: "Send a message",
    rect: { x: 100, y: 800, width: 600, height: 48 },
    isContentEditable: false,
    inputType: "textarea",
  };
  const page = makeFakePage([el]);
  const result = await resolveSelector(page, provider, role, "#chat-input", { adaptive: true });
  assert.ok(result, "resolveSelector should return a result");
  assert.equal(result?.adaptive, false, "Should not be adaptive when original matches");
  assert.equal(result?.selector, "#chat-input");
  // Fingerprint should now be stored
  assert.ok(getFingerprint(provider, role), "Fingerprint should be stored after successful match");
  clearFingerprint(provider, role);
});

test("resolveSelector returns null when selector fails and no fingerprint is stored", async () => {
  const provider = "resolve-no-fp";
  const role: SelectorRole = "input";
  clearFingerprint(provider, role);
  const page = makeFakePage([]); // no elements
  const result = await resolveSelector(page, provider, role, "#missing", { adaptive: true });
  assert.equal(result, null);
});

test("resolveSelector falls back to adaptive when original fails and fingerprint exists", async () => {
  const provider = "resolve-adaptive";
  const role: SelectorRole = "input";
  clearFingerprint(provider, role);
  // Pre-store a fingerprint matching the original element
  const originalFp = makeFingerprint({
    attributes: {
      id: "old-chat-input",
      class: "composer text-area",
      placeholder: "Send a message",
    },
  });
  storeFingerprint(provider, role, originalFp);
  // New element with a different id but same structure
  const newEl: FakeDomElement = {
    tagName: "textarea",
    id: "new-chat-input",
    attributes: {
      id: "new-chat-input",
      class: "composer text-area",
      placeholder: "Send a message",
      role: "textbox",
    },
    textContent: "",
    placeholder: "Send a message",
    rect: { x: 100, y: 800, width: 600, height: 48 },
    isContentEditable: false,
    inputType: "textarea",
  };
  // The old selector no longer matches; only the new element exists
  const page = makeFakePage([newEl], { "#new-chat-input": 0 });
  const result = await resolveSelector(page, provider, role, "#old-chat-input", {
    adaptive: true,
  });
  assert.ok(result, "resolveSelector should return an adaptive result");
  assert.equal(result?.adaptive, true, "Should be adaptive");
  assert.equal(result?.selector, "#new-chat-input");
  clearFingerprint(provider, role);
});

test("resolveSelector with adaptive:false returns null when original fails", async () => {
  const provider = "resolve-no-adaptive";
  const role: SelectorRole = "input";
  clearFingerprint(provider, role);
  storeFingerprint(provider, role, makeFingerprint());
  const page = makeFakePage([]);
  const result = await resolveSelector(page, provider, role, "#missing", { adaptive: false });
  assert.equal(result, null);
});

test("captureFingerprint returns null when element does not exist", async () => {
  const page = makeFakePage([]);
  const fp = await captureFingerprint(page as unknown as import("playwright").Page, "#nonexistent");
  assert.equal(fp, null);
});

test("captureFingerprint extracts a fingerprint from a matching element", async () => {
  const el: FakeDomElement = {
    tagName: "textarea",
    id: "chat-input",
    attributes: { id: "chat-input", class: "composer", placeholder: "Send a message" },
    textContent: "",
    placeholder: "Send a message",
    rect: { x: 100, y: 800, width: 600, height: 48 },
    isContentEditable: false,
    inputType: "textarea",
  };
  const page = makeFakePage([el]);
  const fp = await captureFingerprint(page as unknown as import("playwright").Page, "#chat-input");
  assert.ok(fp, "Should return a fingerprint");
  assert.equal(fp?.tagName, "textarea");
  assert.equal(fp?.attributes.id, "chat-input");
  assert.equal(fp?.placeholder, "Send a message");
  assert.equal(fp?.inputType, "textarea");
});
