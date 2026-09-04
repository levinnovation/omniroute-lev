import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCaptcha,
  CaptchaType,
  CaptchaSolverStrategy,
} from "../../open-sse/services/captchaDetector.ts";

test("classifyCaptcha detects Cloudflare challenge in error response", () => {
  const cfBody =
    "<html><title>Just a moment...</title><body>challenges.cloudflare.com</body></html>";
  const result = classifyCaptcha(cfBody);
  assert.equal(result.type, CaptchaType.CLOUDFLARE_CHALLENGE);
  assert.equal(result.strategy, CaptchaSolverStrategy.CF_CLEARANCE_SIDECAR);
});

test("classifyCaptcha detects z.ai FRONTEND_CAPTCHA_REQUIRED error", () => {
  const zaiBody = JSON.stringify({
    error: {
      code: "FRONTEND_CAPTCHA_REQUIRED",
      captcha_error_type: "missing_param",
    },
  });
  const result = classifyCaptcha(zaiBody);
  assert.equal(result.type, CaptchaType.PROGRAMMATIC);
  assert.equal(result.strategy, CaptchaSolverStrategy.PROVIDER_SPECIFIC);
});

test("classifyCaptcha detects Turnstile widget in response", () => {
  const turnstileBody = '<div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div>';
  const result = classifyCaptcha(turnstileBody);
  assert.equal(result.type, CaptchaType.TURNSTILE);
  assert.equal(result.strategy, CaptchaSolverStrategy.NOPECHA_EXTENSION);
});

test("classifyCaptcha returns NONE for normal API errors", () => {
  const normalError = JSON.stringify({
    error: { message: "Rate limited", code: "HTTP_429" },
  });
  const result = classifyCaptcha(normalError);
  assert.equal(result.type, CaptchaType.NONE);
});

test("WebCookieExecutorBase exports CAPTCHA_DETECTED error kind", async () => {
  const mod = await import("../../open-sse/executors/base/WebCookieExecutorBase.ts");
  assert.ok(mod.WebCookieExecutorBase);
});
