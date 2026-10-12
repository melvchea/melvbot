/** Fetched-page shaping and small TTL caches for web_search / web_fetch. */

import { stripTags } from "../html_text.js";

/** About 8k tokens of page text; a bigger page is cut at a paragraph boundary. */
export const WEB_FETCH_MAX_CHARS = 32_000;
const MAIN_MIN_CHARS = 500;
/** Link URLs cost tokens; keep them only for the first few external links, text only otherwise. */
const MAX_KEPT_LINKS = 25;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function textLength(html: string): number {
  return stripTags(html).replace(/\s+/g, " ").trim().length;
}

/** Prefers the largest <article>, then <main>, when it holds a real share of the page's text. */
function mainContent(html: string): string {
  const total = textLength(html);
  const pick = (tag: string): string | null => {
    let best: string | null = null;
    for (const match of html.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"))) {
      if (best === null || match[0].length > best.length) {
        best = match[0];
      }
    }
    return best;
  };
  for (const tag of ["article", "main"]) {
    const found = pick(tag);
    if (found !== null) {
      const length = textLength(found);
      if (length >= MAIN_MIN_CHARS && length >= total * 0.25) {
        return found;
      }
    }
  }
  return html;
}

function resolveHref(href: string, baseUrl?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(trimmed)) {
    return null;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

/** HTML to compact markdown: main content only, headings/lists/links/code kept, chrome dropped. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  let keptLinks = 0;
  const baseHost = baseUrl ? new URL(baseUrl).hostname : null;
  let out = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|form|button|select)\b[\s\S]*?<\/\1>/gi, " ");
  out = mainContent(out);
  out = out
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => `\n\n\`\`\`\n${stripTags(body)}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, body: string) => `\n\n${"#".repeat(Number(level))} ${body}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, dq: string | undefined, sq: string | undefined, body: string) => {
      const label = stripTags(body).replace(/\s+/g, " ").trim();
      const href = resolveHref(decodeEntities(dq ?? sq ?? ""), baseUrl);
      if (!label || !href || label === href || keptLinks >= MAX_KEPT_LINKS || new URL(href).hostname === baseHost) {
        return label;
      }
      keptLinks += 1;
      return `[${label}](${href})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|ul|ol|table|tr|blockquote|figure|figcaption|dd|dt)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(out)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Caps text at `maxChars`, cutting at a paragraph or line boundary and saying how much was dropped. */
export function capText(text: string, maxChars = WEB_FETCH_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  const window = text.slice(0, maxChars);
  const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
  const cut = boundary > maxChars * 0.6 ? boundary : maxChars;
  return `${text.slice(0, cut).trimEnd()}\n\n[truncated: ${text.length - cut} more chars omitted]`;
}

/** Small in-memory TTL cache that also dedupes concurrent calls and drops rejected promises. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; storedAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /** True when a fresh entry (resolved or in flight) exists. */
  has(key: string): boolean {
    const hit = this.entries.get(key);
    return Boolean(hit && Date.now() - hit.storedAt < this.ttlMs);
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.storedAt < this.ttlMs) {
      return hit.value;
    }
    const value = load();
    this.entries.set(key, { value, storedAt: Date.now() });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) {
        this.entries.delete(key);
      }
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
