import { listSpend, type SpendSummaryJson } from "./spend_list.js";
import type { SpendCard } from "./spend_cycle.js";
import { cardLabel, displayNames, type DisplayNames } from "../profile.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const SHOW_RE = /^(?:show|list|recall)\s+(?:my\s+)?(?<subject>.+)$/i;
const TABLE_HEADER = "| Date | Merchant | Amount |\n|:-----|:---------|-------:|";

const ASK_SUBJECTS = new Set(["spend", "card spend"]);

const CARD1: SpendCard = { owner: "owner1", card: "card1" };
const CARD2: SpendCard = { owner: "owner2", card: "card2" };

type AliasTable = { map: ReadonlyMap<string, SpendCard>; phrases: string[]; alt: string };
let aliasCache: { names: DisplayNames; table: AliasTable } | undefined;

/** Card aliases, lowercase, without a trailing "spend"/"spending" (resolveSpendCardAlias strips that).
 * Ids, profile display names and the bank words uob/remb; rebuilt only when the profile changes. */
function aliasTable(): AliasTable {
  const names = displayNames();
  if (aliasCache?.names !== names) {
    const map = new Map<string, SpendCard>([
      ["owner1", CARD1],
      ["card1", CARD1],
      [names.owner1.toLowerCase(), CARD1],
      [names.card1.toLowerCase(), CARD1],
      [cardLabel("owner1", "card1").toLowerCase(), CARD1],
      ["uob", CARD1],
      ["owner2", CARD2],
      ["card2", CARD2],
      [names.owner2.toLowerCase(), CARD2],
      [names.card2.toLowerCase(), CARD2],
      [cardLabel("owner2", "card2").toLowerCase(), CARD2],
      ["remb", CARD2],
    ]);
    const phrases = [...map.keys()].sort((a, b) => b.split(" ").length - a.split(" ").length);
    aliasCache = { names, table: { map, phrases, alt: phrases.join("|") } };
  }
  return aliasCache.table;
}

export function spendCardAsk(): string {
  const names = displayNames();
  return `Name ${names.card2} or ${names.card1}.`;
}

type IsoDate = { y: number; m: number; d: number };

