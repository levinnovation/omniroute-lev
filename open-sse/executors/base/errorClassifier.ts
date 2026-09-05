/**
 * errorClassifier.ts — LEV fork: Standalone error classification for web-cookie
 * providers (LEV-4).
 *
 * Extracted from WebCookieExecutorBase.classifyError() so providers that use
 * composition (not inheritance) can import and use it directly.
 *
 * Usage:
 *   import { classifyWebCookieError } from "./errorClassifier.ts";
 *   const error = classifyWebCookieError(429, body, retryAfter);
 *   if (error.kind === "CAPTCHA_DETECTED") { ... }
 */

import { sanitizeErrorMessage } from "../../utils/error.ts";
import { classifyCaptcha, CaptchaType } from "../../services/captchaDetector.ts";

export type WebCookieErrorKind =
  | "MODEL_LOCKOUT"
  | "RATE_LIMIT"
  | "SESSION_EXPIRED"
  | "PROVIDER_ERROR"
  | "STREAM_EARLY_EOF"
  | "BROWSER_TRANSPORT"
  | "CAPTCHA_DETECTED"
  | "BANNED"
  | "UNKNOWN";

export interface WebCookieError {
  kind: WebCookieErrorKind;
  status: number;
  message: string;
  retryAfterMs?: number;
}

/**
 * Classify an HTTP error from a web-cookie provider into a standardized
 * error kind. This enables consistent error handling across all providers
 * (LEV-4) without requiring inheritance from WebCookieExecutorBase.
 */
export function classifyWebCookieError(
  status: number,
  bodyText: string,
  retryAfter?: string | null
): WebCookieError {
  const message = sanitizeErrorMessage(bodyText || `HTTP ${status}`);
  const bodyLower = bodyText.toLowerCase();

  // Detect captcha/Cloudflare challenges before other classifications.
  const captcha = classifyCaptcha(bodyText);
  if (captcha.type !== CaptchaType.NONE) {
    return {
      kind: "CAPTCHA_DETECTED",
      status,
      message: `Captcha detected (${captcha.type}): ${message}`,
    };
  }

  // Banned/muted is terminal — not a cooldown.
  if (
    (status === 403 || status === 429) &&
    (bodyLower.includes("banned") ||
      bodyLower.includes("muted") ||
      bodyLower.includes("suspended") ||
      bodyLower.includes("permanently"))
  ) {
    return {
      kind: "BANNED",
      status: 403,
      message: `Account banned/muted: ${message}`,
    };
  }

  if (status === 404) {
    return { kind: "MODEL_LOCKOUT", status, message: `Model not available: ${message}` };
  }

  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(retryAfter);
    return {
      kind: "RATE_LIMIT",
      status,
      message: `Rate limited: ${message}`,
      retryAfterMs,
    };
  }

  if (status === 401 || (status === 403 && bodyLower.includes("expired"))) {
    return { kind: "SESSION_EXPIRED", status, message: `Session expired: ${message}` };
  }

  if (status === 502 || status === 503) {
    return { kind: "PROVIDER_ERROR", status, message: `Provider error: ${message}` };
  }

  return { kind: "UNKNOWN", status, message };
}

/**
 * Map an error kind to the HTTP status code that should be returned to the
 * client.
 */
export function errorKindToStatus(kind: WebCookieErrorKind): number {
  switch (kind) {
    case "SESSION_EXPIRED":
      return 401;
    case "BANNED":
      return 403;
    case "MODEL_LOCKOUT":
      return 404;
    case "RATE_LIMIT":
      return 429;
    case "CAPTCHA_DETECTED":
      return 503;
    case "PROVIDER_ERROR":
      return 502;
    case "STREAM_EARLY_EOF":
      return 502;
    case "BROWSER_TRANSPORT":
      return 502;
    case "UNKNOWN":
    default:
      return 502;
  }
}

/**
 * Check if an error kind is terminal (should not be retried).
 */
export function isTerminalError(kind: WebCookieErrorKind): boolean {
  return kind === "BANNED" || kind === "SESSION_EXPIRED";
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Supports both delta-seconds and HTTP-date formats.
 */
export function parseRetryAfterMs(retryAfter?: string | null): number | undefined {
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateMs = new Date(retryAfter).getTime();
  if (Number.isFinite(dateMs)) return Math.max(dateMs - Date.now(), 0);
  return undefined;
}
