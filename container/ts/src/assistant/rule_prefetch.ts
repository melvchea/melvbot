import { withTimeout } from "../telegram/intercept_log.js";
import { getNote } from "../note/notes.js";
import { findRule, loadPromptCatalog } from "./prompt_files.js";
import { redactForPrompt } from "./redact.js";
import { formatWebSearchResults, webSearch } from "./tools.js";

/** Best-effort budget for the data prefetch; the model can still fetch anything missing itself.
 * Interactive search waits on search up to 11s; 6s is needed for reliability. */
export const RULE_PREFETCH_TIMEOUT_MS = 6_000;

type DataFetcher = () => Promise<string | null>;

type RuleTrigger = {
  rule: string;
  /** Whole-prompt match; conservative on purpose (a false hit only costs a few hundred tokens). */
  match: RegExp;
  /** Deterministic data the rule tells the model to fetch, as ready-to-append user-message blocks. */
  data?: readonly DataFetcher[];
  /** True when `data` already includes a web search, so the generic open-research prefetch is skipped. */
  searches?: boolean;
};

const STOCK_SEARCH_QUERY = "stock market today S&P 500 Nasdaq Straits Times Index STI close";

// prefetchRule only runs for live chat turns, so interactive search is always appropriate.
const stockSearch: DataFetcher = async () => {
  const text = formatWebSearchResults(await webSearch(STOCK_SEARCH_QUERY, "interactive"));
  return `<untrusted source="web_search">\n${text}\n</untrusted>`;
};

const BOND_SEARCH_QUERY = "US Treasury 10-year yield bonds today";

const bondSearch: DataFetcher = async () => {
  const text = formatWebSearchResults(await webSearch(BOND_SEARCH_QUERY, "interactive"));
  return `<untrusted source="web_search">\n${text}\n</untrusted>`;
};

export type Quote = { symbol: string; close: number; prevClose: number; pct: number; time: number };

export const INDEX_SYMBOLS = ["^GSPC", "^IXIC", "^DJI", "^STI"] as const;
export const BOND_SYMBOLS = ["^TNX", "^FVX", "^IRX"] as const;
const SYMBOL_LABELS: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "Nasdaq",
  "^DJI": "Dow",
  "^STI": "STI",
  "^TNX": "US 10Y yield %",
  "^FVX": "US 5Y yield %",
  "^IRX": "US 13W yield %",
};
export const QUOTE_TIMEOUT_MS = 3_000;
// Yahoo answers full Chrome UA strings with HTTP 429 (2026-10-09: DCA Bonds bullet fell back to model text); a bare token passes.
const QUOTE_UA = "Mozilla/5.0";

