/**
 * zaiCaptchaSolver.ts — Aliyun Captcha solver for z.ai web provider.
 *
 * Z.ai uses Alibaba Cloud's Aliyun Captcha service (not Turnstile or reCAPTCHA).
 * The captcha is a popup-style slide verification that produces a
 * `captcha_verify_param` token required by the /api/chat/completions endpoint.
 *
 * This solver:
 *   1. Loads the Aliyun Captcha script into the page
 *   2. Initializes the captcha with the same config the z.ai frontend uses
 *   3. Waits for the captcha to be solved (auto-solve or user interaction)
 *   4. Returns the verification token
 *
 * The captcha config was reverse-engineered from z.ai's frontend bundle
 * (prod-fe-1.1.93): the frontend calls `window.initAliyunCaptcha()` with
 * SceneId "didk33e0" (for chat.z.ai), mode "popup", prefix "no8xfe",
 * region "sgp".
 */

import type { Page } from "playwright";

// Aliyun Captcha configuration — extracted from z.ai frontend bundle
const ALIYUN_CAPTCHA_SCRIPT_URL =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const ALIYUN_CAPTCHA_REGION = "sgp";
const ALIYUN_CAPTCHA_PREFIX = "no8xfe";
const ALIYUN_CAPTCHA_SCENE_ID = "didk33e0"; // for chat.z.ai
const ALIYUN_CAPTCHA_MODE = "popup";

// Captcha element IDs — must match the DOM elements the captcha renders into
const CAPTCHA_ELEMENT_ID = "chat-captcha-element-omniroute";
const CAPTCHA_BUTTON_ID = "chat-captcha-trigger-omniroute";

const CAPTCHA_TIMEOUT_MS = 30_000; // 30s max to solve

/**
 * Solve the Aliyun Captcha and return the captcha_verify_param token.
 *
 * This function must be called from within a browser page context that has
 * already navigated to chat.z.ai and has the JWT token in localStorage.
 *
 * The solver:
 *   1. Injects a hidden captcha container + trigger button into the page
 *   2. Loads the Aliyun Captcha script
 *   3. Initializes the captcha with z.ai's config
 *   4. Triggers the captcha (clicks the trigger button)
 *   5. Waits for the success callback to fire with the verification token
 *
 * @param page - Playwright page that has navigated to chat.z.ai
 * @returns The captcha_verify_param token, or empty string on failure
 */
