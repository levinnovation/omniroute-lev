/**
 * providerVersions.ts — Externalize web-cookie provider URLs to env vars.
 *
 * LEV fork addition (Phase 6). Each web-cookie provider's base URL is read
 * from an env var with a fallback default, so operators can pin or override
 * a provider endpoint without a code change.
 */
import { sanitizeErrorMessage } from "../utils/error.ts";

const PROVIDER_URL_ENV: Record<string, string> = {
  "zai-web": "ZAI_WEB_URL",
  "deepseek-web": "DEEPSEEK_WEB_URL",
  "gemini-web": "GEMINI_WEB_URL",
  "perplexity-web": "PERPLEXITY_WEB_URL",
  "qwen-web": "QWEN_WEB_URL",
  huggingchat: "HUGGINGCHAT_WEB_URL",
  "t3-chat-web": "T3CHAT_WEB_URL",
};

const PROVIDER_URL_DEFAULTS: Record<string, string> = {
  "zai-web": "https://chat.z.ai",
  "deepseek-web": "https://chat.deepseek.com",
  "gemini-web": "https://gemini.google.com",
  "perplexity-web": "https://www.perplexity.ai",
  "qwen-web": "https://chat.qwen.ai",
  huggingchat: "https://huggingface.co/chat",
  "t3-chat-web": "https://t3.chat",
};

export function getProviderUrl(provider: string): string {
  const envKey = PROVIDER_URL_ENV[provider];
  const fallback = PROVIDER_URL_DEFAULTS[provider];
  if (envKey) {
    const override = process.env[envKey]?.trim();
    if (override) return override;
  }
  return fallback ?? "";
}

export function getAllProviderUrls(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const provider of Object.keys(PROVIDER_URL_DEFAULTS)) {
    result[provider] = getProviderUrl(provider);
  }
  return result;
}

export interface ProviderVersionInfo {
  provider: string;
  url: string;
  detectedVersion: string | null;
  detectedAt: number;
}

const versionCache = new Map<string, { info: ProviderVersionInfo; expiresAt: number }>();
const VERSION_CACHE_TTL_MS = 15 * 60 * 1000;

export async function autoDetectProviderVersion(
  provider: string,
  signal?: AbortSignal | null
): Promise<ProviderVersionInfo> {
  const cached = versionCache.get(provider);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const url = getProviderUrl(provider);
  const info: ProviderVersionInfo = {
    provider,
    url,
    detectedVersion: null,
    detectedAt: Date.now(),
  };

  if (!url) {
    versionCache.set(provider, { info, expiresAt: Date.now() + VERSION_CACHE_TTL_MS });
    return info;
  }

  try {
    const response = await fetch(url, {
      headers: { Accept: "text/html", "User-Agent": "OmniRoute-LEV/1.0" },
      signal: signal ?? undefined,
    });
    if (response.ok) {
      const html = await response.text();
      info.detectedVersion = extractVersionFromHtml(html) ?? extractMetaGenerator(html);
    }
  } catch (error) {
    void sanitizeErrorMessage(error instanceof Error ? error.message : "detection failed");
  }

  versionCache.set(provider, { info, expiresAt: Date.now() + VERSION_CACHE_TTL_MS });
  return info;
}

function extractVersionFromHtml(html: string): string | null {
  const buildMatch = html.match(/["']?buildId["']?\s*[:=]\s*["']([A-Za-z0-9_-]+)["']/);
  if (buildMatch) return buildMatch[1];
  const versionMatch = html.match(/["']?version["']?\s*[:=]\s*["'](\d+\.\d+\.\d+[\w.-]*)["']/i);
  if (versionMatch) return versionMatch[1];
  const appVersionMatch = html.match(/data-app-version=["']([^"']+)["']/i);
  if (appVersionMatch) return appVersionMatch[1];
  return null;
}

function extractMetaGenerator(html: string): string | null {
  const generatorMatch = html.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i);
  return generatorMatch ? generatorMatch[1] : null;
}

export function clearProviderVersionCache(provider?: string): void {
  if (provider) {
    versionCache.delete(provider);
  } else {
    versionCache.clear();
  }
}
