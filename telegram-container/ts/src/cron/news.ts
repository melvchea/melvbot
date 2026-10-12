import { stripTags } from "../html_text.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HEADLINE_LIMIT = 10;
const FETCH_TIMEOUT_MS = 20_000;
const MS_PER_HOUR = 3_600_000;
const SOURCE_SUFFIX = /\s+-\s+[^-]+$/;
const BRACKET_CHUNK = /\[[^[\]]*\]|\([^()]*\)/g;

const CHECK_TIMEOUT_MS = 6_000;
const CHECK_BUDGET_MS = 10_000;
const CHECK_CACHE_MS = 30 * 60_000;
const CANDIDATE_LIMIT = HEADLINE_LIMIT * 2;
const TRACKING_PARAM = /^(utm_|at_|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|ocid$|cmpid$|ref$|ref_src$|source$|taid$)/i;

type FeedSpec = { primaries: string[]; backfill?: string; interleave?: boolean };
const FEEDS: Record<string, FeedSpec> = {
  world: { primaries: ["https://feeds.bbci.co.uk/news/world/rss.xml"], backfill: "https://feeds.bbci.co.uk/news/rss.xml" },
  tech: {
    primaries: [
      "https://www.theregister.com/headlines.atom",
      "https://feeds.bbci.co.uk/news/technology/rss.xml",
      "https://www.techinasia.com/feed",
      "https://www.theverge.com/rss/index.xml",
    ],
  },
  singapore: {
    primaries: [
      "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511",
      "https://www.straitstimes.com/news/singapore/rss.xml",
      "https://mothership.sg/feed/",
    ],
    interleave: true,
  },
};

export type Headline = {
  title: string;
  url: string;
  published: Date;
  source: string;
};

export function displayTitle(title: string): string {
  const strippedSuffix = title.replace(SOURCE_SUFFIX, "").trim() || title;
  const stripped = strippedSuffix.replace(BRACKET_CHUNK, "").replace(/\s+/g, " ").trim();
  return stripped || title;
}

function parseDate(value: string): Date | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function firstTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) {
    return "";
  }
  return decodeEntities(stripTags(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))).trim();
}

function linkFrom(block: string): string {
  const atom = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atom?.[1]) {
    return decodeEntities(atom[1]);
  }
  return firstTag(block, "link");
}

export function parseFeedItems(xml: string): Headline[] {
  const items: Headline[] = [];
  const chunks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) ?? [];
  for (const chunk of chunks) {
    const title = firstTag(chunk, "title");
    const url = linkFrom(chunk);
    const published =
      parseDate(firstTag(chunk, "pubDate")) ??
      parseDate(firstTag(chunk, "published")) ??
      parseDate(firstTag(chunk, "updated"));
    if (!title || !url || published === null) {
      continue;
    }
    items.push({ title, url, published, source: firstTag(chunk, "source") });
  }
  return items;
}

function titleWords(title: string): Set<string> {
  return new Set(displayTitle(title).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/** Same story: most words of the shorter title appear in the other ("Watch: X" next to "X, says Y"). */
function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const word of a) {
    if (b.has(word)) {
      shared += 1;
    }
  }
  if (shared === a.size && shared === b.size) {
    return true;
  }
  return shared >= 4 && shared / Math.min(a.size, b.size) >= 0.7;
}

export function selectHeadlines(
  primary: Headline[],
  backfill: Headline[],
  now: Date,
  limit = HEADLINE_LIMIT,
): Headline[] {
  const cutoff = now.getTime() - MAX_AGE_MS;
  const chosen: Headline[] = [];
  const seen: Set<string>[] = [];
  for (const pool of [primary, backfill]) {
    for (const item of pool) {
      if (item.published.getTime() <= cutoff) {
        continue;
      }
      const words = titleWords(item.title);
      if (seen.some((other) => nearDuplicate(words, other))) {
        continue;
      }
      seen.push(words);
      chosen.push(item);
      if (chosen.length >= limit) {
        return chosen;
      }
    }
  }
  return chosen;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": BROWSER_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`news HTTP ${response.status}`);
  }
  return response.text();
}

export function canonicalUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.hash = "";
  return parsed.toString();
}

export type LinkCheck = { ok: boolean; url: string; reason?: string };
export type LinkCheckDeps = { fetchImpl?: typeof fetch; cache?: Map<string, { at: number; result: LinkCheck }>; now?: () => number };

const linkCache = new Map<string, { at: number; result: LinkCheck }>();

function looksLikeHomepage(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").length < 4;
  } catch {
    return false;
  }
}

/**
 * Classify one article URL: GET with a browser UA, follow redirects, drop the body after headers.
 * Dropped: network error/timeout, 404/410/5xx, or a redirect that lands on a homepage/section root.
 * 401/403/429 count as working: they are bot protection, a human browser loads the page fine.
 */
