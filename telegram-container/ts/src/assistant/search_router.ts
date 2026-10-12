import { getBraveUsage, recordBraveUsage } from "./conversation_store.js";
import { BRAVE_SEARCH_ENV_KEY, parseBraveMonthlyRemaining, searchWebViaBrave } from "./providers/brave_search.js";
import { ProviderHttpError } from "./providers/http_error.js";
import { kagiStatus, searchWebViaKagi } from "./providers/kagi_search.js";
import { FIRECRAWL_ENV_KEY, searchWebViaFirecrawl } from "./providers/firecrawl.js";
import { monthFraction, sgtMonth, webQuotaOk, withWebQuota } from "./web_quota.js";

export type SearchHit = { title: string; url: string; snippet: string; date?: string };
export type CallerKind = "interactive" | "background";
export type SearchRoute = "cache" | "kagi" | "brave" | "firecrawl";
export type SearchProvider = "kagi" | "brave" | "firecrawl";
export const DEFAULT_SEARCH_PROVIDERS: readonly SearchProvider[] = ["kagi", "brave", "firecrawl"];

export const BRAVE_MONTHLY_QUOTA = 1000;
/** Fraction of the quota kept back (used for the status pace display). */
export const BRAVE_RESERVE_FRACTION = 0.1;
/** Pace never drops below this many calls, so early-month searches can still use Brave first. */
export const BRAVE_PACE_FLOOR = 20;

export function braveQuota(): number {
  const override = Number.parseInt(process.env.WEB_QUOTA_BRAVE ?? process.env.BRAVE_MONTHLY_QUOTA ?? "", 10);
  return Number.isFinite(override) && override > 0 ? override : BRAVE_MONTHLY_QUOTA;
}

export function bravePace(quota: number, now: Date): number {
  const reserve = quota * BRAVE_RESERVE_FRACTION;
  return Math.max(BRAVE_PACE_FLOOR, (quota - reserve) * monthFraction(now));
}

export type SearchOutcome = { hits: SearchHit[]; route: SearchRoute };

export type RouterDeps = {
  kagi: (query: string, limit: number) => Promise<SearchHit[]>;
  /** Configured and breaker closed; Kagi is skipped otherwise. */
  kagiAvailable: () => boolean;
  /** Called only when a request is actually sent to Brave. */
  brave: (query: string, limit: number) => Promise<SearchHit[]>;
  firecrawl: (query: string, limit: number) => Promise<SearchHit[]>;
  braveEnabled: () => boolean;
  firecrawlEnabled: () => boolean;
  /** False when Firecrawl is at its monthly limit or was marked exhausted; it is skipped without a request. */
  firecrawlQuotaOk: () => boolean;
  providers: () => SearchProvider[];
  now: () => Date;
  /** Brave calls used this month (remaining header preferred over the local counter). */
  usedThisMonth: (now: Date, quota: number) => number;
  onBraveSent: (now: Date) => void;
  onBraveExhausted: (now: Date) => void;
  log: (line: string) => void;
};

let exhaustedMonth: string | null = null;

function safeDb<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function braveUsage(now = new Date(), quota = braveQuota()): { used: number; quota: number; pace: number; exhausted: boolean } {
  const month = sgtMonth(now);
  const row = safeDb(() => getBraveUsage(month), { calls: 0, remaining: null });
  const used = row.remaining !== null ? Math.max(0, quota - row.remaining) : row.calls;
  return { used, quota, pace: bravePace(quota, now), exhausted: exhaustedMonth === month || used >= quota };
}

/** Providers from SEARCH_PROVIDERS (comma list of kagi, brave, firecrawl); unknown names are dropped. */
export function configuredProviders(): SearchProvider[] {
  const raw = process.env.SEARCH_PROVIDERS?.trim();
  if (!raw) {
    return [...DEFAULT_SEARCH_PROVIDERS];
  }
  const out: SearchProvider[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if ((name === "kagi" || name === "brave" || name === "firecrawl") && !out.includes(name)) {
      out.push(name);
    }
  }
  return out.length > 0 ? out : [...DEFAULT_SEARCH_PROVIDERS];
}