function subjectOf(line: string): string | null {
  const subject = SHOW_RE.exec(line.trim())?.groups?.subject;
  if (!subject) {
    return null;
  }
  return subject.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Resolves a card name ("owner2 card2", "owner1 card1 spend", ...) or null. */
export function resolveSpendCardAlias(raw: string): SpendCard | null {
  const subject = raw.trim().replace(/\s+/g, " ").toLowerCase().replace(/(?:^|\s)spend(?:ing)?$/, "");
  return aliasTable().map.get(subject.trim()) ?? null;
}

const FOR_MONTH_RE = /\s+(?:for|in)\s+(?<month>[a-z]+)$/;

/** Card to show, plus `cycleDate` (mid-month of "for <month>") when a month was named. */
export function parseSpendShowDirective(line: string, now: Date = new Date()): (SpendCard & { cycleDate?: string }) | "ask" | null {
  const subject = subjectOf(line);
  if (subject && ASK_SUBJECTS.has(subject)) {
    return "ask";
  }
  if (!subject) {
    return null;
  }
  const month = FOR_MONTH_RE.exec(subject);
  const monthNo = month?.groups ? monthIndex(month.groups.month) : 0;
  if (month && monthNo > 0) {
    const card = resolveSpendCardAlias(subject.slice(0, month.index));
    const cycleDate = dayMonthToIso(15, monthNo, sgDateString(now));
    return card && cycleDate ? { ...card, cycleDate } : null;
  }
  return resolveSpendCardAlias(subject);
}

function parseIso(value: string): IsoDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function dayLabel(iso: string): string {
  const parsed = parseIso(iso);
  if (!parsed || parsed.m < 1 || parsed.m > MONTHS.length) {
    return iso;
  }
  return `${parsed.d} ${MONTHS[parsed.m - 1]}`;
}

function rangeLabel(start: string, end: string): string {
  const opening = parseIso(start);
  const closing = parseIso(end);
  if (!opening || !closing || opening.m < 1 || closing.m < 1 || opening.m > MONTHS.length || closing.m > MONTHS.length) {
    return `${start}–${end}`;
  }
  const startText =
    opening.y === closing.y
      ? `${opening.d} ${MONTHS[opening.m - 1]}`
      : `${opening.d} ${MONTHS[opening.m - 1]} ${opening.y}`;
  return `${startText}–${closing.d} ${MONTHS[closing.m - 1]} ${closing.y}`;
}

function cell(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function amountCell(amount: string): string {
  const trimmed = amount.trim().replace(/^\\/, "");
  return trimmed.startsWith("$") ? trimmed : `$${trimmed}`;
}

export function formatSpendShow(summary: SpendSummaryJson): string {
  const label = cardLabel(summary.owner as "owner1" | "owner2", summary.card as "card1" | "card2");
  const title = `**${label} — ${rangeLabel(summary.cycle_start, summary.cycle_end)}**`;
  const lines = summary.entries.map(
    (entry) =>
      `| ${cell(dayLabel(entry.spent_on))} | ${cell(entry.merchant)} | ${cell(amountCell(entry.amount))} |`,
  );
  const table = lines.length > 0 ? [TABLE_HEADER, ...lines].join("\n") : "";
  return [title, table, summary.telegram_totals].filter((part) => part.length > 0).join("\n\n");
}

function isoToday(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export async function spendShowReply(card: SpendCard & { cycleDate?: string }): Promise<string> {
  return formatSpendShow(
    await listSpend({
      owner: card.owner,
      card: card.card,
      cycleDate: card.cycleDate ?? isoToday(),
    }),
  );
}

export type SpendAddEntry = { spentOn: string; merchant: string; amount: string };
export type SpendAddDirective = { card: SpendCard | null; entries: SpendAddEntry[] };

const ADD_VERB_RE = /^(?:store|log|add|update|record|spent)\s+(?<rest>.+)$/i;
const BATCH_HEADER_RE = /^(?:store|log|add|record)\s+these\b(?<rest>.*)$/i;
const PREAMBLE_RE = /^here(?:'|’)?s\s+(?:a\s+)?summary\b/i;
const PREP_RE = /^(?:under|to|on|for)\s+/i;
const MONTH_WORDS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const AMOUNT_BODY = String.raw`(?:S?\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*\.\d{1,2})`;
const AMOUNT_ONLY_RE = new RegExp(`^(?:S?\\$\\s?\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d{1,2})?)$`, "i");
const AMOUNT_LIST_RE = new RegExp(`(?<list>${AMOUNT_BODY}(?:\\s*(?:,|and|&)\\s*${AMOUNT_BODY})*)\\s*$`, "i");

function monthIndex(word: string): number {
  const key = word.toLowerCase().replace(/\.$/, "");
  const short = key === "sept" ? "sep" : key.slice(0, 3);
  const full = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/.test(key);
  return full ? MONTH_WORDS.indexOf(short) + 1 : 0;
}

/** Today's date in Asia/Singapore as YYYY-MM-DD. */
export function sgDateString(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function shiftDays(iso: string, days: number): string {
  const parsed = parseIso(iso) as IsoDate;
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d + days)).toISOString().slice(0, 10);
}

function validIso(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Day + month without a year: current year, or the previous one when that lands over a week ahead. */
function dayMonthToIso(day: number, month: number, today: string): string | null {
  const year = (parseIso(today) as IsoDate).y;
  const current = validIso(year, month, day);
  if (!current) {
    return null;
  }
  return current > shiftDays(today, 7) ? validIso(year - 1, month, day) : current;
}

/** Date tokens at the start of `tokens` (e.g. "3 Oct", "Oct 3", "today", ISO); returns the date and tokens used. */
export function dateAt(tokens: string[], i: number, today: string): { iso: string | null; used: number } | null {
  const word = tokens[i].toLowerCase();
  if (word === "today") {
    return { iso: today, used: 1 };
  }
  if (word === "yesterday") {
    return { iso: shiftDays(today, -1), used: 1 };
  }
  const iso = parseIso(tokens[i]);
  if (iso) {
    return { iso: validIso(iso.y, iso.m, iso.d), used: 1 };
  }
  const next = tokens[i + 1];
  // Explicit year after "3 Oct" / "Oct 3" is part of the date, never the amount ("17 Oct 2026").
  const year = /^(?:19|20)\d{2}$/.test(tokens[i + 2] ?? "") ? Number(tokens[i + 2]) : null;
  const dayMonth = (day: number, month: number) =>
    year === null ? { iso: dayMonthToIso(day, month, today), used: 2 } : { iso: validIso(year, month, day), used: 3 };
  if (next && /^\d{1,2}(?:st|nd|rd|th)?$/.test(word) && monthIndex(next) > 0) {
    return dayMonth(Number.parseInt(word, 10), monthIndex(next));
  }
  if (next && monthIndex(word) > 0 && /^\d{1,2}(?:st|nd|rd|th)?,?$/.test(next)) {
    return dayMonth(Number.parseInt(next, 10), monthIndex(word));
  }
  return null;
}

function cleanAmount(raw: string): string {
  return raw.replace(/^S?\$/i, "").replace(/[\s,]/g, "");
}

function cleanMerchant(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().replace(/^[-•*]\s*/, "").replace(/\s*[:,]$/, "").replace(/^\((.*)\)$/, "$1").trim();
}

/** "Shopee $32.19 Vending $2" -> one segment per trailing amount; unchanged unless every chunk is "merchant amount". */
function splitAfterAmounts(segment: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const token of segment) {
    current.push(token);
    if (AMOUNT_ONLY_RE.test(token)) {
      chunks.push(current);
      current = [];
    }
  }
  const valid = chunks.length > 1 && current.length === 0 && chunks.every((chunk) => chunk.length > 1 && !AMOUNT_ONLY_RE.test(chunk[0]));
  return valid ? chunks : [segment];
}

/** Single-line form: verb, optional card, merchant, amount and optional date in any order after the verb. */
function parseSingleAdd(line: string, today: string, allowNoCard = false): SpendAddDirective | null {
  const rest0 = ADD_VERB_RE.exec(line.trim())?.groups?.rest;
  if (!rest0) {
    return null;
  }
  let rest = rest0.replace(PREP_RE, "").trim();
  let card: SpendCard | null = null;
  const lower = rest.toLowerCase();
  for (const phrase of aliasTable().phrases) {
    if (lower === phrase || lower.startsWith(`${phrase} `)) {
      card = aliasTable().map.get(phrase) ?? null;
      rest = rest.slice(phrase.length).trim().replace(/^spend(?:ing)?\b\s*/i, "");
      break;
    }
  }
  if (!card) {
    const tail = new RegExp(`\\s+(?:under|to|on|for|in)\\s+(${aliasTable().phrases.join("|")})(?:\\s+spend(?:ing)?)?$`, "i").exec(rest);
    if (tail) {
      card = aliasTable().map.get(tail[1].toLowerCase()) ?? null;
      rest = rest.slice(0, tail.index).trim();
    }
  }
  const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
  let spentOn: string | null = null;
  for (let i = 0; i < tokens.length && spentOn === null; i += 1) {
    const found = dateAt(tokens, i, today);
    if (found) {
      if (!found.iso) {
        return null;
      }
      spentOn = found.iso;
      const start = i > 0 && tokens[i - 1].toLowerCase() === "on" ? i - 1 : i;
      tokens.splice(start, found.used + (i - start));
    }
  }
  // "KFC $11.55 and Shopee $5.73": one entry per segment; any segment without exactly one amount leaves it to Claude.
  const segments = tokens
    .join(" ")
    .split(/\s+(?:and|&)\s+|\s*,\s+/i)
    .map((segment) => segment.split(/\s+/).filter((token) => token.length > 0))
    .flatMap(splitAfterAmounts);
  const entries: SpendAddEntry[] = [];
  for (const segment of segments) {
    const amountIdxs = segment.flatMap((token, i) => (AMOUNT_ONLY_RE.test(token) ? [i] : []));
    if (amountIdxs.length !== 1) {
      if (segments.length > 1) {
        return null;
      }
      if (amountIdxs.length === 0) {
        return null;
      }
    }
    const amountIdx = amountIdxs[amountIdxs.length - 1];
    const amount = cleanAmount(segment[amountIdx]);
    segment.splice(amountIdx, 1);
    const merchant = cleanMerchant(segment.join(" ").replace(/^(?:at|on|for|in)\s+/i, ""));
    if (!merchant || new RegExp(AMOUNT_BODY, "i").test(merchant)) {
      return null;
    }
    entries.push({ spentOn: spentOn ?? today, merchant, amount });
  }
  if (!card && !allowNoCard && /^(?:add|update)\b/i.test(line)) {
    return null;
  }
  return { card, entries };
}

/** Batch form: "store these [spending] under <card> [spend]" then dated lines (see tests for shapes). */
function parseBatchAdd(lines: string[], today: string): SpendAddDirective | null {
  const header = BATCH_HEADER_RE.exec(lines[0])?.groups?.rest ?? "";
  const cardText = header
    .trim()
    .replace(/^(?:spend(?:ing)?|transactions?|entries|charges)\b\s*/i, "")
    .replace(PREP_RE, "")
    .trim();
  const card = cardText ? resolveSpendCardAlias(cardText) : null;
  if (cardText && !card) {
    return null;
  }
  const entries: SpendAddEntry[] = [];
  let pending: { spentOn: string; merchant: string; used: boolean } | null = null;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/^[-•*]\s*/, "").trim();
    if (PREAMBLE_RE.test(line)) {
      continue;
    }
    const tokens = line.split(/\s+/);
    const date = dateAt(tokens, 0, today);
    let body = line;
    let spentOn: string | null = null;
    if (date) {
      if (!date.iso) {
        return null;
      }
      spentOn = date.iso;
      body = tokens.slice(date.used).join(" ");
    }
    const list = AMOUNT_LIST_RE.exec(body);
    const amounts = list?.groups?.list.match(new RegExp(AMOUNT_BODY, "gi")) ?? [];
    const label = list ? body.slice(0, list.index) : body;
    if (spentOn === null) {
      // Undated line: only a bare amount list under a pending "date (merchant):" header.
      if (!pending || amounts.length === 0 || label.trim() !== "") {
        return null;
      }
      for (const amount of amounts) {
        entries.push({ spentOn: pending.spentOn, merchant: pending.merchant, amount: cleanAmount(amount) });
      }
      pending.used = true;
      continue;
    }
    if (pending && !pending.used) {
      return null;
    }
    const merchant = cleanMerchant(label.replace(/\s*:\s*$/, ""));
    if (!merchant) {
      return null;
    }
    if (amounts.length === 0) {
      pending = { spentOn, merchant, used: false };
      continue;
    }
    pending = null;
    for (const amount of amounts) {
      entries.push({ spentOn, merchant, amount: cleanAmount(amount) });
    }
  }
  if ((pending && !pending.used) || entries.length === 0) {
    return null;
  }
  if (!card && /^add\b/i.test(lines[0])) {
    return null;
  }
  return { card, entries };
}

/** Non-LLM "store/log/add/record/spent ..." spend entries; null leaves the message for Claude. */
export function parseSpendAddDirective(text: string, now: Date = new Date()): SpendAddDirective | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const today = sgDateString(now);
  if (BATCH_HEADER_RE.test(lines[0])) {
    return parseBatchAdd(lines, today);
  }
  return lines.length === 1 ? parseSingleAdd(lines[0], today) : null;
}

