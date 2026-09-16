/**
 * adaptiveSelectors.ts — Adaptive element relocation for web-cookie providers.
 *
 * LEV fork addition. Ports Scrapling's adaptive element similarity algorithm
 * to TypeScript for use with Playwright's Page API.
 *
 * Problem: UI automation providers (qwen-web, perplexity-web, t3-chat-web,
 * etc.) break when provider UIs change CSS selectors. This module stores an
 * element "fingerprint" on first successful match, then when the selector
 * fails, searches the page for the element with the highest similarity score.
 *
 * Fingerprint properties (weighted by importance):
 *   - tagName (weight: 25%)
 *   - attributes: id, name, data-testid, role, aria-label, type, class (weight: 35%)
 *   - text content / placeholder (weight: 15%)
 *   - position: bounding rect x, y, width, height (weight: 15%)
 *   - visibility: isContentEditable, isTextarea/Input (weight: 10%)
 *
 * Similarity threshold: 0.70 (70%). Below this, the adaptive lookup returns
 * null (graceful failure → caller falls back to direct HTTP).
 *
 * Persistence: in-memory Map keyed by `${providerName}:${selectorRole}`.
 * Fingerprints are cleared on process restart. A future enhancement could
 * persist to SQLite, but in-memory is sufficient because selector changes
 * are infrequent and the first request after a restart re-captures the
 * fingerprint.
 */
type Page = import("playwright").Page;

/** Role of a selector within a provider's UI (input, submit, model, etc.) */
export type SelectorRole = "input" | "submit" | "model" | "custom";

/** A stored fingerprint of a previously-matched element. */
export interface ElementFingerprint {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  placeholder: string;
  boundingRect: { x: number; y: number; width: number; height: number };
  isContentEditable: boolean;
  inputType: string | null;
  /** When the fingerprint was captured (epoch ms). */
  capturedAt: number;
}

/** A candidate element found during adaptive search. */
interface CandidateElement {
  selector: string;
  fingerprint: ElementFingerprint;
  similarity: number;
}

/** In-memory fingerprint store: providerName:role → fingerprint. */
const fingerprintStore = new Map<string, ElementFingerprint>();

/** Minimum similarity score (0-1) to accept an adaptive match. */
const SIMILARITY_THRESHOLD = 0.7;

// ── Fingerprint extraction ─────────────────────────────────────────────────

/**
 * Extract a fingerprint from a DOM element via page.evaluate().
 * Returns null if the element cannot be found or evaluated.
 */
export async function captureFingerprint(
  page: Page,
  selector: string
): Promise<ElementFingerprint | null> {
  try {
    const fingerprint = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const attrs: Record<string, string> = {};
      for (const attr of el.attributes) {
        attrs[attr.name] = attr.value;
      }
      return {
        tagName: el.tagName.toLowerCase(),
        attributes: attrs,
        textContent: (el.textContent || "").trim().slice(0, 200),
        placeholder: (el as HTMLInputElement).placeholder || "",
        boundingRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        isContentEditable: (el as HTMLElement).isContentEditable,
        inputType:
          el.tagName === "INPUT"
            ? (el as HTMLInputElement).type
            : el.tagName === "TEXTAREA"
              ? "textarea"
              : null,
        capturedAt: Date.now(),
      } as ElementFingerprint;
    }, selector);
    return fingerprint;
  } catch {
    return null;
  }
}

// ── Similarity scoring ────────────────────────────────────────────────────

/**
 * Compute similarity between two fingerprints (0-1).
 * Weighted average of component scores.
 */
