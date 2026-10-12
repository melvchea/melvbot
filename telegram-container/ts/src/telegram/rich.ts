const GFM_TABLE_RE = /^\|.+\|\s*\n\|?\s*:?-{3,}[-| :]*\|?\s*$/m;
const SPEND_HEADER_RE = /^[\u200b\s\u00a0]*Date[\s\u00a0]+Merchant[\s\u00a0]+Amount[\s\u00a0]*$/im;
const SPEND_ROW_RE =
  /^[\u200b\s\u00a0]*(?<date>\d{1,2}[\s\u00a0]+[A-Za-z]{3})[\s\u00a0]+(?<merchant>\S+(?:[\s\u00a0]+\S+)*?)[\s\u00a0]+(?<amount>\\?\$\d[\d,]*(?:\.\d{2})?)[\s\u00a0]*$/im;
const SPEND_BULLET_RE =
  /^[•*-][\u200b\s\u00a0]+(?<date>\d{1,2}[\s\u00a0]+[A-Za-z]{3})[\s\u00a0]+[—–-][\s\u00a0]+(?<merchant>.+?)[\s\u00a0]+[—–-][\s\u00a0]+\\?\$(?<amount>\d[\d,]*(?:\.\d{2})?)[\s\u00a0]*$/u;
const MIN_SPEND_ROWS = 2;

export type RichMessage = { markdown: string };

function collapseWs(value: string): string {
  return value.replace(/[\s\u00a0\u200b]+/g, " ").trim();
}

function gfmEscapeCell(value: string): string {
  return collapseWs(value).replace(/\|/g, "\\|");
}

function plainAmount(amount: string): string {
  return amount.replace(/^\\/, "");
}

const SPEND_TABLE_HEADER = "| Date | Merchant | Amount |\n|:-----|:---------|-------:|";

function spendTable(rows: [string, string, string][]): string {
  const lines = [SPEND_TABLE_HEADER];
  for (const [date, merchant, amount] of rows) {
    lines.push(
      `| ${gfmEscapeCell(date)} | ${gfmEscapeCell(merchant)} | ${gfmEscapeCell(plainAmount(amount))} |`,
    );
  }
  return lines.join("\n");
}

function escapeRichCurrency(text: string): string {
  return text.replace(/(?<!\\)\$(?=\d)/g, "\\$");
}

export function containsGfmTable(text: string): boolean {
  return GFM_TABLE_RE.test(text);
}

export function containsSpendColumnTable(text: string): boolean {
  if (!text) {
    return false;
  }
  if (SPEND_HEADER_RE.test(text)) {
    return true;
  }
  let hits = 0;
  for (const line of text.split("\n")) {
    if (SPEND_ROW_RE.test(line)) {
      hits += 1;
      if (hits >= MIN_SPEND_ROWS) {
        return true;
      }
    }
  }
  return false;
}

export function containsSpendBulletList(text: string): boolean {
  let hits = 0;
  for (const line of text.split("\n")) {
    if (SPEND_BULLET_RE.test(line)) {
      hits += 1;
      if (hits >= MIN_SPEND_ROWS) {
        return true;
      }
    }
  }
  return false;
}

export function shouldSendRichMessage(text: string): boolean {
  return containsGfmTable(text) || containsSpendColumnTable(text) || containsSpendBulletList(text);
}

function loosenTotals(line: string): string {
  if (isCard2Totals(line)) {
    return line;
  }
  if (/^(?:Met Target |\\?\$[\d,]+\.\d{2} to Target )/.test(line)) {
    return line.replace(" · ", "\n");
  }
  return line;
}

function isCard2Totals(line: string): boolean {
  return line.includes("Limit") && (line.includes("Target") || line.includes("Spent"));
}

function flushCard2Totals(out: string[], pending: string[]): void {
  if (pending.length === 0) {
    return;
  }
  out.push("", pending.join("\n"));
  pending.length = 0;
}

export function spendColumnsToGfm(text: string): string | null {
  if (!text || !containsSpendColumnTable(text)) {
    return null;
  }
  const lines = text.split("\n");
  const out: string[] = [];
  const pendingTotals: string[] = [];
  let i = 0;
  let converted = false;
  while (i < lines.length) {
    const line = lines[i];
    if (isCard2Totals(line)) {
      pendingTotals.push(line.trim());
      i += 1;
      continue;
    }
    if (pendingTotals.length > 0 && line.trim() === "") {
      i += 1;
      continue;
    }
    if (SPEND_HEADER_RE.test(line) || SPEND_ROW_RE.test(line)) {
      const blockStart = i;
      const rows: [string, string, string][] = [];
      let hasHeader = false;
      if (SPEND_HEADER_RE.test(line)) {
        hasHeader = true;
        i += 1;
      }
      while (i < lines.length) {
        const match = lines[i].match(SPEND_ROW_RE);
        if (match === null || !match.groups) {
          break;
        }
        rows.push([
          collapseWs(match.groups.date),
          collapseWs(match.groups.merchant),
          collapseWs(match.groups.amount),
        ]);
        i += 1;
      }
      if (!rows.length && !hasHeader) {
        out.push(lines[blockStart]);
        i = blockStart + 1;
        continue;
      }
      out.push(spendTable(rows));
      flushCard2Totals(out, pendingTotals);
      converted = true;
      continue;
    }
    out.push(loosenTotals(line));
    i += 1;
  }
  flushCard2Totals(out, pendingTotals);
  if (!converted) {
    return null;
  }
  return `${out.join("\n").trim()}\n`;
}

