import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { runGoogleCli } from "../google/cli.js";
import { insertAutoHistoryLine } from "../note/notes.js";
import { validateProcedureNoteBody } from "../note/note_schema.js";
import { extractSection } from "./confirm.js";
import { assertFetchableUrl, assertPublicHost } from "./net_guard.js";
import { type CallerKind, routedSearch } from "./search_router.js";
import { fetchHtmlViaBrightData } from "./providers/brightdata.js";
import { scrapeViaFirecrawl } from "./providers/firecrawl.js";
import { type PromptCatalog, readRule } from "./prompt_files.js";
import { clearPageCache, getPageCache, putPageCache, type PageCacheRow } from "./conversation_store.js";
import { capText, htmlToMarkdown, TtlCache, WEB_FETCH_MAX_CHARS } from "./web_content.js";
import { withWebQuota } from "./web_quota.js";

const execFileAsync = promisify(execFile);

export const CLI_TIMEOUT_MS = 30_000;
export const CLI_OUTPUT_MAX_BYTES = 200_000;
export const WEB_FETCH_TIMEOUT_MS = 10_000;
export const WEB_FETCH_MAX_BYTES = 500_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 8;
/** Hard total deadline per fetched URL (Firecrawl, Bright Data and in-process fallback). */
export const WEB_FETCH_DEADLINE_MS = 12_000;
export const WEB_FETCH_MAX_URLS = 3;
/** Per-provider cap inside WEB_FETCH_DEADLINE_MS; Bright Data and the in-process step get whatever is left. */
export const WEB_FETCH_PROVIDER_MS = 8_000;
export const WEB_SEARCH_MAX_QUERIES = 3;
export const WEB_SEARCH_READ_MAX_QUERIES = 2;
export const WEB_SEARCH_READ_MAX_PAGES = 2;
/** Domains that block bots or paywall; fetching them wastes the deadline. Subdomains included. */
export const HOSTILE_DOMAINS: ReadonlySet<string> = new Set([
  "investing.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "barrons.com",
  "seekingalpha.com",
]);

/** Domains that refuse datacenter IPs and are never fetched (the guard rejects them before any provider). */
export const FETCH_BLOCKED_DOMAINS: ReadonlySet<string> = new Set(["reddit.com", "redd.it"]);

export function isHostileHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const domain of HOSTILE_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

function isFetchBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  for (const domain of FETCH_BLOCKED_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

function isHostileUrl(url: string): boolean {
  try {
    return isHostileHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Stable reorder: hits from hostile domains go last (snippets stay useful). */
export function deprioritiseHostile(hits: WebSearchHit[]): WebSearchHit[] {
  return [...hits.filter((h) => !isHostileUrl(h.url)), ...hits.filter((h) => isHostileUrl(h.url))];
}
export const OPEN_WEB_RESEARCH_MAX_QUERY_CHARS = 200;
export const OPEN_WEB_RESEARCH_RE =
  /\b(linkedin|reviews?|forums?|reddit|sentiment|what (?:do|does)|(?:say|says|said) about)\b/i;
/** Broader open-web phrasings; only counted when the message is not about the user's own data. */
export const OPEN_WEB_RESEARCH_WIDE_RE =
  /\b(vs\.?|versus|alternatives? to|pros and cons|worth (?:it|buying)|opinions? (?:on|about)|people (?:say|think)|hacker news|twitter|latest news|look(?:ing)? (?:it )?up|google (?:it|for)|search (?:the web|online|for))\b/i;
/** Own-data intent: a prefetch here would only mark the turn untrusted and block its writes. */
const OWN_DATA_RE = /\b(spend|spent|note|notes|sheet|sheets|owner1|owner2|ev|cron|calendar|tasks?|inbox|log|add|remind|delete|void|rules?)\b/i;
export const WEB_SEARCH_CACHE_MS = 10 * 60_000;
export const WEB_FETCH_CACHE_MS = 60 * 60_000;
const WEB_CACHE_MAX_ENTRIES = 50;

/** Returns a focused search query when the prompt asks for open-web research. */
export function openWebResearchQuery(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!OPEN_WEB_RESEARCH_RE.test(trimmed) && !(OPEN_WEB_RESEARCH_WIDE_RE.test(trimmed) && !OWN_DATA_RE.test(trimmed))) {
    return null;
  }
  const focused = trimmed
    .replace(/\b(what (?:do|does)|linkedin,?|reviews?,?|forums?,?|say about|sentiment|look(?:ing)? (?:it )?up|google (?:it|for)|search (?:the web|online|for))\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (focused || trimmed).slice(0, OPEN_WEB_RESEARCH_MAX_QUERY_CHARS);
}

/** First-two-argument allowlist for melvbot_cli. */
export const CLI_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  sheet: new Set(["rules", "spend", "ev", "pin", "rename", "create"]),
  note: new Set(["list", "get", "add", "describe", "delete", "restore", "append-history", "replace-section", "replace-text", "rename"]),
  memory: new Set(["undo"]),
  cron: new Set(["list", "get", "add", "update", "enable", "disable", "delete"]),
  google: new Set(["calendar", "tasks"]),
  outlook: new Set(["inbox"]),
};

export function isAllowedCliCall(args: readonly string[]): boolean {
  const [first, second] = args;
  const allowedSeconds = first ? CLI_ALLOWLIST[first] : undefined;
  return Boolean(allowedSeconds && second !== undefined && allowedSeconds.has(second));
}

export type CliResult = { stdout: string; stderr: string };

type Capture = { stdout: string; stderr: string };
const captureStore = new AsyncLocalStorage<Capture>();
let capturePatched = false;

/** Routes process.stdout/stderr writes made inside `captureStore.run` to that capture; all other writes pass through untouched. */
function patchStdioCapture(): void {
  if (capturePatched) {
    return;
  }
  capturePatched = true;
  for (const name of ["stdout", "stderr"] as const) {
    const stream = process[name];
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const capture = captureStore.getStore();
      if (!capture) {
        return original(chunk, ...rest);
      }
      capture[name] += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
      callback?.();
      return true;
    }) as typeof stream.write;
  }
}

/**
 * Read-only CLI commands that run in-process (saves a ~300ms node start per call). They only print through
 * process.stdout/stderr, never call process.exit and do not read MELVBOT_CHAT_KEY; writes always spawn.
 */
const IN_PROCESS_CLI: ReadonlyArray<{ match: (args: readonly string[]) => boolean; run: (args: string[]) => Promise<number> }> = [
  { match: (args) => args[0] === "google" && (args[1] === "calendar" || args[1] === "tasks") && args[2] === "list", run: (args) => runGoogleCli(args.slice(1)) },
];

