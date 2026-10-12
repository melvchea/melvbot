import { removeUntilStable } from "../../html_text.js";
import type { SearchHit } from "../search_router.js";

export const KAGI_ENV_KEY = "KAGI_SESSION_LINK";
const KAGI_BASE = "https://kagi.com";
const KAGI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";
const KAGI_TIMEOUT_MS = 8_000;
const KAGI_MAX_BODY = 2 << 20;
const KAGI_MAX_RESULTS = 20;
export const KAGI_BREAKER_THRESHOLD = 3;
export const KAGI_BREAKER_COOLDOWN_MS = 15 * 60_000;

/** Token from a session link (https://kagi.com/search?token=...); "" when absent or malformed. */
export function kagiToken(link = process.env[KAGI_ENV_KEY]): string {
  try {
    return new URL((link ?? "").trim()).searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

/** Skips Kagi for a cooldown after consecutive failed or empty searches, so a broken scrape falls through to Brave fast. */
export class KagiBreaker {
  private fails = 0;
  private openUntil = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold = KAGI_BREAKER_THRESHOLD, cooldownMs = KAGI_BREAKER_COOLDOWN_MS) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  /** Closed, or open but past the cooldown (the next search is the probe). */
  allowed(now = Date.now()): boolean {
    return this.fails < this.threshold || now >= this.openUntil;
  }

  record(ok: boolean, now = Date.now()): void {
    if (ok) {
      this.fails = 0;
      return;
    }
    this.fails += 1;
    if (this.fails >= this.threshold) {
      this.openUntil = now + this.cooldownMs;
    }
  }
}

export const kagiBreaker = new KagiBreaker();

/** "not configured" without KAGI_SESSION_LINK, "breaker open" while skipped, else "ready". */
export function kagiStatus(now = Date.now()): string {
  if (!kagiToken()) {
    return "not configured";
  }
  return kagiBreaker.allowed(now) ? "ready" : "breaker open";
}

/** The kagi_session cookie value; re-exchanged from the session link when Kagi stops accepting it. */
let sessionCookie = "";

class KagiSessionExpired extends Error {}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function mask(text: string, token: string): string {
  let out = text;
  for (const secret of [token, sessionCookie]) {
    if (secret) {
      out = out.split(secret).join("***");
    }
  }
  return out;
}

async function kagiGet(path: string, token: string, cookie: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": KAGI_USER_AGENT, accept, "accept-language": "en-US,en;q=0.9" };
  if (cookie) {
    headers.cookie = `kagi_session=${cookie}`;
  }
  try {
    return await fetch(`${KAGI_BASE}${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(KAGI_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(mask(errText(error), token));
  }
}

function sessionFrom(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const m = /^kagi_session=([^;]+)/.exec(line);
    if (m) {
      return m[1];
    }
  }
  return "";
}

const KAGI_LOGIN_PATHS = ["/welcome", "/login", "/signin", "/sign_in", "/signup", "/auth"];

function isLoginPath(location: string): boolean {
  const l = location.toLowerCase();
  return KAGI_LOGIN_PATHS.some((p) => l.startsWith(p) || l.includes(`kagi.com${p}`));
}

function looksLikeLogin(body: string): boolean {
  const b = body.toLowerCase();
  return ['type="password"', "sign in", "log in", "/signin", "/login", "create an account"].some((m) => b.includes(m));
}

async function exchange(token: string): Promise<void> {
  const res = await kagiGet(`/search?token=${encodeURIComponent(token)}&q=ping`, token, "", "text/html,application/xhtml+xml");
  await res.arrayBuffer();
  const cookie = sessionFrom(res);
  if (!cookie) {
    throw new KagiSessionExpired("kagi session expired");
  }
  sessionCookie = cookie;
}

async function searchPage(query: string, token: string, limit: number): Promise<SearchHit[]> {
  if (!sessionCookie) {
    await exchange(token);
  }
  const res = await kagiGet(`/html/search?q=${encodeURIComponent(query)}`, token, sessionCookie, "text/html,application/xhtml+xml");
  if (res.status >= 300 && res.status < 400) {
    if (isLoginPath(res.headers.get("location") ?? "")) {
      throw new KagiSessionExpired("kagi session expired");
    }
    throw new Error(`kagi redirected (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`kagi HTTP ${res.status}`);
  }
  sessionCookie = sessionFrom(res) || sessionCookie;
  const body = (await res.text()).slice(0, KAGI_MAX_BODY);
  const hits = parseKagiResults(body, limit);
  if (hits.length === 0 && !body.includes("__sri") && looksLikeLogin(body)) {
    throw new KagiSessionExpired("kagi session expired");
  }
  return hits;
}

/**
 * Kagi web search via the session-cookie HTML results page (no API). Retries once after re-exchanging an
 * expired session. Every outcome, including an empty page, feeds the breaker. Errors never contain the token.
 */
export async function searchWebViaKagi(query: string, maxResults: number): Promise<SearchHit[]> {
  const token = kagiToken();
  if (!token) {
    throw new Error(`${KAGI_ENV_KEY} is not set`);
  }
  const limit = Math.min(Math.max(maxResults, 1), KAGI_MAX_RESULTS);
  let hits: SearchHit[];
  try {
    try {
      hits = await searchPage(query, token, limit);
    } catch (error) {
      if (!(error instanceof KagiSessionExpired)) {
        throw error;
      }
      sessionCookie = "";
      hits = await searchPage(query, token, limit);
    }
  } catch (error) {
    kagiBreaker.record(false);
    throw new Error(mask(errText(error), token));
  }
  kagiBreaker.record(hits.length > 0);
  return hits;
}

// Minimal HTML tree for Kagi's results markup (no HTML parser dependency).

type Node = { tag: string; attrs: Map<string, string>; kids: (Node | string)[] };

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BLOCK_TAGS = new Set(["div", "p", "li", "ul", "ol", "br", "tr", "td", "h1", "h2", "h3", "section"]);
const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES.get(entity.toLowerCase()) ?? whole;
  });
}

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(/([^\s=/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const key = m[1].toLowerCase();
    if (!attrs.has(key)) {
      attrs.set(key, decode(m[2] ?? m[3] ?? m[4] ?? ""));
    }
  }
  return attrs;
}

function parseTree(html: string): Node {
  const root: Node = { tag: "#root", attrs: new Map(), kids: [] };
  const stack = [root];
  const src = removeUntilStable(
    removeUntilStable(html, /<!--[\s\S]*?-->/g),
    /<(script|style|svg)\b[\s\S]*?<\/\1\s*>/gi,
  );
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) {
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const node: Node = { tag: m[2].toLowerCase(), attrs: parseAttrs(m[3]), kids: [] };
      stack[stack.length - 1].kids.push(node);
      if (!VOID_TAGS.has(node.tag) && !m[3].trimEnd().endsWith("/")) {
        stack.push(node);
      }
    } else {
      stack[stack.length - 1].kids.push(decode(m[4]));
    }
  }
  return root;
}

