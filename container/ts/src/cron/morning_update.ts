import { displayTitle, type Headline } from "./news.js";
import { TELEGRAM_VISIBLE_LIMIT } from "./maint_report.js";

const SGT = "Asia/Singapore";
const TITLE_PREFIX = "Morning Update ";
const SECTION_EMOJI = ["📅", "📋", "🌍", "💻", "🇸🇬", "🌤️"] as const;

type SectionKey = "calendar" | "tasks" | "world" | "tech" | "singapore" | "weather";

const EMOJI_TO_KEY: Record<(typeof SECTION_EMOJI)[number], SectionKey> = {
  "📅": "calendar",
  "📋": "tasks",
  "🌍": "world",
  "💻": "tech",
  "🇸🇬": "singapore",
  "🌤️": "weather",
};


export type MorningUpdateEntity = {
  type: "text_link";
  offset: number;
  length: number;
  url: string;
};

export type MorningUpdateMessage = {
  text: string;
  entities?: MorningUpdateEntity[];
};

const MARKDOWN_BULLET = /^- \[(.+?)\]\((https?:\/\/[^)]+)\)\s*$/;
const PAREN_BULLET = /^- (.+?) \((https?:\/\/[^)]+)\)\s*$/;
const URL_RE = /https?:\/\/[^\s)]+/g;

function clipText(text: string, limit = TELEGRAM_VISIBLE_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}

function clipEntities(
  entities: MorningUpdateEntity[] | undefined,
  textLength: number,
): MorningUpdateEntity[] | undefined {
  if (!entities?.length) {
    return undefined;
  }
  const clipped = entities.filter(
    (entity) => entity.offset >= 0 && entity.offset + entity.length <= textLength,
  );
  return clipped.length ? clipped : undefined;
}

function clipMessage(message: MorningUpdateMessage): MorningUpdateMessage {
  const text = clipText(message.text);
  const entities = clipEntities(message.entities, text.length);
  if (entities) {
    return { text, entities };
  }
  return { text };
}

export function formatMorningUpdateTitle(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SGT,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "";
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  let month = parts.find((part) => part.type === "month")?.value ?? "";
  if (month.endsWith(".")) {
    month = month.slice(0, -1);
  }
  if (month === "Sept") {
    month = "Sep";
  }
  return `${TITLE_PREFIX}${weekday} ${day} ${month} ${hour}:${minute}`;
}

function stripPreamble(text: string): string {
  const match = text.match(/^Daily (?:update for|Update) /m);
  if (!match || match.index === undefined) {
    return text.trim();
  }
  return text.slice(match.index).trim();
}

function sectionHeader(line: string): SectionKey | null {
  const emoji = SECTION_EMOJI.find((value) => line.startsWith(value));
  return emoji ? EMOJI_TO_KEY[emoji] : null;
}

function parseSections(text: string): Map<SectionKey, string> {
  const lines = text.split(/\r?\n/);
  const sections = new Map<SectionKey, string[]>();
  let current: SectionKey | null = null;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const key = sectionHeader(line);
    if (key) {
      current = key;
      sections.set(key, [line]);
      continue;
    }
    if (current) {
      sections.get(current)?.push(line);
    }
  }

  const joined = new Map<SectionKey, string>();
  for (const [key, body] of sections) {
    joined.set(key, body.join("\n").trimEnd());
  }
  return joined;
}

function sectionHasContent(section: string | undefined): boolean {
  if (!section) {
    return false;
  }
  return section
    .split(/\r?\n/)
    .slice(1)
    .some((line) => line.trim().length > 0);
}

function extractUrls(line: string): string[] {
  return [...line.matchAll(URL_RE)].map((match) => match[0]);
}

function titleTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