export const defaultRouterDeps: RouterDeps = {
  kagi: (query, limit) => searchWebViaKagi(query, limit),
  kagiAvailable: () => kagiStatus() === "ready",
  brave: (query, limit) =>
    searchWebViaBrave(query, limit, {
      onHeaders: (headers, status) => {
        const now = new Date();
        const month = sgtMonth(now);
        const remaining = parseBraveMonthlyRemaining(headers);
        if (remaining !== null) {
          safeDb(() => recordBraveUsage(month, remaining, undefined, false), undefined);
        }
        if (status === 429 || status === 402 || remaining === 0) {
          exhaustedMonth = month;
        }
      },
    }),
  firecrawl: (query, limit) => withWebQuota("firecrawl", () => searchWebViaFirecrawl(query, limit)),
  braveEnabled: () => Boolean(process.env[BRAVE_SEARCH_ENV_KEY]?.trim()),
  firecrawlEnabled: () => Boolean(process.env[FIRECRAWL_ENV_KEY]?.trim()),
  firecrawlQuotaOk: () => webQuotaOk("firecrawl"),
  providers: configuredProviders,
  now: () => new Date(),
  usedThisMonth: (now, quota) => braveUsage(now, quota).used,
  onBraveSent: (now) => safeDb(() => recordBraveUsage(sgtMonth(now), null), undefined),
  onBraveExhausted: (now) => {
    exhaustedMonth = sgtMonth(now);
  },
  log: (line) => console.error(line),
};

export function resetBraveExhaustion(): void {
  exhaustedMonth = null;
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Searches the providers in SEARCH_PROVIDERS order (default kagi, brave, firecrawl) and returns the first
 * non-empty answer. A provider that is disabled, over quota, errors or returns no hits falls through to
 * the next one. Throws only when a provider failed and no provider returned hits.
 */
export async function routedSearch(
  query: string,
  limit: number,
  kind: CallerKind,
  deps: RouterDeps = defaultRouterDeps,
): Promise<SearchOutcome> {
  const started = Date.now();
  const now = deps.now();
  const quota = braveQuota();
  const providers = deps.providers();
  const reasons: string[] = [];
  let errored = false;

  const finish = (hits: SearchHit[], route: SearchRoute): SearchOutcome => {
    const used = deps.usedThisMonth(now, quota);
    deps.log(`web_search: route=${route} kind=${kind} ms=${Date.now() - started} hits=${hits.length} brave=${used}/${quota}`);
    return { hits, route };
  };

  const braveAllowed = (): boolean => {
    if (!deps.braveEnabled()) {
      return false;
    }
    const used = deps.usedThisMonth(now, quota);
    return exhaustedMonth !== sgtMonth(now) && used < quota;
  };

  const runBrave = async (): Promise<SearchHit[]> => {
    deps.onBraveSent(now);
    try {
      return await deps.brave(query, limit);
    } catch (error) {
      if (error instanceof ProviderHttpError && (error.status === 429 || error.status === 402)) {
        deps.onBraveExhausted(now);
      }
      throw error;
    }
  };

  for (const name of providers) {
    if (name === "kagi" && !deps.kagiAvailable()) {
      reasons.push(`kagi ${kagiStatus()}`);
      continue;
    }
    if (name === "brave" && !braveAllowed()) {
      reasons.push(`brave ${deps.braveEnabled() ? "exhausted" : "disabled"}`);
      continue;
    }
    if (name === "firecrawl" && !deps.firecrawlEnabled()) {
      reasons.push("firecrawl disabled");
      continue;
    }
    if (name === "firecrawl" && !deps.firecrawlQuotaOk()) {
      reasons.push("firecrawl over quota");
      continue;
    }
    try {
      const hits = name === "kagi" ? await deps.kagi(query, limit) : name === "brave" ? await runBrave() : await deps.firecrawl(query, limit);
      if (hits.length > 0) {
        return finish(hits, name);
      }
      reasons.push(`${name} 0 results`);
    } catch (error) {
      errored = true;
      reasons.push(`${name} ${errText(error)}`);
    }
  }
  if (errored) {
    throw new Error(`web search failed: ${reasons.join("; ")}`);
  }
  deps.log(`web_search: ${reasons.join("; ") || "no providers"}`);
  return finish([], providers[0] ?? "brave");
}
