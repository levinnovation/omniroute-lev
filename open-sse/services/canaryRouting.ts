const CANARY_PROVIDERS_ENV = "OMNIROUTE_CANARY_PROVIDERS";
const CANARY_PERCENT_ENV = "OMNIROUTE_CANARY_PERCENT";
const CANARY_KILL_ENV = "OMNIROUTE_CANARY_KILL";
const DEFAULT_CANARY_PERCENT = 5;

export type CanaryConfig = {
  providers: ReadonlySet<string>;
  percent: number;
  killSwitch: boolean;
};

export function getCanaryConfig(): CanaryConfig {
  const rawProviders = process.env[CANARY_PROVIDERS_ENV] ?? "";
  const providers = new Set(
    rawProviders
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  );
  const rawPercent = process.env[CANARY_PERCENT_ENV];
  let percent = DEFAULT_CANARY_PERCENT;
  if (rawPercent !== undefined && rawPercent !== "") {
    const parsed = Number(rawPercent);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      percent = parsed;
    }
  }
  const killSwitch = process.env[CANARY_KILL_ENV] === "on";
  return { providers, percent, killSwitch };
}

function deterministicHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function shouldCanary(provider: string, model: string, requestId: string): boolean {
  const config = getCanaryConfig();
  if (config.killSwitch) return false;
  if (!config.providers.has(provider)) return false;
  if (config.percent <= 0) return false;
  if (config.percent >= 100) return true;
  const hash = deterministicHash(`${provider}:${model}:${requestId}`);
  return hash % 100 < config.percent;
}
