import { ProviderHttpError } from "./http_error.js";
import type { SearchHit } from "../search_router.js";

export const FIRECRAWL_ENV_KEY = "FIRECRAWL_API_KEY";
export const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
export const FIRECRAWL_TIMEOUT_MS = 15_000;

async function post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const apiKey = process.env[FIRECRAWL_ENV_KEY]?.trim();
  if (!apiKey) {
    throw new Error(`${FIRECRAWL_ENV_KEY} is not set`);
  }
  const response = await fetch(`${FIRECRAWL_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new ProviderHttpError(response.status, await response.text());
  }
  const data = (await response.json()) as Record<string, unknown>;
  if (data.success === false) {
    throw new Error(`firecrawl ${path} failed`);
  }
  return data;
}

/** Firecrawl web search (POST /v2/search); hits without a title or URL are dropped. */
export async function searchWebViaFirecrawl(query: string, maxResults: number): Promise<SearchHit[]> {
  const data = await post("/search", { query, limit: Math.max(maxResults, 1), sources: ["web"] }, FIRECRAWL_TIMEOUT_MS);
  const raw = data.data;
  const items = (Array.isArray(raw) ? raw : (raw as { web?: unknown } | undefined)?.web) ?? [];
  const hits: SearchHit[] = [];
  for (const item of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!title || !url) {
      continue;
    }
    hits.push({ title, url, snippet: typeof item.description === "string" ? item.description.trim() : "" });
  }
  return hits.slice(0, maxResults);
}

/** Firecrawl main-content markdown for one URL (POST /v2/scrape); null when the page has no text. */
export async function scrapeViaFirecrawl(url: string, timeoutMs: number): Promise<{ title: string; markdown: string } | null> {
  const data = await post("/scrape", { url, formats: ["markdown"], onlyMainContent: true }, timeoutMs);
  const page = data.data as { markdown?: unknown; metadata?: { title?: unknown } } | undefined;
  const markdown = typeof page?.markdown === "string" ? page.markdown.trim() : "";
  if (!markdown) {
    return null;
  }
  const title = typeof page?.metadata?.title === "string" ? page.metadata.title.trim() : "";
  return { title, markdown };
}