export function spendBulletsToGfm(text: string): string | null {
  if (!text || !containsSpendBulletList(text)) {
    return null;
  }
  const lines = text.split("\n");
  const out: string[] = [];
  const pendingTotals: string[] = [];
  let i = 0;
  let converted = false;
  while (i < lines.length) {
    if (isCard2Totals(lines[i])) {
      pendingTotals.push(lines[i].trim());
      i += 1;
      continue;
    }
    if (pendingTotals.length > 0 && lines[i].trim() === "") {
      i += 1;
      continue;
    }
    if (SPEND_BULLET_RE.test(lines[i])) {
      const rows: [string, string, string][] = [];
      while (i < lines.length) {
        const match = lines[i].match(SPEND_BULLET_RE);
        if (match === null || !match.groups) {
          break;
        }
        rows.push([
          collapseWs(match.groups.date),
          collapseWs(match.groups.merchant),
          `$${match.groups.amount}`,
        ]);
        i += 1;
      }
      out.push(spendTable(rows));
      flushCard2Totals(out, pendingTotals);
      converted = true;
      continue;
    }
    out.push(loosenTotals(lines[i]));
    i += 1;
  }
  flushCard2Totals(out, pendingTotals);
  if (!converted) {
    return null;
  }
  return `${out.join("\n").trim()}\n`;
}

export function toRichMarkdown(text: string): string | null {
  if (!text.trim()) {
    return null;
  }
  if (containsGfmTable(text)) {
    const cleaned = text.replace(/\u200b/g, "").replace(/\u00a0/g, " ");
    return `${escapeRichCurrency(cleaned.trim())}\n`;
  }
  const converted = spendColumnsToGfm(text) ?? spendBulletsToGfm(text);
  if (converted !== null) {
    return escapeRichCurrency(converted);
  }
  return null;
}

export function inputRichMessageFromText(text: string): RichMessage | null {
  const markdown = toRichMarkdown(text);
  if (markdown === null) {
    return null;
  }
  return { markdown };
}

export type ReplySegment = { kind: "text" | "rich"; text: string };

const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}[-| :]*\|?\s*$/;
const HEADING_RE = /^\s*(?:\*\*[^*].*\*\*|__[^_].*__|#{1,6}\s+\S.*)\s*$/;

function pushSegment(out: ReplySegment[], kind: "text" | "rich", text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const prev = out[out.length - 1];
  if (prev && prev.kind === kind) {
    prev.text += kind === "rich" ? `\n\n${trimmed}` : `\n${trimmed}`;
    return;
  }
  out.push({ kind, text: trimmed });
}

/**
 * Splits a reply into ordered segments: only table blocks (GFM, or spend lists converted to GFM) are "rich",
 * together with a heading line right before them; everything else (preamble, totals, notes) stays "text".
 */
export function splitRichSegments(text: string): ReplySegment[] {
  if (!text.trim()) {
    return [];
  }
  const source = containsGfmTable(text)
    ? text.replace(/​/g, "").replace(/ /g, " ")
    : (spendColumnsToGfm(text) ?? spendBulletsToGfm(text) ?? text);
  const lines = source.split("\n");
  const out: ReplySegment[] = [];
  let pending: string[] = [];
  const flushText = (): void => {
    pushSegment(out, "text", pending.join("\n").replace(/\\\$/g, "$"));
    pending = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (TABLE_LINE_RE.test(lines[i]) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      let end = i + 2;
      while (end < lines.length && TABLE_LINE_RE.test(lines[end])) {
        end += 1;
      }
      let heading = "";
      let last = pending.length - 1;
      while (last >= 0 && pending[last].trim() === "") {
        last -= 1;
      }
      if (last >= 0 && HEADING_RE.test(pending[last])) {
        heading = `${pending[last].trim()}\n\n`;
        pending = pending.slice(0, last);
      }
      flushText();
      pushSegment(out, "rich", escapeRichCurrency(`${heading}${lines.slice(i, end).join("\n")}`));
      i = end;
      continue;
    }
    pending.push(lines[i]);
    i += 1;
  }
  flushText();
  return out;
}