export function computeSimilarity(
  stored: ElementFingerprint,
  candidate: ElementFingerprint
): number {
  const tagNameScore = stored.tagName === candidate.tagName ? 1 : 0;

  // Attribute similarity: compare key attributes by Jaccard coefficient.
  const keyAttrs = ["id", "name", "data-testid", "role", "aria-label", "type", "class"];
  let attrMatches = 0;
  let attrChecks = 0;
  for (const attr of keyAttrs) {
    const storedVal = stored.attributes[attr];
    const candidateVal = candidate.attributes[attr];
    if (storedVal === undefined && candidateVal === undefined) continue;
    attrChecks++;
    if (storedVal === candidateVal) attrMatches++;
    else if (storedVal && candidateVal) {
      // Partial match for class lists (shared classes)
      if (attr === "class") {
        const storedClasses = new Set(storedVal.split(/\s+/).filter(Boolean));
        const candidateClasses = new Set(candidateVal.split(/\s+/).filter(Boolean));
        let shared = 0;
        for (const cls of storedClasses) {
          if (candidateClasses.has(cls)) shared++;
        }
        const union = storedClasses.size + candidateClasses.size - shared;
        if (union > 0) attrMatches += shared / union;
      }
    }
  }
  const attrScore = attrChecks > 0 ? attrMatches / attrChecks : 0.5;

  // Text content similarity (normalized overlap)
  let textScore = 0.5;
  if (stored.textContent && candidate.textContent) {
    const storedWords = new Set(stored.textContent.toLowerCase().split(/\s+/));
    const candidateWords = new Set(candidate.textContent.toLowerCase().split(/\s+/));
    let shared = 0;
    for (const w of storedWords) {
      if (candidateWords.has(w)) shared++;
    }
    const union = storedWords.size + candidateWords.size - shared;
    textScore = union > 0 ? shared / union : 0;
  } else if (!stored.textContent && !candidate.textContent) {
    textScore = 1;
  }

  // Placeholder similarity
  let placeholderScore = 0.5;
  if (stored.placeholder && candidate.placeholder) {
    placeholderScore =
      stored.placeholder.toLowerCase() === candidate.placeholder.toLowerCase() ? 1 : 0;
  } else if (!stored.placeholder && !candidate.placeholder) {
    placeholderScore = 1;
  }

  // Position similarity: normalized distance
  const posScore = computePositionSimilarity(stored.boundingRect, candidate.boundingRect);

  // Type/structure similarity
  const typeScore =
    stored.inputType === candidate.inputType
      ? 1
      : stored.isContentEditable === candidate.isContentEditable
        ? 0.8
        : 0;

  // Weighted average
  const total =
    tagNameScore * 0.25 +
    attrScore * 0.35 +
    (textScore * 0.5 + placeholderScore * 0.5) * 0.15 +
    posScore * 0.15 +
    typeScore * 0.1;

  return total;
}

function computePositionSimilarity(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  // Normalize position by viewport (assume ~1920x1080 if not available)
  const vw = 1920;
  const vh = 1080;
  const dx = Math.abs(a.x - b.x) / vw;
  const dy = Math.abs(a.y - b.y) / vh;
  const dw = Math.abs(a.width - b.width) / vw;
  const dh = Math.abs(a.height - b.height) / vh;
  const distScore = 1 - Math.min(1, (dx + dy) / 2);
  const sizeScore = 1 - Math.min(1, (dw + dh) / 2);
  return (distScore + sizeScore) / 2;
}

// ── Adaptive search ───────────────────────────────────────────────────────

/**
 * Search the page for elements similar to a stored fingerprint.
 * Returns the best candidate's CSS selector, or null if none meet the threshold.
 *
 * Strategy: evaluate all elements matching a broad tag filter, compute
 * similarity, and return the highest-scoring candidate above the threshold.
 */