const squash = (s: string): string => s.trim().replace(/\s+/g, " ");
const attr = (n: Node, key: string): string => n.attrs.get(key) ?? "";
const hasClass = (n: Node, cls: string): boolean => attr(n, "class").split(/\s+/).includes(cls);

/** Collapsed text of n, skipping script/style/svg and any subtree where skip returns true. */
function textOf(n: Node | string, skip?: (x: Node) => boolean): string {
  const parts: string[] = [];
  const rec = (x: Node | string): void => {
    if (typeof x === "string") {
      parts.push(x);
      return;
    }
    if (x.tag === "script" || x.tag === "style" || x.tag === "svg" || skip?.(x)) {
      return;
    }
    const block = BLOCK_TAGS.has(x.tag);
    if (block) parts.push(" ");
    for (const k of x.kids) rec(k);
    if (block) parts.push(" ");
  };
  rec(n);
  return squash(parts.join(""));
}

function findClass(n: Node, cls: string): Node | undefined {
  if (hasClass(n, cls)) {
    return n;
  }
  for (const k of n.kids) {
    if (typeof k !== "string") {
      const found = findClass(k, cls);
      if (found) return found;
    }
  }
  return undefined;
}

/** "Oct 3, 2021" or "3 Oct 2021" becomes 2021-10-03; anything else is returned squashed as is. */
function normDate(raw: string): string {
  const s = squash(raw);
  const month = (name: string): number => MONTHS.indexOf(name.toLowerCase()) + 1;
  const iso = (y: string, m: number, d: string): string => `${y}-${String(m).padStart(2, "0")}-${d.padStart(2, "0")}`;
  const mdy = /^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/.exec(s);
  if (mdy && month(mdy[1]) > 0) return iso(mdy[3], month(mdy[1]), mdy[2]);
  const dmy = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/.exec(s);
  if (dmy && month(dmy[2]) > 0) return iso(dmy[3], month(dmy[2]), dmy[1]);
  return s;
}

function isKagiHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "kagi.com" || h.endsWith(".kagi.com");
}

/** Absolute http(s) URL with the fragment dropped; "" for Kagi-internal or unusable links. */
function resolveHit(href: string, base: URL): string {
  try {
    const u = new URL(href.trim(), base);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || isKagiHost(u.hostname)) {
      return "";
    }
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

/** Results from a Kagi /html/search page: title link, description, optional date; duplicate URLs dropped. */
export function parseKagiResults(html: string, limit: number): SearchHit[] {
  const base = new URL(`${KAGI_BASE}/html/search`);
  const seen = new Set<string>();
  const pending: { title: string; url: string; keep: boolean; snippet: string; date: string }[] = [];
  let cur = -1;
  const walk = (n: Node): void => {
    if (n.tag === "a" && hasClass(n, "__sri_title_link")) {
      const url = resolveHit(attr(n, "href"), base);
      const keep = url !== "" && !seen.has(url);
      if (url) seen.add(url);
      pending.push({ title: textOf(n) || squash(attr(n, "title")), url, keep, snippet: "", date: "" });
      cur = pending.length - 1;
    } else if (cur >= 0 && hasClass(n, "__sri-desc") && pending[cur].snippet === "") {
      const skip = (x: Node): boolean => hasClass(x, "summarize-link") || hasClass(x, "__sri-time") || x.tag === "button";
      pending[cur].snippet = textOf(n, skip);
      const time = findClass(n, "__sri-time");
      if (time && !pending[cur].date) pending[cur].date = normDate(textOf(time));
      return;
    } else if (cur >= 0 && hasClass(n, "__sri-time") && !pending[cur].date) {
      pending[cur].date = normDate(textOf(n));
    }
    for (const k of n.kids) {
      if (typeof k !== "string") walk(k);
    }
  };
  walk(parseTree(html));
  return pending
    .filter((p) => p.keep && p.url !== "" && p.title !== "")
    .slice(0, limit)
    .map((p) => (p.date ? { title: p.title, url: p.url, snippet: p.snippet, date: p.date } : { title: p.title, url: p.url, snippet: p.snippet }));
}
