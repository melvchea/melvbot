import { stripTags } from "../../html_text.js";
import { ProviderHttpError } from "./http_error.js";

export const BRAVE_SEARCH_ENV_KEY = "BRAVE_SEARCH_API_KEY";
export const BRAVE_SEARCH_BASE_URL = "https://api.search.brave.com";
export const BRAVE_WEB_SEARCH_PATH = "/res/v1/web/search";
export const BRAVE_SEARCH_TIMEOUT_MS = 15_000;
export const BRAVE_SEARCH_MAX_COUNT = 20;
export const BRAVE_COUNTRY_ENV_KEY = "BRAVE_COUNTRY";
/** Brave rejects country=SG (422); ALL is its worldwide value. */
export const BRAVE_DEFAULT_COUNTRY = "ALL";
/** Extra snippets appended to the main description, and the combined snippet cap. */
const BRAVE_MAX_EXTRA_SNIPPETS = 2;
const BRAVE_SNIPPET_MAX_CHARS = 400;

/** Brave wraps matched terms in <strong>; drop tags and decode the few entities it emits. */
export function cleanSnippet(raw: string, maxChars = 300): string {
  const text = stripTags(raw)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}…` : text;
}

export type BraveSearchHit = { title: string; url: string; snippet: string };

type BraveWebResult = {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
};

/** Monthly part (last of "perSecond, perMonth") of a rate-limit header; null when absent or unparsable. */
function monthlyPart(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split(",").map((part) => Number.parseInt(part.trim(), 10));
  const monthly = parts.length >= 2 ? parts[parts.length - 1] : Number.NaN;
  return Number.isFinite(monthly) && monthly >= 0 ? monthly : null;
}

/** Monthly quota remaining from `X-RateLimit-Remaining`; null when absent or when `X-RateLimit-Limit` reports no monthly cap (0, as under credit billing). */
export function parseBraveMonthlyRemaining(headers: { get(name: string): string | null }): number | null {
  const limit = monthlyPart(headers.get("x-ratelimit-limit"));
  if (limit === null || limit === 0) {
    return null;
  }
  return monthlyPart(headers.get("x-ratelimit-remaining"));
}

export type BraveSearchOptions = {
  signal?: AbortSignal;
  /** Called with response headers of every request that reached Brave (including errors). */
  onHeaders?: (headers: { get(name: string): string | null }, status: number) => void;
};

/** Description plus up to two cleaned extra snippets, joined with " … " and capped. */
function joinSnippets(item: BraveWebResult): string {
  const extras = (item.extra_snippets ?? [])
    .map((extra) => cleanSnippet(extra))
    .filter(Boolean)
    .slice(0, BRAVE_MAX_EXTRA_SNIPPETS);
  const joined = [cleanSnippet(item.description ?? ""), ...extras].filter(Boolean).join(" … ");
  return joined.length > BRAVE_SNIPPET_MAX_CHARS ? `${joined.slice(0, BRAVE_SNIPPET_MAX_CHARS).trimEnd()}…` : joined;
}

/** Runs Brave web search and returns normalized hits. */
export async function searchWebViaBrave(
  query: string,
  maxResults: number,
  options: BraveSearchOptions = {},
): Promise<BraveSearchHit[]> {
  const apiKey = process.env[BRAVE_SEARCH_ENV_KEY]?.trim();
  if (!apiKey) {
    throw new Error(`${BRAVE_SEARCH_ENV_KEY} is not set`);
  }
  const count = Math.min(Math.max(maxResults, 1), BRAVE_SEARCH_MAX_COUNT);
  const url = new URL(`${BRAVE_SEARCH_BASE_URL}${BRAVE_WEB_SEARCH_PATH}`);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("country", process.env[BRAVE_COUNTRY_ENV_KEY]?.trim() || BRAVE_DEFAULT_COUNTRY);
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("extra_snippets", "true");

  const controller = new AbortController();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), BRAVE_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });
    options.onHeaders?.(response.headers, response.status);
    if (!response.ok) {
      throw new ProviderHttpError(response.status, await response.text());
    }
    const body = (await response.json()) as { web?: { results?: BraveWebResult[] } };
    const hits: BraveSearchHit[] = [];
    for (const item of body.web?.results ?? []) {
      const title = item.title?.trim();
      const hitUrl = item.url?.trim();
      if (!title || !hitUrl) {
        continue;
      }
      hits.push({
        title,
        url: hitUrl,
        snippet: joinSnippets(item),
      });
      if (hits.length >= count) {
        break;
      }
    }
    return hits;
  } finally {
    clearTimeout(timer);
  }
}
