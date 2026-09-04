/**
 * captchaDetector.ts — Unified captcha type detection and classification.
 *
 * Every web-cookie provider that faces a captcha/Cloudflare challenge can use
 * this module to detect the captcha type and route to the appropriate solver.
 *
 * Detection is purely text/DOM based — no network calls. The caller is
 * responsible for invoking the solver (NopeCHA extension, cfClearanceService,
 * or provider-specific solver) based on the returned classification.
 *
 * Existing `isCloudflareChallenge()` in `tlsClientBase.ts` is re-exported here
 * for backward compatibility — all existing imports continue to work.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export enum CaptchaType {
  NONE = "none",
  CLOUDFLARE_CHALLENGE = "cloudflare_challenge",
  TURNSTILE = "turnstile",
  RECAPTCHA_V2 = "recaptcha_v2",
  RECAPTCHA_V3 = "recaptcha_v3",
  HCAPTCHA = "hcaptcha",
  PROGRAMMATIC = "programmatic",
}

export enum CaptchaSolverStrategy {
  NONE = "none",
  /** Wait for NopeCHA browser extension to auto-solve the widget on-page */
  NOPECHA_EXTENSION = "nopecha_extension",
  /** Call the Python cloudflare-solver sidecar for cf_clearance acquisition */
  CF_CLEARANCE_SIDECAR = "cf_clearance_sidecar",
  /** Provider-specific solver (e.g., z.ai captcha_verify_param, DDG VQD) */
  PROVIDER_SPECIFIC = "provider_specific",
}

export interface CaptchaClassification {
  type: CaptchaType;
  strategy: CaptchaSolverStrategy;
  /** Raw match text that triggered the detection, for diagnostics */
  evidence?: string;
}

// ── Cloudflare challenge detection (moved from tlsClientBase.ts) ──────────

/**
 * Returns true if the response body is a Cloudflare challenge/interstitial page.
 *
 * This is the canonical implementation — `tlsClientBase.ts` re-exports it
 * for backward compatibility with existing imports.
 */
export function isCloudflareChallenge(text: string | null | undefined): boolean {
  if (!text) return false;
  return /just a moment|window\._cf_chl_opt|challenges\.cloudflare\.com|attention required|cf-chl/i.test(
    text
  );
}

// ── Turnstile detection ───────────────────────────────────────────────────

/**
 * Detect Cloudflare Turnstile widget in HTML response body.
 * Turnstile renders as an iframe with src containing "turnstile" or a
 * div with class "cf-turnstile".
 */
export function isTurnstileWidget(text: string | null | undefined): boolean {
  if (!text) return false;
  return /cf-turnstile|challenges\.cloudflare\.com\/turnstile|iframe[^>]*src=["'][^"']*turnstile/i.test(
    text
  );
}

// ── reCAPTCHA detection ───────────────────────────────────────────────────

/**
 * Detect reCAPTCHA v2 widget in HTML response body.
 * v2 renders as a div with class "g-recaptcha" or an iframe with
 * src containing "recaptcha/api.js".
 */
export function isRecaptchaV2(text: string | null | undefined): boolean {
  if (!text) return false;
  return /g-recaptcha|recaptcha\/api\.js|recaptcha\/enterprise/i.test(text);
}

/**
 * Detect reCAPTCHA v3 (invisible) in HTML response body.
 * v3 loads via `recaptcha/enterprise.js?render=` and doesn't render
 * a visible widget. Detection is based on the script src pattern.
 */
export function isRecaptchaV3(text: string | null | undefined): boolean {
  if (!text) return false;
  return /recaptcha\/enterprise\.js\?render=|recaptcha\/api\.js\?render=/i.test(text);
}

// ── hCaptcha detection ────────────────────────────────────────────────────

/**
 * Detect hCaptcha widget in HTML response body.
 */
export function isHcaptcha(text: string | null | undefined): boolean {
  if (!text) return false;
  return /h-captcha|hcaptcha\.com|hcaptcha-challenge/i.test(text);
}

// ── Programmatic captcha detection ────────────────────────────────────────

/**
 * Detect programmatic captcha errors (not visible widgets).
 *
 * These are API-level error responses that require a captcha param
 * the frontend generates dynamically via JavaScript. Examples:
 * - z.ai: `FRONTEND_CAPTCHA_REQUIRED` with `captcha_error_type: "missing_param"`
 * - Generic: `captcha_verify_param` field in error response
 */
export function isProgrammaticCaptcha(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /FRONTEND_CAPTCHA_REQUIRED/i.test(text) ||
    /captcha_error_type/i.test(text) ||
    /captcha_verify_param.*required/i.test(text)
  );
}

// ── Unified detection ─────────────────────────────────────────────────────

/**
 * Classify the captcha type from a response body (HTML or JSON).
 *
 * Returns a `CaptchaClassification` with the detected type and the
 * recommended solver strategy. If no captcha is detected, returns
 * `{ type: CaptchaType.NONE, strategy: CaptchaSolverStrategy.NONE }`.
 *
 * @param text - Response body text (HTML or JSON)
 * @returns Captcha classification with solver strategy hint
 */
export function classifyCaptcha(text: string | null | undefined): CaptchaClassification {
  if (!text) return { type: CaptchaType.NONE, strategy: CaptchaSolverStrategy.NONE };

  // Turnstile widget — check BEFORE Cloudflare challenge because the
  // Turnstile script URL contains "challenges.cloudflare.com" which also
  // matches the Cloudflare interstitial pattern.
  if (isTurnstileWidget(text)) {
    return {
      type: CaptchaType.TURNSTILE,
      strategy: CaptchaSolverStrategy.NOPECHA_EXTENSION,
      evidence: text.slice(0, 200),
    };
  }

  // Cloudflare challenge page (interstitial)
  if (isCloudflareChallenge(text)) {
    return {
      type: CaptchaType.CLOUDFLARE_CHALLENGE,
      strategy: CaptchaSolverStrategy.CF_CLEARANCE_SIDECAR,
      evidence: text.slice(0, 200),
    };
  }

  // reCAPTCHA v3 (invisible — check before v2 since v3 scripts also match v2 patterns)
  if (isRecaptchaV3(text)) {
    return {
      type: CaptchaType.RECAPTCHA_V3,
      strategy: CaptchaSolverStrategy.NOPECHA_EXTENSION,
      evidence: text.slice(0, 200),
    };
  }

  // reCAPTCHA v2
  if (isRecaptchaV2(text)) {
    return {
      type: CaptchaType.RECAPTCHA_V2,
      strategy: CaptchaSolverStrategy.NOPECHA_EXTENSION,
      evidence: text.slice(0, 200),
    };
  }

  // hCaptcha
  if (isHcaptcha(text)) {
    return {
      type: CaptchaType.HCAPTCHA,
      strategy: CaptchaSolverStrategy.NOPECHA_EXTENSION,
      evidence: text.slice(0, 200),
    };
  }

  // Programmatic captcha (z.ai, etc.)
  if (isProgrammaticCaptcha(text)) {
    return {
      type: CaptchaType.PROGRAMMATIC,
      strategy: CaptchaSolverStrategy.PROVIDER_SPECIFIC,
      evidence: text.slice(0, 200),
    };
  }

  return { type: CaptchaType.NONE, strategy: CaptchaSolverStrategy.NONE };
}

/**
 * Quick boolean check — is any captcha present in the response body?
 */
export function hasCaptcha(text: string | null | undefined): boolean {
  return classifyCaptcha(text).type !== CaptchaType.NONE;
}