export async function solveZaiCaptcha(page: Page): Promise<string> {
  try {
    // Step 1: Inject the captcha container and trigger button into the page
    await page.evaluate(
      ({ elementId, buttonId }) => {
        // Remove any existing captcha elements
        document.getElementById(elementId)?.remove();
        document.getElementById(buttonId)?.remove();

        // Create hidden container for the captcha
        const element = document.createElement("div");
        element.id = elementId;
        element.style.cssText =
          "position:fixed;top:-9999px;left:-9999px;width:320px;height:200px;visibility:hidden;";
        document.body.appendChild(element);

        // Create trigger button (also hidden — we'll click it programmatically)
        const button = document.createElement("div");
        button.id = buttonId;
        button.style.cssText =
          "position:fixed;top:-9999px;left:-9999px;width:100px;height:40px;visibility:hidden;";
        document.body.appendChild(button);
      },
      { elementId: CAPTCHA_ELEMENT_ID, buttonId: CAPTCHA_BUTTON_ID }
    );

    // Step 2: Load the Aliyun Captcha script and initialize the captcha
    const captchaToken = await page.evaluate(
      async ({ scriptUrl, region, prefix, sceneId, mode, elementId, buttonId, timeoutMs }) => {
        // Set the global config required by the Aliyun script
        (window as unknown as Record<string, unknown>).AliyunCaptchaConfig = {
          region,
          prefix,
        };

        // Load the script if not already loaded
        if (!(window as unknown as Record<string, unknown>).initAliyunCaptcha) {
          await new Promise<void>((resolve, reject) => {
            const existing = document.querySelector(
              `script[src="${scriptUrl}"]`
            ) as HTMLScriptElement | null;
            if (existing) {
              if ((window as unknown as Record<string, unknown>).initAliyunCaptcha) {
                resolve();
                return;
              }
              existing.addEventListener("load", () => resolve());
              existing.addEventListener("error", () =>
                reject(new Error("captcha script load failed"))
              );
              return;
            }
            const script = document.createElement("script");
            script.src = scriptUrl;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error("captcha script load failed"));
            document.head.appendChild(script);
          });
        }

        const initFn = (window as unknown as Record<string, unknown>).initAliyunCaptcha as
          ((config: Record<string, unknown>) => void) | undefined;
        if (!initFn) {
          throw new Error("initAliyunCaptcha not available after script load");
        }

        // Initialize the captcha and wait for the success callback
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`captcha solve timeout (${timeoutMs}ms)`));
          }, timeoutMs);

          initFn({
            SceneId: sceneId,
            mode,
            element: `#${elementId}`,
            button: `#${buttonId}`,
            prefix,
            language: "en",
            timeout: 10000,
            delayBeforeSuccess: false,
            success: (result: unknown) => {
              clearTimeout(timeout);
              const token =
                typeof result === "string"
                  ? result
                  : ((result as Record<string, unknown>)?.captcha_verify_param ??
                    (result as Record<string, unknown>)?.verifyResult ??
                    String(result ?? ""));
              resolve(typeof token === "string" ? token : "");
            },
            fail: (err: unknown) => {
              clearTimeout(timeout);
              reject(
                new Error(`captcha fail: ${typeof err === "string" ? err : JSON.stringify(err)}`)
              );
            },
            onError: (err: unknown) => {
              clearTimeout(timeout);
              reject(
                new Error(`captcha error: ${typeof err === "string" ? err : JSON.stringify(err)}`)
              );
            },
          });

          // Trigger the captcha by clicking the trigger button
          // The popup captcha appears when the trigger is clicked
          setTimeout(() => {
            const triggerBtn = document.getElementById(buttonId);
            if (triggerBtn) {
              triggerBtn.click();
            }
          }, 500);
        });
      },
      {
        scriptUrl: ALIYUN_CAPTCHA_SCRIPT_URL,
        region: ALIYUN_CAPTCHA_REGION,
        prefix: ALIYUN_CAPTCHA_PREFIX,
        sceneId: ALIYUN_CAPTCHA_SCENE_ID,
        mode: ALIYUN_CAPTCHA_MODE,
        elementId: CAPTCHA_ELEMENT_ID,
        buttonId: CAPTCHA_BUTTON_ID,
        timeoutMs: CAPTCHA_TIMEOUT_MS,
      }
    );

    if (captchaToken) {
      console.log(`[zaiCaptchaSolver] Captcha solved (token length: ${captchaToken.length})`);
    } else {
      console.warn("[zaiCaptchaSolver] Captcha returned empty token");
    }

    return captchaToken;
  } catch (err) {
    console.warn(
      `[zaiCaptchaSolver] Failed to solve captcha: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return "";
  } finally {
    // Clean up the injected elements
    await page
      .evaluate(
        ({ elementId, buttonId }) => {
          document.getElementById(elementId)?.remove();
          document.getElementById(buttonId)?.remove();
        },
        { elementId: CAPTCHA_ELEMENT_ID, buttonId: CAPTCHA_BUTTON_ID }
      )
      .catch(() => {});
  }
}

/**
 * Test injection point for the captcha solver.
 * Allows unit tests to override the solve function without a real browser.
 */
let solveOverride: ((page: Page) => Promise<string>) | null = null;

export function __setZaiCaptchaSolverOverrideForTesting(
  fn: ((page: Page) => Promise<string>) | null
): void {
  solveOverride = fn;
}

export async function solveZaiCaptchaWithFallback(page: Page): Promise<string> {
  if (solveOverride) return solveOverride(page);
  return solveZaiCaptcha(page);
}
