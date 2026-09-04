import test from "node:test";
import assert from "node:assert/strict";

import {
  isCloudflareChallenge,
  isTurnstileWidget,
  isRecaptchaV2,
  isRecaptchaV3,
  isHcaptcha,
  isProgrammaticCaptcha,
  classifyCaptcha,
  hasCaptcha,
  CaptchaType,
  CaptchaSolverStrategy,
} from "../../open-sse/services/captchaDetector.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CF_CHALLENGE_BODY = `
<!DOCTYPE html>
<html>
  <head><title>Just a moment...</title></head>
  <body>
    <script>window._cf_chl_opt = { cvId: "3" };</script>
    Checking your browser before accessing — challenges.cloudflare.com
  </body>
</html>
`;

const TURNSTILE_BODY = `
<div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
`;

const RECAPTCHA_V2_BODY = `
<div class="g-recaptcha" data-sitekey="6Lc_abc"></div>
<script src="https://www.google.com/recaptcha/api.js"></script>
`;

const RECAPTCHA_V3_BODY = `
<script src="https://www.google.com/recaptcha/api.js?render=6Lc_abc"></script>
`;

const HCAPTCHA_BODY = `
<div class="h-captcha" data-sitekey="10000000-0000-0000-0000-000000000000"></div>
<script src="https://js.hcaptcha.com/1/api.js"></script>
`;

const ZAI_CAPTCHA_ERROR = JSON.stringify({
  error: {
    code: "FRONTEND_CAPTCHA_REQUIRED",
    captcha_error_type: "missing_param",
    detail: "Captcha verification is required",
  },
});

const NORMAL_RESPONSE = JSON.stringify({
  id: "chat-123",
  model: "glm-5.2",
  choices: [{ message: { role: "assistant", content: "Hello!" } }],
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test("isCloudflareChallenge detects Cloudflare interstitial pages", () => {
  assert.ok(isCloudflareChallenge(CF_CHALLENGE_BODY));
  assert.ok(isCloudflareChallenge("just a moment..."));
  assert.ok(isCloudflareChallenge("challenges.cloudflare.com"));
  assert.ok(!isCloudflareChallenge(NORMAL_RESPONSE));
  assert.ok(!isCloudflareChallenge(""));
  assert.ok(!isCloudflareChallenge(null));
  assert.ok(!isCloudflareChallenge(undefined));
});

test("isTurnstileWidget detects Turnstile widgets", () => {
  assert.ok(isTurnstileWidget(TURNSTILE_BODY));
  assert.ok(isTurnstileWidget('<div class="cf-turnstile"></div>'));
  assert.ok(!isTurnstileWidget(NORMAL_RESPONSE));
  assert.ok(!isTurnstileWidget(""));
});

test("isRecaptchaV2 detects reCAPTCHA v2 widgets", () => {
  assert.ok(isRecaptchaV2(RECAPTCHA_V2_BODY));
  assert.ok(isRecaptchaV2('<div class="g-recaptcha"></div>'));
  assert.ok(!isRecaptchaV2(NORMAL_RESPONSE));
  assert.ok(!isRecaptchaV2(""));
});

test("isRecaptchaV3 detects reCAPTCHA v3 (invisible)", () => {
  assert.ok(isRecaptchaV3(RECAPTCHA_V3_BODY));
  assert.ok(!isRecaptchaV3(NORMAL_RESPONSE));
  assert.ok(!isRecaptchaV3(""));
});

test("isHcaptcha detects hCaptcha widgets", () => {
  assert.ok(isHcaptcha(HCAPTCHA_BODY));
  assert.ok(isHcaptcha('<div class="h-captcha"></div>'));
  assert.ok(!isHcaptcha(NORMAL_RESPONSE));
  assert.ok(!isHcaptcha(""));
});

test("isProgrammaticCaptcha detects z.ai-style captcha errors", () => {
  assert.ok(isProgrammaticCaptcha(ZAI_CAPTCHA_ERROR));
  assert.ok(isProgrammaticCaptcha('{"code":"FRONTEND_CAPTCHA_REQUIRED"}'));
  assert.ok(isProgrammaticCaptcha('{"captcha_error_type":"missing_param"}'));
  assert.ok(!isProgrammaticCaptcha(NORMAL_RESPONSE));
  assert.ok(!isProgrammaticCaptcha(""));
});

test("classifyCaptcha returns NONE for normal responses", () => {
  const result = classifyCaptcha(NORMAL_RESPONSE);
  assert.equal(result.type, CaptchaType.NONE);
  assert.equal(result.strategy, CaptchaSolverStrategy.NONE);
});

test("classifyCaptcha returns CLOUDFLARE_CHALLENGE for CF pages", () => {
  const result = classifyCaptcha(CF_CHALLENGE_BODY);
  assert.equal(result.type, CaptchaType.CLOUDFLARE_CHALLENGE);
  assert.equal(result.strategy, CaptchaSolverStrategy.CF_CLEARANCE_SIDECAR);
});

test("classifyCaptcha returns TURNSTILE for Turnstile widgets", () => {
  const result = classifyCaptcha(TURNSTILE_BODY);
  assert.equal(result.type, CaptchaType.TURNSTILE);
  assert.equal(result.strategy, CaptchaSolverStrategy.NOPECHA_EXTENSION);
});

test("classifyCaptcha returns RECAPTCHA_V3 for invisible reCAPTCHA", () => {
  const result = classifyCaptcha(RECAPTCHA_V3_BODY);
  assert.equal(result.type, CaptchaType.RECAPTCHA_V3);
  assert.equal(result.strategy, CaptchaSolverStrategy.NOPECHA_EXTENSION);
});

test("classifyCaptcha returns RECAPTCHA_V2 for visible reCAPTCHA", () => {
  // Use a body that matches v2 but NOT v3 (no ?render=)
  const v2Only = '<div class="g-recaptcha" data-sitekey="6Lc_abc"></div>';
  const result = classifyCaptcha(v2Only);
  assert.equal(result.type, CaptchaType.RECAPTCHA_V2);
  assert.equal(result.strategy, CaptchaSolverStrategy.NOPECHA_EXTENSION);
});

test("classifyCaptcha returns HCAPTCHA for hCaptcha widgets", () => {
  const result = classifyCaptcha(HCAPTCHA_BODY);
  assert.equal(result.type, CaptchaType.HCAPTCHA);
  assert.equal(result.strategy, CaptchaSolverStrategy.NOPECHA_EXTENSION);
});

test("classifyCaptcha returns PROGRAMMATIC for z.ai captcha errors", () => {
  const result = classifyCaptcha(ZAI_CAPTCHA_ERROR);
  assert.equal(result.type, CaptchaType.PROGRAMMATIC);
  assert.equal(result.strategy, CaptchaSolverStrategy.PROVIDER_SPECIFIC);
});

test("classifyCaptcha returns NONE for empty/null/undefined", () => {
  assert.equal(classifyCaptcha("").type, CaptchaType.NONE);
  assert.equal(classifyCaptcha(null).type, CaptchaType.NONE);
  assert.equal(classifyCaptcha(undefined).type, CaptchaType.NONE);
});

test("hasCaptcha is a quick boolean check", () => {
  assert.ok(hasCaptcha(CF_CHALLENGE_BODY));
  assert.ok(hasCaptcha(TURNSTILE_BODY));
  assert.ok(hasCaptcha(ZAI_CAPTCHA_ERROR));
  assert.ok(!hasCaptcha(NORMAL_RESPONSE));
  assert.ok(!hasCaptcha(""));
});