export type SpendOp =
  | { kind: "add"; card: SpendCard | null; entries: SpendAddEntry[]; noCard: "ask" | "claude" | "last" }
  | { kind: "rename"; card: SpendCard; from: string; to: string }
  | { kind: "delete"; card: SpendCard; target: string };

const OP_VERBS = "amend|rename|change|edit|delete|remove|add|store|log|record";
const INLINE_SPLIT_RE = new RegExp(`\\s{2,}(?=(?:${OP_VERBS})\\s)`, "i");
const LEAD_CARD_RE = (): RegExp => new RegExp(`^for\\s+(${aliasTable().alt})(?:\\s+spend(?:ing)?)?\\s*[,:]\\s*`, "i");
const TAIL_CARD_RE = (): RegExp => new RegExp(`\\s+(?:under|to|on|for|in|from)\\s+(${aliasTable().alt})(?:\\s+spend(?:ing)?)?$`, "i");
const AMEND_RE = /^(?:amend|rename)\s+(?<from>.+?)\s+to\s+(?:be\s+)?(?<to>.+)$/i;
const DELETE_RE = /^(?:delete|remove)\s+(?<target>.+?)\s+(?:line\s*items?|lines?|rows?|entry|entries)$/i;
const BARE_WORD_RE = /^[A-Za-z][\w&'’.-]*$/;
const DOLLAR_AMOUNT_RE = /^S?\$\d[\d,]*(?:\.\d+)?$/i;
const BARE_STOP = new Set(
  "i i'm it is the a an my we can could please how what why when where who do does did should would will need want show list set make send buy pay paid bought spent total cost costs price remind note update check".split(" "),
);

function unquote(raw: string): string {
  return raw.trim().replace(/^['"‘“]+|['"’”]+$/g, "").trim();
}

/** Strict "Merchant $amount [date]" line (1-3 merchant words, "$" required), or null so prose is left alone. */
function parseBareAdd(line: string, today: string): SpendAddEntry[] | null {
  const tokens = line.split(/\s+/);
  let spentOn = today;
  for (let i = 1; i < tokens.length; i += 1) {
    const found = dateAt(tokens, i, today);
    if (found && i + found.used === tokens.length) {
      if (!found.iso) {
        return null;
      }
      spentOn = found.iso;
      tokens.splice(tokens[i - 1].toLowerCase() === "on" ? i - 1 : i);
      break;
    }
  }
  const entries: SpendAddEntry[] = [];
  for (const chunk of splitAfterAmounts(tokens)) {
    const words = chunk.slice(0, -1);
    const amount = chunk[chunk.length - 1];
    if (words.length < 1 || words.length > 3 || !DOLLAR_AMOUNT_RE.test(amount) || !words.every((word) => BARE_WORD_RE.test(word))) {
      return null;
    }
    if (BARE_STOP.has(words[0].toLowerCase())) {
      return null;
    }
    entries.push({ spentOn, merchant: words.join(" "), amount: cleanAmount(amount) });
  }
  return entries.length > 0 ? entries : null;
}

type SpendDraft =
  | Extract<SpendOp, { kind: "add" }>
  | { kind: "rename"; card: SpendCard | null; from: string; to: string }
  | { kind: "delete"; card: SpendCard | null; target: string };

function parseSpendSegment(segment: string, today: string): SpendDraft | null {
  let text = segment.trim();
  let card: SpendCard | null = null;
  const lead = LEAD_CARD_RE().exec(text);
  if (lead) {
    card = aliasTable().map.get(lead[1].toLowerCase()) ?? null;
    text = text.slice(lead[0].length);
  }
  const edit = /^(?:amend|rename|delete|remove)\s/i.test(text);
  if (edit) {
    const tail = TAIL_CARD_RE().exec(text);
    if (tail) {
      card = card ?? aliasTable().map.get(tail[1].toLowerCase()) ?? null;
      text = text.slice(0, tail.index);
    }
    const amend = AMEND_RE.exec(text);
    const del = DELETE_RE.exec(text);
    const op = amend
      ? ({ kind: "rename", from: unquote(amend.groups?.from ?? ""), to: unquote(amend.groups?.to ?? "") } as const)
      : del
        ? ({ kind: "delete", target: unquote(del.groups?.target ?? "") } as const)
        : null;
    if (!op || !(op.kind === "rename" ? op.from && op.to : op.target)) {
      return null;
    }
    return { ...op, card };
  }
  if (ADD_VERB_RE.test(text)) {
    const parsed = parseSingleAdd(text, today, true);
    return parsed ? { kind: "add", card: parsed.card ?? card, entries: parsed.entries, noCard: /^(?:add|update)\b/i.test(text) ? "claude" : "ask" } : null;
  }
  const bare = parseBareAdd(text, today);
  return bare ? { kind: "add", card, entries: bare, noCard: "last" } : null;
}

/**
 * Non-LLM spend operations from one message: add (verb, batch or bare "Merchant $2 4 Oct"), amend/rename and
 * delete of a row, several joined by newlines or two spaces; a card named in any part applies to the others.
 * Null leaves the message for Claude.
 */
export function parseSpendOps(text: string, now: Date = new Date()): SpendOp[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const today = sgDateString(now);
  if (BATCH_HEADER_RE.test(lines[0])) {
    const batch = parseBatchAdd(lines, today);
    return batch ? [{ kind: "add", card: batch.card, entries: batch.entries, noCard: "ask" }] : null;
  }
  const drafts: SpendDraft[] = [];
  for (const segment of lines.flatMap((line) => line.split(INLINE_SPLIT_RE))) {
    const draft = parseSpendSegment(segment, today);
    if (!draft) {
      return null;
    }
    drafts.push(draft);
  }
  const shared = drafts.find((draft) => draft.card)?.card ?? null;
  const ops: SpendOp[] = [];
  for (const draft of drafts) {
    const card = draft.card ?? shared;
    if (draft.kind === "add") {
      ops.push({ ...draft, card });
    } else if (card) {
      ops.push({ ...draft, card });
    } else {
      return null;
    }
  }
  return ops;
}
