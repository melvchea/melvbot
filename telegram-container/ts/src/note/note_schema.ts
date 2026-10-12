export const PROCEDURE_NOTE_SLUGS = [
  "phone-buy",
  "ev-buy",
  "family-eat",
  "sim-card-plan",
  "house-rules",
] as const;

export const PROCEDURE_REQUIRED_HEADING = "## Rules";
export const PROCEDURE_OPTIONAL_HEADINGS = ["## Current pick", "## Shortlist", "## History"] as const;

/** Spend records and tabular row patterns that belong on Sheets, not Notes. Reference prices are fine. */
const NOTE_MONEY_RE = /(?:(?:S\$|\$|SGD|USD)\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:SGD|USD|dollars)\b)/i;
const NOTE_SPEND_VERB_RE =
  /\b(?:paid|spent|bought|purchased|charged|refunded|topped up|transferred|reimbursed|withdrew)\b/i;
const NOTE_SPEND_LINE_RE = /^.*$/gm;

/** Lines that hold both a money amount and a spend verb. */
function spendLines(text: string): string[] {
  return (text.match(NOTE_SPEND_LINE_RE) ?? []).filter((l) => NOTE_MONEY_RE.test(l) && NOTE_SPEND_VERB_RE.test(l));
}
const NOTE_TABULAR_ROW_RE = /^\s*\d{4}-\d{2}-\d{2}\s+[^\n]+\t[^\n]+/gm;
const NOTE_PIPE_ROW_RE = /^\s*\d+\s*\|\s*[^\n|]+\|/gm;

function hasHeading(body: string, heading: string): boolean {
  return body.includes(heading);
}

const HISTORY_SECTION_HEADING = "## History";

/** Body with the `## History` section removed; History is an archive and may quote old prices. */
export function stripHistorySection(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let inHistory = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inHistory = line.trim() === HISTORY_SECTION_HEADING;
    }
    if (!inHistory) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

/** Matches of `re` in `text` as a count map (multiset), keyed by trimmed match. */
function matchCounts(re: RegExp, text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(re)) {
    const key = match[0].trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** True when `next` has a match of `re` that `previous` does not already have (multiset compare). */
function hasNewMatch(re: RegExp, next: string, previous: string | undefined): boolean {
  const nextCounts = matchCounts(re, next);
  const prevCounts = previous === undefined ? new Map<string, number>() : matchCounts(re, previous);
  for (const [key, count] of nextCounts) {
    if (count > (prevCounts.get(key) ?? 0)) {
      return true;
    }
  }
  return false;
}

/**
 * Reject spend records (a line with a money amount and a spend verb) and row layouts inside a Note body;
 * reference prices are allowed, and anything in History. With `previousBody`, only lines/rows that are NEW
 * relative to it are rejected, so editing an existing Note that already holds them does not fail.
 */
export function assertNoteBodyNotSheetLike(body: string, previousBody?: string): void {
  const prevCounts = new Map<string, number>();
  if (previousBody !== undefined) {
    for (const l of spendLines(stripHistorySection(previousBody))) {
      prevCounts.set(l.trim(), (prevCounts.get(l.trim()) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  for (const l of spendLines(stripHistorySection(body))) {
    const key = l.trim();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (prevCounts.get(key) ?? 0)) {
      throw new Error(`note looks like a spend record ("${key.slice(0, 80)}"); log it with sheet spend add instead`);
    }
  }
  if (hasNewMatch(NOTE_TABULAR_ROW_RE, body, previousBody) || hasNewMatch(NOTE_PIPE_ROW_RE, body, previousBody)) {
    throw new Error("note body must not contain tabular spend rows; use Sheets instead");
  }
}

/** Procedure Notes must include ## Rules unless they're legacy notes that never had it. */
export function validateProcedureNoteBody(slug: string, body: string, previousBody?: string): void {
  assertNoteBodyNotSheetLike(body, previousBody);
  if (!(PROCEDURE_NOTE_SLUGS as readonly string[]).includes(slug)) {
    return;
  }
  // Only require ## Rules for new notes or notes that previously had it
  const shouldRequireRules = previousBody === undefined || hasHeading(previousBody, PROCEDURE_REQUIRED_HEADING);
  if (shouldRequireRules && !hasHeading(body, PROCEDURE_REQUIRED_HEADING)) {
    throw new Error(`procedure note ${slug} must include a ${PROCEDURE_REQUIRED_HEADING} section`);
  }
}