/** Map a model-written bullet back to a checked item: by URL first, then by headline word overlap. */
function matchChecked(headline: string, urls: string[], items: readonly Headline[]): Headline | null {
  for (const url of urls) {
    const hit = items.find((item) => item.url === url);
    if (hit) {
      return hit;
    }
  }
  const words = titleTokens(headline);
  if (!words.size) {
    return null;
  }
  let best: Headline | null = null;
  let bestScore = 0;
  for (const item of items) {
    const itemWords = titleTokens(item.title);
    let shared = 0;
    for (const word of words) {
      if (itemWords.has(word)) {
        shared += 1;
      }
    }
    const score = shared / words.size;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

function parseNewsBullet(line: string): { headline: string; urls: string[] } | null {
  const markdown = MARKDOWN_BULLET.exec(line);
  if (markdown) {
    return { headline: markdown[1], urls: [markdown[2]] };
  }
  const parenthetical = PAREN_BULLET.exec(line);
  if (parenthetical) {
    return { headline: parenthetical[1].trim(), urls: extractUrls(line) };
  }
  return null;
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line;
}

function buildNewsSection(section: string, checked?: readonly Headline[]): MorningUpdateMessage {
  const lines = section.split(/\r?\n/);
  let text = lines[0] ?? "";
  const entities: MorningUpdateEntity[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const parsed = parseNewsBullet(line.trim());
    let bullet: { headline: string; url: string } | null = null;
    if (parsed) {
      if (checked) {
        // Only checked article URLs are rendered; a bullet that maps to none is dropped.
        const item = matchChecked(parsed.headline, parsed.urls, checked);
        if (!item) {
          continue;
        }
        bullet = { headline: parsed.headline, url: item.url };
      } else if (parsed.urls[0]) {
        bullet = { headline: parsed.headline, url: parsed.urls[0] };
      }
    }
    if (bullet) {
      const prefix = "- ";
      const lineStart = text.length + (text ? 1 : 0);
      const headlineStart = lineStart + prefix.length;
      entities.push({
        type: "text_link",
        offset: headlineStart,
        length: bullet.headline.length,
        url: bullet.url,
      });
      text = appendLine(text, `${prefix}${bullet.headline}`);
      continue;
    }
    text = appendLine(text, line);
  }

  if (entities.length) {
    return { text, entities };
  }
  return { text };
}

function buildPlainSection(section: string): MorningUpdateMessage {
  return { text: section };
}

export function splitMorningUpdate(
  raw: string,
  options: { now?: Date; news?: Record<string, readonly Headline[]> } = {},
): MorningUpdateMessage[] {
  const now = options.now ?? new Date();
  const stripped = stripPreamble(raw);
  const sections = parseSections(stripped);
  const messages: MorningUpdateMessage[] = [];

  const calendar = sections.get("calendar") ?? "";
  const title = formatMorningUpdateTitle(now);
  messages.push(
    clipMessage({
      text: calendar ? `${title}\n\n${calendar}` : title,
    }),
  );

  const tasks = sections.get("tasks");
  if (sectionHasContent(tasks)) {
    messages.push(clipMessage(buildPlainSection(tasks!)));
  }

  for (const key of ["world", "tech", "singapore"] as const) {
    const section = sections.get(key);
    if (sectionHasContent(section)) {
      messages.push(clipMessage(buildNewsSection(section!, options.news?.[key])));
    }
  }

  return messages;
}

const NEWS_HEADINGS: readonly [string, string][] = [
  ["world", "🌍 World News (last 24h):"],
  ["tech", "💻 Tech News (last 24h):"],
  ["singapore", "🇸🇬 Singapore News (last 24h):"],
];

/** The Morning Update message built in code from prefetched data (layout of morning-update-format.md); empty sections are skipped. */
export function renderMorningUpdate(
  now: Date,
  calendarLines: readonly string[],
  taskLines: readonly string[],
  news: Record<string, readonly Headline[]>,
): string {
  const blocks = [formatMorningUpdateTitle(now)];
  if (calendarLines.length > 0) {
    blocks.push(["📅 Google Calendar:", ...calendarLines].join("\n"));
  }
  if (taskLines.length > 0) {
    blocks.push(["📋 Google Tasks:", ...taskLines].join("\n"));
  }
  for (const [key, heading] of NEWS_HEADINGS) {
    const items = news[key] ?? [];
    if (items.length > 0) {
      blocks.push([heading, ...items.map((item) => `- [${displayTitle(item.title).replace(/[[\]]/g, "")}](${item.url})`)].join("\n"));
    }
  }
  return blocks.join("\n\n");
}