export async function runInProcess(args: readonly string[], run: (args: string[]) => Promise<number>): Promise<CliResult> {
  patchStdioCapture();
  const capture: Capture = { stdout: "", stderr: "" };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Command failed: ${formatCliCommand(args)}\ntimed out after ${CLI_TIMEOUT_MS}ms`)), CLI_TIMEOUT_MS);
  });
  try {
    const code = await Promise.race([captureStore.run(capture, () => run([...args])), timeout]);
    if (code !== 0) {
      throw Object.assign(new Error(`Command failed: ${formatCliCommand(args)}\n${capture.stderr}`), { code, stdout: capture.stdout, stderr: capture.stderr });
    }
    if (Buffer.byteLength(capture.stdout) > CLI_OUTPUT_MAX_BYTES) {
      throw new Error("stdout maxBuffer length exceeded");
    }
    return { stdout: capture.stdout, stderr: capture.stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `melvbot <args>` with no shell, under the CLI_ALLOWLIST. */
/** `melvbot a b c` for error messages; args over 120 chars are cut to 60 chars plus `…(N chars)`. */
export function formatCliCommand(args: readonly string[]): string {
  const shown = args.map((arg) => (arg.length > 120 ? `${arg.slice(0, 60)}…(${arg.length} chars)` : arg));
  return `melvbot ${shown.join(" ")}`;
}

/** execFile embeds the full command in error.message; rewrite it so huge args are not echoed. stderr is kept. */
export function shortenSpawnError(error: unknown, args: readonly string[]): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const full = `melvbot ${args.join(" ")}`;
  if (error.message.includes(full)) {
    error.message = error.message.split(full).join(formatCliCommand(args));
  }
  return error;
}

export async function melvbotCli(args: readonly string[], options: { chatKey?: string | null } = {}): Promise<CliResult> {
  if (!isAllowedCliCall(args)) {
    throw new Error(`tool call not allowed: ${formatCliCommand(args)}`);
  }
  const inProcess = IN_PROCESS_CLI.find((entry) => entry.match(args));
  if (inProcess) {
    return runInProcess(args, inProcess.run);
  }
  try {
    const { stdout, stderr } = await execFileAsync("melvbot", [...args], {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: CLI_OUTPUT_MAX_BYTES,
      env: options.chatKey ? { ...process.env, MELVBOT_CHAT_KEY: options.chatKey } : process.env,
    });
    return { stdout, stderr };
  } catch (error) {
    throw shortenSpawnError(error, args);
  }
}

export function toolReadRule(catalog: PromptCatalog, name: string): string {
  return readRule(catalog, name);
}

/** Sections offer_save may write to. `## Rules` is deliberately excluded:
 * that section is edited only through the taught-behaviour Confirm flow. */
export const SAVE_SECTIONS = ["## Current pick", "## Shortlist", "## History"] as const;
export type SaveSection = (typeof SAVE_SECTIONS)[number];

export function hashOfferSavePayload(slug: string, section: string, text: string): string {
  return createHash("sha256").update(`${slug}\0${section}\0${text}`).digest("hex");
}

export function isSaveSection(value: string): value is SaveSection {
  return (SAVE_SECTIONS as readonly string[]).includes(value);
}

export function assertOfferSaveAllowed(slug: string, section: string, existingSlugs: readonly string[]): void {
  if (!existingSlugs.includes(slug)) {
    throw new Error(`unknown note slug: ${slug}`);
  }
  if (!isSaveSection(section)) {
    throw new Error(`section must be one of: ${SAVE_SECTIONS.join(", ")}`);
  }
}

function sectionBounds(body: string, heading: string): { start: number; end: number } | null {
  const idx = body.indexOf(heading);
  if (idx === -1) {
    return null;
  }
  const after = idx + heading.length;
  const nextHeadingMatch = /\n##\s/.exec(body.slice(after));
  const end = nextHeadingMatch ? after + nextHeadingMatch.index : body.length;
  return { start: idx, end };
}

/**
 * Replaces a `## Current pick` section's body with `text`, or appends `text`
 * as a new bullet under `## Shortlist`/`## History`, creating the heading at
 * the end of the Note if it's missing. Every other section is untouched.
 */
export function buildOfferSaveSummary(
  slug: string,
  section: SaveSection,
  text: string,
  existingBody: string,
): string {
  const merged = mergeSaveSection(existingBody, section, text);
  validateProcedureNoteBody(slug, merged, existingBody);
  const bounds = sectionBounds(existingBody, section);
  const beforeSection = bounds
    ? existingBody.slice(bounds.start + section.length, bounds.end).trim() || "(empty)"
    : "(missing)";
  const afterSection = bounds
    ? merged.slice(bounds.start + section.length, bounds.end).trim()
    : mergeSaveSection("", section, text).slice(section.length).trim();
  const parts = [
    `Save to ${slug} (${section})?`,
    "",
    "Will write:",
    text.trim(),
  ];
  if (section === "## Current pick") {
    const oldPick = extractSection(existingBody, "## Current pick");
    const newPick = text.trim();
    if (oldPick && oldPick !== newPick) {
      const dateStamp = new Date().toISOString().slice(0, 10);
      parts.push("", `Will move previous pick to History: ${oldPick} → ${newPick} (${dateStamp})`);
    }
  }
  parts.push("", `Section before: ${beforeSection}`, `Section after: ${afterSection}`);
  return parts.join("\n");
}

export function mergeSaveSection(body: string, section: SaveSection, text: string): string {
  const cleaned = text.trim();
  let workingBody = body;
  if (section === "## Current pick") {
    const oldPick = extractSection(body, "## Current pick");
    if (oldPick && oldPick !== cleaned) {
      const dateStamp = new Date().toISOString().slice(0, 10);
      workingBody = insertAutoHistoryLine(
        body,
        `- ${dateStamp} (auto) Picked ${oldPick} → ${cleaned}`,
      );
    }
  }
  const bounds = sectionBounds(workingBody, section);
  if (bounds === null) {
    const separator = workingBody.trim() ? "\n\n" : "";
    const content = section === "## Current pick" ? cleaned : `- ${cleaned}`;
    return `${workingBody}${separator}${section}\n${content}\n`;
  }
  const before = workingBody.slice(0, bounds.start + section.length);
  const after = workingBody.slice(bounds.end);
  if (section === "## Current pick") {
    return `${before}\n${cleaned}\n${after}`;
  }
  const sectionBody = workingBody.slice(bounds.start + section.length, bounds.end).replace(/\s*$/, "");
  return `${before}${sectionBody}\n- ${cleaned}\n${after}`;
}

async function fetchOnce(url: URL, signal: AbortSignal): Promise<Response> {
  assertFetchableUrl(url);
  await assertPublicHost(url.hostname);
  return fetch(url, { redirect: "manual", signal });
}

export type WebFetchResult = { url: string; contentType: string; text: string };

export type WebSearchHit = { title: string; url: string; snippet: string; date?: string };
export type WebSearchResult = { query: string; results: WebSearchHit[] };

export const SNIPPET_MAX_CHARS = 250;

const TRACKING_PARAMS = new Set(["gclid", "fbclid", "mc_cid", "mc_eid", "ref", "ref_src", "igshid", "si", "spm"]);

/** Drops tracking params (utm_*, gclid, ...) and the fragment; unparseable URLs pass through. */
export function cleanResultUrl(raw: string): string {
  try {
    const u = new URL(raw);
    let changed = u.hash !== "";
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    u.hash = "";
    return changed ? u.toString() : raw;
  } catch {
    return raw;
  }
}

/** Dedupe key: scheme-less, lowercase host without www., no trailing slash. */
export function resultUrlKey(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^([^/?#]*)/, (host) => host.toLowerCase().replace(/^www\./, "")).replace(/\/+$/, "");
}

/** Cleans every hit URL and drops later duplicates (also against `seen`, shared across queries). */
export function cleanHits(hits: readonly WebSearchHit[], seen: Set<string> = new Set()): WebSearchHit[] {
  const out: WebSearchHit[] = [];
  for (const hit of hits) {
    const url = cleanResultUrl(hit.url);
    const key = resultUrlKey(url);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ ...hit, url });
  }
  return out;
}

function trimSnippet(text: string): string {
  if (text.length <= SNIPPET_MAX_CHARS) {
    return text;
  }
  const cut = text.slice(0, SNIPPET_MAX_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > SNIPPET_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function formatWebSearchResults(result: WebSearchResult): string {
  if (result.results.length === 0) {
    return `No results for: ${result.query}`;
  }
  return result.results
    .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.date ? `\n   (${hit.date})` : ""}\n   ${trimSnippet(hit.snippet)}`)
    .join("\n\n");
}

/** Searches the public web via Kagi, then Brave, then Firecrawl (see search_router.ts). */
export async function webSearch(rawQuery: string, kind: CallerKind = "background"): Promise<WebSearchResult> {
  const query = rawQuery.trim();
  if (!query) {
    throw new Error("web_search requires a non-empty query");
  }
  const started = Date.now();
  let cached = true;
  const result = await searchCache.get(query.toLowerCase(), async () => {
    cached = false;
    const { hits } = await routedSearch(query, WEB_SEARCH_MAX_RESULTS, kind);
    return { query, results: deprioritiseHostile(cleanHits(hits)) };
  });
  if (cached) {
    console.error(`web_search: route=cache kind=${kind} ms=${Date.now() - started} hits=${result.results.length} brave=cached`);
  }
  return result;
}

function errMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Runs up to WEB_SEARCH_MAX_QUERIES searches in parallel (cache + router per query). One query returns the
 * plain formatted results; several are grouped under `### <query>` and a failed query shows a note instead
 * of failing the rest. Throws only when every query failed. `hits` collects the ranked hits per query.
 */
export async function webSearchMany(
  rawQueries: readonly string[],
  kind: CallerKind = "background",
  hits: WebSearchHit[][] = [],
): Promise<string> {
  const queries = [...new Set(rawQueries.map((q) => q.trim()).filter(Boolean))].slice(0, WEB_SEARCH_MAX_QUERIES);
  if (queries.length === 0) {
    throw new Error("web_search requires a non-empty query");
  }
  const settled = await Promise.allSettled(queries.map((q) => webSearch(q, kind)));
  if (settled.every((r) => r.status === "rejected")) {
    throw new Error(settled.map((r, i) => `${queries[i]}: ${errMessage((r as PromiseRejectedResult).reason)}`).join("; "));
  }
  const seen = new Set<string>(); // later queries drop URLs an earlier query already returned
  const parts = settled.map((r, i) => {
    if (r.status === "fulfilled") {
      const results = cleanHits(r.value.results, seen);
      hits.push(results);
      return formatWebSearchResults({ ...r.value, results });
    }
    hits.push([]);
    return `(search failed: ${errMessage(r.reason)})`;
  });
  return queries.length === 1 ? parts[0] : parts.map((p, i) => `### ${queries[i]}\n${p}`).join("\n\n");
}

/**
 * Search, then read the top `read` result pages: hits are taken round-robin across queries and skipped when
 * the host is hostile/fetch-blocked/non-public (same guard as web_fetch), then fetched via webFetchMany.
 * A page-read failure keeps the search results and lists the failure.
 */
export async function webSearchRead(rawQueries: readonly string[], read = 1, kind: CallerKind = "background"): Promise<string> {
  const queries = rawQueries.slice(0, WEB_SEARCH_READ_MAX_QUERIES);
  const perQuery: WebSearchHit[][] = [];
  const searchText = await webSearchMany(queries, kind, perQuery);
  const want = Math.min(Math.max(Math.floor(read) || 1, 1), WEB_SEARCH_READ_MAX_PAGES);
  const candidates: string[] = [];
  for (let rank = 0; rank < WEB_SEARCH_MAX_RESULTS; rank += 1) {
    for (const list of perQuery) {
      if (list[rank] && !candidates.includes(list[rank].url)) {
        candidates.push(list[rank].url);
      }
    }
  }
  const picks: string[] = [];
  for (const url of candidates) {
    if (picks.length >= want) {
      break;
    }
    try {
      await guardFetchUrl(url);
      picks.push(url);
    } catch {
      // hostile, fetch-blocked or non-public: take the next result
    }
  }
  if (picks.length === 0) {
    return `${searchText}\n\n(no readable result: every top hit is blocked or unfetchable)`;
  }
  try {
    const pages = await webFetchMany(picks);
    return `${searchText}\n\n${picks.length === 1 ? `## ${picks[0]}\n${pages}` : pages}`;
  } catch (error) {
    return `${searchText}\n\n(page read failed: ${errMessage(error)})`;
  }
}

/**
 * Fetches a public http(s) URL and returns its text, following redirects up
 * to WEB_FETCH_MAX_REDIRECTS hops, re-checking the target host of every hop.
 */
const fetchCache = new TtlCache<WebFetchResult>(WEB_FETCH_CACHE_MS, WEB_CACHE_MAX_ENTRIES);
const searchCache = new TtlCache<WebSearchResult>(WEB_SEARCH_CACHE_MS, WEB_CACHE_MAX_ENTRIES);

export function clearWebCaches(): void {
  fetchCache.clear();
  searchCache.clear();
  clearPageCache();
}

/** Fetches a public http(s) URL as capped markdown. Cached for WEB_FETCH_CACHE_MS by URL without its #fragment. */
export async function webFetch(rawUrl: string): Promise<WebFetchResult> {
  return fetchCache.get(new URL(rawUrl).toString().replace(/#.*$/, ""), () => loadPage(rawUrl));
}

/** Persisted page cache first (survives restarts), then the fetch chain; only non-empty pages are stored. */
async function loadPage(rawUrl: string): Promise<WebFetchResult> {
  const key = new URL(rawUrl).toString().replace(/#.*$/, "");
  const hit = cachedPage(key);
  if (hit) {
    console.error(`web_fetch: cache=hit chars=${hit.text.length} for ${key}`);
    return { url: hit.url, contentType: hit.contentType, text: hit.text };
  }
  const result = await fetchUncached(rawUrl);
  if (!result.text.trim()) {
    throw new Error(`no content for ${rawUrl}`);
  }
  try {
    putPageCache(key, { url: result.url, contentType: result.contentType, text: result.text }, Date.now());
  } catch {
    // the cache is an optimisation; the page is still returned
  }
  return result;
}

function cachedPage(key: string): PageCacheRow | null {
  try {
    return getPageCache(key, Date.now() - WEB_FETCH_CACHE_MS);
  } catch {
    return null;
  }
}

/** Rejects URLs no fetch provider may be asked to fetch (hostile hosts, non-public addresses). */
export async function guardFetchUrl(rawUrl: string): Promise<void> {
  const target = new URL(rawUrl);
  assertFetchableUrl(target);
  if (isFetchBlockedHost(target.hostname)) {
    throw new Error(`${target.hostname} blocks server fetches — use the search snippet or another result`);
  }
  if (isHostileHost(target.hostname)) {
    throw new Error(`${target.hostname} is blocked/paywalled — use another result`);
  }
  await assertPublicHost(target.hostname);
}

function htmlResult(html: string, url: string): WebFetchResult | null {
  const markdown = htmlToMarkdown(html, url).trim();
  return markdown ? { url, contentType: "text/markdown", text: capText(markdown) } : null;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Firecrawl scrape, then Bright Data Web Unlocker (HTML run through the in-process extractor), then a direct
 * in-process fetch. Each step falls through on any error or empty content; the last step's error is thrown.
 */
async function fetchUncached(rawUrl: string): Promise<WebFetchResult> {
  await guardFetchUrl(rawUrl);
  const started = Date.now();
  const deadline = started + WEB_FETCH_DEADLINE_MS;
  const steps: Array<{ name: string; cap: number; run: (timeoutMs: number) => Promise<WebFetchResult | null> }> = [
    {
      name: "firecrawl",
      cap: WEB_FETCH_PROVIDER_MS,
      run: async (timeoutMs) => {
        const page = await withWebQuota("firecrawl", () => scrapeViaFirecrawl(rawUrl, timeoutMs));
        return page ? { url: rawUrl, contentType: "text/markdown", text: capText(page.title ? `# ${page.title}\n\n${page.markdown}` : page.markdown) } : null;
      },
    },
    {
      name: "brightdata",
      cap: WEB_FETCH_DEADLINE_MS,
      run: async (timeoutMs) => htmlResult(await withWebQuota("brightdata", () => fetchHtmlViaBrightData(rawUrl, timeoutMs)), rawUrl),
    },
    { name: "in-process", cap: WEB_FETCH_TIMEOUT_MS, run: (timeoutMs) => fetchInProcess(rawUrl, timeoutMs) },
  ];
  let lastError: unknown = new Error(`no content for ${rawUrl}`);
  for (const step of steps) {
    const remaining = deadline - Date.now();
    if (remaining < 1_000) {
      throw new Error(`fetch timed out for ${rawUrl} — try another result instead of retrying this URL`);
    }
    let reason: string;
    try {
      const result = await step.run(Math.min(remaining, step.cap));
      if (result) {
        console.error(`web_fetch: backend=${step.name} ms=${Date.now() - started} chars=${result.text.length}`);
        return result;
      }
      reason = "empty content";
      lastError = new Error(`${step.name} returned no content`);
    } catch (error) {
      if (isTimeout(error)) {
        throw new Error(`fetch timed out for ${rawUrl} — try another result instead of retrying this URL`);
      }
      reason = errMessage(error);
      lastError = error;
    }
    console.error(`web_fetch: ${step.name} ${reason} for ${rawUrl}; trying next`);
  }
  throw lastError;
}

/**
 * Fetches up to WEB_FETCH_MAX_URLS pages in parallel; the shared char budget is split per page.
 * Returns the successful pages plus a brief failure list. Throws only when every URL failed.
 */
export async function webFetchMany(rawUrls: readonly string[]): Promise<string> {
  const urls = [...new Set(rawUrls)].slice(0, WEB_FETCH_MAX_URLS);
  if (urls.length === 0) {
    throw new Error("web_fetch requires at least one url");
  }
  const settled = await Promise.allSettled(urls.map((u) => webFetch(u)));
  const perPage = Math.floor(WEB_FETCH_MAX_CHARS / urls.length);
  const pages: string[] = [];
  const failures: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      pages.push(urls.length === 1 ? capText(r.value.text, perPage) : `## ${r.value.url}\n${capText(r.value.text, perPage)}`);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failures.push(`- ${urls[i]}: ${msg}`);
    }
  });
  if (pages.length === 0) {
    throw new Error(`${failures.map((f) => f.slice(2)).join("; ")}`);
  }
  return failures.length ? `${pages.join("\n\n")}\n\nFailed (try another result, don't retry):\n${failures.join("\n")}` : pages.join("\n\n");
}

async function fetchInProcess(rawUrl: string, timeoutMs = WEB_FETCH_TIMEOUT_MS): Promise<WebFetchResult> {
  let current = new URL(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop += 1) {
      const response = await fetchOnce(current, controller.signal);
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        if (hop === WEB_FETCH_MAX_REDIRECTS) {
          throw new Error(`too many redirects fetching ${rawUrl}`);
        }
        current = new URL(response.headers.get("location") as string, current);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (/application\/pdf/i.test(contentType)) {
        throw new Error(`${rawUrl} is a PDF and PDF text extraction is not supported — use the search snippet or another result`);
      }
      const buffer = await response.arrayBuffer();
      const clipped = buffer.byteLength > WEB_FETCH_MAX_BYTES ? buffer.slice(0, WEB_FETCH_MAX_BYTES) : buffer;
      const raw = Buffer.from(clipped).toString("utf8");
      const text = capText(contentType.includes("html") ? htmlToMarkdown(raw, current.toString()) : raw);
      return { url: current.toString(), contentType, text };
    }
    throw new Error(`too many redirects fetching ${rawUrl}`);
  } finally {
    clearTimeout(timer);
  }
}
