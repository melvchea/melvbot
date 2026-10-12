import { getWebQuota, recordWebQuota } from "./conversation_store.js";
import { ProviderHttpError } from "./providers/http_error.js";

/**
 * Monthly call counters for the paid-credit page providers. A provider is only skipped once it is at its
 * limit or answered 402/429 (until the month ends); nothing is held back early to save credits.
 */
export const WEB_QUOTA_DEFAULTS = { firecrawl: 500, brightdata: 5000 } as const;
export type QuotaProvider = keyof typeof WEB_QUOTA_DEFAULTS;
const SGT_OFFSET_MS = 8 * 3600_000;

/** Calendar month (SGT) as YYYY-MM. */
export function sgtMonth(now: Date): string {
  return new Date(now.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 7);
}

/** Fraction of the SGT calendar month elapsed, 0..1. */
export function monthFraction(now: Date): number {
  const shifted = new Date(now.getTime() + SGT_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const start = Date.UTC(year, month, 1);
  const end = Date.UTC(year, month + 1, 1);
  return Math.min(1, Math.max(0, (shifted.getTime() - start) / (end - start)));
}

/** WEB_QUOTA_<PROVIDER> overrides the monthly limit; a bad value falls back to the default. */
export function webQuotaLimit(provider: QuotaProvider): number {
  const override = Number.parseInt(process.env[`WEB_QUOTA_${provider.toUpperCase()}`] ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : WEB_QUOTA_DEFAULTS[provider];
}

/** False when the provider is at its monthly limit or was marked exhausted; a DB error leaves it allowed. */
export function webQuotaOk(provider: QuotaProvider, now = new Date()): boolean {
  try {
    const row = getWebQuota(sgtMonth(now)).find((r) => r.provider === provider);
    return !row || (!row.exhausted && row.calls < webQuotaLimit(provider));
  } catch {
    return true;
  }
}

/** Runs one request to `provider`, counting it; a 402/429 answer marks the provider exhausted for the month. */
export async function withWebQuota<T>(provider: QuotaProvider, call: () => Promise<T>, now = new Date()): Promise<T> {
  if (!webQuotaOk(provider, now)) {
    throw new Error(`${provider} monthly quota used`);
  }
  const month = sgtMonth(now);
  record(() => recordWebQuota(month, provider, 1, false));
  try {
    return await call();
  } catch (error) {
    if (error instanceof ProviderHttpError && (error.status === 402 || error.status === 429)) {
      record(() => recordWebQuota(month, provider, 0, true));
    }
    throw error;
  }
}

/** Counter writes are best effort: a failed write must not fail the web request. */
function record(write: () => void): void {
  try {
    write();
  } catch {
    // counts are advisory
  }
}

/** One line for doctor and status, e.g. `firecrawl 12/500, brightdata 3/5000`. */
export function webQuotaLine(now = new Date()): string {
  let rows: { provider: string; calls: number; exhausted: boolean }[] = [];
  try {
    rows = getWebQuota(sgtMonth(now));
  } catch {
    rows = [];
  }
  return (Object.keys(WEB_QUOTA_DEFAULTS) as QuotaProvider[])
    .map((provider) => {
      const row = rows.find((r) => r.provider === provider);
      const exhausted = row?.exhausted ? " exhausted" : "";
      return `${provider} ${row?.calls ?? 0}/${webQuotaLimit(provider)}${exhausted}`;
    })
    .join(", ");
}