export async function findAdaptiveElement(
  page: Page,
  stored: ElementFingerprint
): Promise<string | null> {
  try {
    const candidates = await page.evaluate((storedFp) => {
      const targetTag = storedFp.tagName;
      // Broad search: all elements with the same tag, or contenteditable elements
      const selector =
        targetTag === "textarea" || targetTag === "input"
          ? `${targetTag}, [contenteditable="true"], [role="textbox"]`
          : targetTag;
      const elements = Array.from(document.querySelectorAll(selector));
      const results: Array<{
        selector: string;
        fingerprint: ElementFingerprint;
      }> = [];

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        // Skip invisible elements
        if (rect.width === 0 || rect.height === 0) continue;
        const attrs: Record<string, string> = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        // Build a unique CSS selector for this element
        let cssSelector = el.tagName.toLowerCase();
        if (el.id) {
          cssSelector = `#${el.id}`;
        } else if (attrs["data-testid"]) {
          cssSelector = `[data-testid="${attrs["data-testid"]}"]`;
        } else if (attrs["aria-label"]) {
          cssSelector = `[aria-label="${attrs["aria-label"]}"]`;
        } else if (attrs["name"]) {
          cssSelector = `[name="${attrs["name"]}"]`;
        } else if (attrs["role"]) {
          cssSelector = `[role="${attrs["role"]}"]`;
        } else {
          // Fallback: nth-of-type within parent
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((s) => s.tagName === el.tagName);
            const index = siblings.indexOf(el) + 1;
            cssSelector = `${el.tagName.toLowerCase()}:nth-of-type(${index})`;
          }
        }

        results.push({
          selector: cssSelector,
          fingerprint: {
            tagName: el.tagName.toLowerCase(),
            attributes: attrs,
            textContent: (el.textContent || "").trim().slice(0, 200),
            placeholder: (el as HTMLInputElement).placeholder || "",
            boundingRect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            isContentEditable: (el as HTMLElement).isContentEditable,
            inputType:
              el.tagName === "INPUT"
                ? (el as HTMLInputElement).type
                : el.tagName === "TEXTAREA"
                  ? "textarea"
                  : null,
            capturedAt: Date.now(),
          },
        });
      }
      return results;
    }, stored);

    if (!candidates || candidates.length === 0) return null;

    // Score all candidates and return the best one above threshold
    let bestCandidate: CandidateElement | null = null;
    for (const candidate of candidates) {
      const similarity = computeSimilarity(stored, candidate.fingerprint);
      if (similarity >= SIMILARITY_THRESHOLD) {
        if (!bestCandidate || similarity > bestCandidate.similarity) {
          bestCandidate = {
            selector: candidate.selector,
            fingerprint: candidate.fingerprint,
            similarity,
          };
        }
      }
    }

    return bestCandidate?.selector ?? null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Store a fingerprint for a provider+role.
 */
export function storeFingerprint(
  providerName: string,
  role: SelectorRole,
  fingerprint: ElementFingerprint
): void {
  const key = `${providerName}:${role}`;
  fingerprintStore.set(key, fingerprint);
}

/**
 * Retrieve a stored fingerprint for a provider+role.
 */
export function getFingerprint(
  providerName: string,
  role: SelectorRole
): ElementFingerprint | null {
  return fingerprintStore.get(`${providerName}:${role}`) ?? null;
}

/**
 * Clear a stored fingerprint (e.g., after a confirmed selector update).
 */
export function clearFingerprint(providerName: string, role: SelectorRole): void {
  fingerprintStore.delete(`${providerName}:${role}`);
}

/**
 * Try to locate an element using the original CSS selector first.
 * If found, capture/store its fingerprint and return the selector.
 * If not found, attempt adaptive relocation using a stored fingerprint.
 *
 * Returns the CSS selector to use (original or adaptive), or null if both fail.
 */
export async function resolveSelector(
  page: Page,
  providerName: string,
  role: SelectorRole,
  originalSelector: string,
  options?: { adaptive?: boolean }
): Promise<{ selector: string; adaptive: boolean; similarity?: number } | null> {
  const useAdaptive = options?.adaptive ?? true;

  // Step 1: Try the original selector
  try {
    const count = await page.locator(originalSelector).count();
    if (count > 0) {
      // Capture fingerprint for future adaptive lookups
      const fp = await captureFingerprint(page, originalSelector);
      if (fp) storeFingerprint(providerName, role, fp);
      return { selector: originalSelector, adaptive: false };
    }
  } catch {
    // Selector evaluation failed — fall through to adaptive
  }

  if (!useAdaptive) return null;

  // Step 2: Try adaptive relocation
  const stored = getFingerprint(providerName, role);
  if (!stored) return null; // No fingerprint to compare against

  const adaptiveSelector = await findAdaptiveElement(page, stored);
  if (!adaptiveSelector) return null;

  // Re-capture the fingerprint from the adaptive match (keeps it fresh)
  const newFp = await captureFingerprint(page, adaptiveSelector);
  if (newFp) storeFingerprint(providerName, role, newFp);

  return { selector: adaptiveSelector, adaptive: true };
}

/**
 * Get all stored fingerprints (for debugging/monitoring).
 */
export function getAllFingerprints(): Array<{ key: string; fingerprint: ElementFingerprint }> {
  return Array.from(fingerprintStore.entries()).map(([key, fingerprint]) => ({
    key,
    fingerprint,
  }));
}