export async function checkLink(raw: string, deps: LinkCheckDeps = {}, budget?: AbortSignal): Promise<LinkCheck> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = deps.cache ?? linkCache;
  const nowMs = (deps.now ?? Date.now)();
  const cached = cache.get(raw);
  if (cached && nowMs - cached.at < CHECK_CACHE_MS) {
    return cached.result;
  }
  const signals = [AbortSignal.timeout(CHECK_TIMEOUT_MS)];
  if (budget) {
    signals.push(budget);
  }
  let result: LinkCheck;
  let definitive = true;
  try {
    const response = await fetchImpl(raw, {
      headers: { "user-agent": BROWSER_UA, accept: "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.any(signals),
    });
    void response.body?.cancel().catch(() => undefined);
    const finalUrl = canonicalUrl(response.url || raw);
    const status = response.status;
    if (status === 404 || status === 410 || status >= 500) {
      result = { ok: false, url: finalUrl, reason: `HTTP ${status}` };
    } else if (looksLikeHomepage(finalUrl) && !looksLikeHomepage(raw)) {
      result = { ok: false, url: finalUrl, reason: "redirects to homepage" };
    } else {
      result = { ok: true, url: finalUrl };
    }
  } catch (error) {
    definitive = false;
    const name = error instanceof Error ? error.name : "";
    const reason = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error";
    result = { ok: false, url: raw, reason };
  }
  if (definitive) {
    cache.set(raw, { at: nowMs, result });
  }
  return result;
}

export type ExcludedHeadline = { title: string; url: string; reason: string };

/** Check candidates in parallel and keep the working ones in order (deduped by final URL), up to `limit`. */
export async function keepWorking(
  candidates: Headline[],
  deps: LinkCheckDeps = {},
  limit = HEADLINE_LIMIT,
  budgetMs = CHECK_BUDGET_MS,
): Promise<{ items: Headline[]; excluded: ExcludedHeadline[] }> {
  const budget = AbortSignal.timeout(budgetMs);
  const checks = await Promise.all(
    candidates.map((item) => checkLink(canonicalUrl(item.url), deps, budget)),
  );
  const items: Headline[] = [];
  const excluded: ExcludedHeadline[] = [];
  const seen = new Set<string>();
  candidates.forEach((item, index) => {
    const check = checks[index];
    if (!check.ok) {
      excluded.push({ title: displayTitle(item.title), url: item.url, reason: check.reason ?? "failed" });
    } else if (seen.has(check.url)) {
      excluded.push({ title: displayTitle(item.title), url: check.url, reason: "duplicate url" });
    } else if (items.length < limit) {
      seen.add(check.url);
      items.push({ ...item, url: check.url });
    }
  });
  return { items, excluded };
}

function interleave(pools: Headline[][]): Headline[] {
  const out: Headline[] = [];
  for (let i = 0; pools.some((pool) => i < pool.length); i += 1) {
    for (const pool of pools) {
      if (i < pool.length) {
        out.push(pool[i]);
      }
    }
  }
  return out;
}

export async function fetchSectionChecked(
  section: string,
  now = new Date(),
  deps: LinkCheckDeps & { fetchText?: (url: string) => Promise<string> } = {},
): Promise<{ items: Headline[]; excluded: ExcludedHeadline[] }> {
  const spec = FEEDS[section];
  if (!spec) {
    throw new Error(`unknown news section: ${section}`);
  }
  const getText = deps.fetchText ?? fetchText;
  const pools: Headline[][] = [];
  const errors: unknown[] = [];
  for (const url of spec.primaries) {
    try {
      pools.push(parseFeedItems(await getText(url)).sort((a, b) => b.published.getTime() - a.published.getTime()));
    } catch (error) {
      errors.push(error);
      pools.push([]);
    }
  }
  if (!pools.some((pool) => pool.length > 0)) {
    throw errors[0] instanceof Error ? errors[0] : new Error(`no headlines for ${section}`);
  }
  const primary = spec.interleave ? interleave(pools) : pools.flat();
  let candidates = selectHeadlines(primary, [], now, CANDIDATE_LIMIT);
  if (candidates.length < CANDIDATE_LIMIT && spec.backfill) {
    try {
      const extra = parseFeedItems(await getText(spec.backfill));
      candidates = selectHeadlines(candidates, extra, now, CANDIDATE_LIMIT);
    } catch {
      /* keep primary */
    }
  }
  return keepWorking(candidates, deps);
}

export async function fetchSection(section: string, now = new Date()): Promise<Headline[]> {
  return (await fetchSectionChecked(section, now)).items;
}

export function formatNewsBlock(sections: Record<string, Headline[]>, now = new Date()): string {
  const lines: string[] = [];
  for (const [name, items] of Object.entries(sections)) {
    lines.push(`## news_${name} (last 24h, ${items.length} items)`);
    lines.push(
      JSON.stringify(
        items.map((item) => ({
          title: displayTitle(item.title),
          url: item.url,
          published: item.published.toISOString(),
          age_hours: Math.round(((now.getTime() - item.published.getTime()) / MS_PER_HOUR) * 10) / 10,
          source: item.source,
        })),
      ),
    );
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export type NewsPrefetch = {
  block: string;
  sections: Record<string, Headline[]>;
  excluded: Record<string, ExcludedHeadline[]>;
};

export async function prefetchNewsData(): Promise<NewsPrefetch> {
  const now = new Date();
  const sections: Record<string, Headline[]> = {};
  const excluded: Record<string, ExcludedHeadline[]> = {};
  const errors: string[] = [];
  for (const name of ["world", "tech", "singapore"]) {
    try {
      const result = await fetchSectionChecked(name, now);
      sections[name] = result.items;
      excluded[name] = result.excluded;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`ERROR: news_${name} fetch failed: ${detail}`);
      sections[name] = [];
      excluded[name] = [];
    }
  }
  const block = [formatNewsBlock(sections, now), ...errors].filter(Boolean).join("\n");
  return { block, sections, excluded };
}

export async function prefetchNews(): Promise<string> {
  return (await prefetchNewsData()).block;
}