/** Last two non-null daily closes from a Yahoo v8 chart payload, or null when unusable. */
export function parseYahooChart(symbol: string, json: unknown): Quote | null {
  const result = (
    json as {
      chart?: {
        result?: {
          meta?: { regularMarketPrice?: number; regularMarketTime?: number };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    }
  )?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const stamps = result?.timestamp;
  if (!closes || !stamps) {
    return null;
  }
  const points: { t: number; c: number }[] = [];
  closes.forEach((c, i) => {
    if (typeof c === "number" && Number.isFinite(c) && typeof stamps[i] === "number") {
      points.push({ t: stamps[i], c });
    } else if (i === closes.length - 1 && typeof stamps[i] === "number") {
      // Yahoo leaves the latest daily bar's close null for a while after the session; meta has the price.
      const price = result?.meta?.regularMarketPrice;
      if (typeof price === "number" && Number.isFinite(price)) points.push({ t: result?.meta?.regularMarketTime ?? stamps[i], c: price });
    }
  });
  if (points.length < 2) {
    return null;
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  return { symbol, close: last.c, prevClose: prev.c, pct: ((last.c - prev.c) / prev.c) * 100, time: last.t };
}

export function formatQuotes(quotes: readonly Quote[]): string {
  const sgt = (t: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t * 1000));
  const rows = quotes.map((q) => {
    const sign = q.pct >= 0 ? "+" : "";
    return `${SYMBOL_LABELS[q.symbol] ?? q.symbol} | ${q.close.toFixed(2)} | ${sign}${q.pct.toFixed(2)}% | ${sgt(q.time)}`;
  });
  return ["Name | Last close | % vs prev close | Date (SGT)", ...rows].join("\n");
}

/** One daily quote (3s timeout), or null on any failure. */
export async function fetchYahooQuote(symbol: string, fetchFn: typeof fetch = fetch): Promise<Quote | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const response = await fetchFn(url, {
      headers: { "User-Agent": QUOTE_UA },
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
    return response.ok ? parseYahooChart(symbol, await response.json()) : null;
  } catch {
    return null;
  }
}

/** Fetches daily quotes in parallel (3s each); failed symbols are skipped. Null when none succeed. */
export async function fetchYahooQuotes(
  symbols: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const settled = await Promise.all(symbols.map((symbol) => fetchYahooQuote(symbol, fetchFn)));
  const quotes = settled.filter((q): q is Quote => q !== null);
  if (quotes.length === 0) {
    return null;
  }
  return `<untrusted source="yahoo_finance">\n${formatQuotes(quotes)}\n</untrusted>`;
}

const indexQuotes: DataFetcher = () => fetchYahooQuotes(INDEX_SYMBOLS);

/** Index + yield quotes; falls back to the bond web search when Yahoo gives nothing. */
const bondQuotes: DataFetcher = async () => (await fetchYahooQuotes([...INDEX_SYMBOLS, ...BOND_SYMBOLS])) ?? bondSearch();

/** revision_id lets the cron's full-body write pass --expect-rev (the overwrite guard rejects it otherwise). */
export function dcaNoteBlock(note: { body: string; revision_id: string }): string {
  return `<untrusted source="note">\n<note slug="dollar-cost-averaging" revision_id="${note.revision_id}">\n${redactForPrompt(note.body)}\n</note>\n</untrusted>`;
}

const dcaNote: DataFetcher = async () => dcaNoteBlock(await getNote("dollar-cost-averaging"));

const MARKET_LEAD = String.raw`(?:how(?:'s|'re| is| are| was| were| did| do| does)|what(?:'s| is| was| are)|check|show(?: me)?)`;
const MARKET_TOPIC = String.raw`(?:the\s+)?(?:(?:stock\s+)?markets?|stocks|sti|s&p(?:\s*500)?|nasdaq|dow)`;
const MARKET_TRAIL = String.raw`(?:\s+(?:do|go|doing|going|perform|performing|close|closed|look|looking))?(?:\s+(?:today|now|tonight|yesterday|this\s+(?:week|morning)))?`;
const BOND_TOPIC = String.raw`(?:the\s+)?(?:bonds|bond\s+market|(?:treasur(?:y|ies)|bond)\s+yields?|yields|treasur(?:y|ies)|10\s*-?\s*(?:y|yr|year)(?:\s+(?:yield|treasury))?)`;

/** Table-driven: add rows only for rules with an unambiguous trigger phrase. */
export const RULE_TRIGGERS: readonly RuleTrigger[] = [
  {
    rule: "stock-market",
    match: new RegExp(
      String.raw`^\s*(?:${MARKET_LEAD}\s+${MARKET_TOPIC}${MARKET_TRAIL}|(?:stock\s+market|markets?|stocks|sti|s&p(?:\s*500)?)(?:\s+(?:today|now|update|snapshot))?)\s*[?!.]*\s*$`,
      "i",
    ),
    data: [indexQuotes, stockSearch, dcaNote],
    searches: true,
  },
  {
    // Bond/yield variants of the same rule; quotes come from Yahoo (bond search only as fallback).
    rule: "stock-market",
    match: new RegExp(
      String.raw`^\s*(?:${MARKET_LEAD}\s+${BOND_TOPIC}${MARKET_TRAIL}|${BOND_TOPIC}(?:\s+(?:today|now|update))?)\s*[?!.]*\s*$`,
      "i",
    ),
    data: [bondQuotes, stockSearch, dcaNote],
    searches: true,
  },
];

/** True when the prompt triggers a rule prefetch whose data already includes a web search. */
export function ruleTriggerSearches(prompt: string): boolean {
  return matchRuleTrigger(prompt)?.searches === true;
}

export function matchRuleTrigger(prompt: string): RuleTrigger | null {
  return RULE_TRIGGERS.find((trigger) => trigger.match.test(prompt)) ?? null;
}

export type RulePrefetch = { rule: string; block: string; tools: string[] };

export type RulePrefetchDeps = {
  triggers?: readonly RuleTrigger[];
  loadRuleBody?: (name: string) => string | null;
};

function defaultRuleBody(name: string): string | null {
  try {
    return findRule(loadPromptCatalog(), name)?.body ?? null;
  } catch {
    return null;
  }
}

/** Rule body plus its data for a prompt that clearly triggers a non-always rule, else null. */
export async function prefetchRule(prompt: string, deps: RulePrefetchDeps = {}): Promise<RulePrefetch | null> {
  const triggers = deps.triggers ?? RULE_TRIGGERS;
  const trigger = triggers.find((entry) => entry.match.test(prompt));
  if (!trigger) {
    return null;
  }
  const body = (deps.loadRuleBody ?? defaultRuleBody)(trigger.rule);
  if (body === null) {
    return null;
  }
  const settled = await Promise.all(
    (trigger.data ?? []).map((fetch) =>
      withTimeout(fetch(), RULE_PREFETCH_TIMEOUT_MS, `${trigger.rule} prefetch`).catch(() => null),
    ),
  );
  const blocks = [`<rule name="${trigger.rule}">\n${body}\n</rule>`, ...settled.filter((b): b is string => b !== null)];
  return { rule: trigger.rule, block: blocks.join("\n\n"), tools: [`rule:${trigger.rule}`] };
}
