import { ftsBm25Scores } from "./recall_index.js";
import { redactForPrompt } from "./redact.js";
import { PROCEDURE_NOTE_SLUGS } from "../note/note_schema.js";
import { noteIndexForRecall, PROCEDURE_NOTE_MAX_CHARS } from "./system_prompt.js";

export const MIN_RECALL_SCORE = 0.5;
/** Total excerpt budget across injected notes: best note gets the larger share, the runner-up the rest. */
export const RECALL_BODY_MAX_CHARS = 1_200;
export const RECALL_SECOND_BODY_MAX_CHARS = 400;
/** The runner-up is injected only when its score is at least this fraction of the best score. */
export const RECALL_SECOND_MIN_RATIO = 0.6;
const SLUG_MENTION_SCORE = 1_000;

export type RankableNote = {
  slug: string;
  updatedAt?: string;
  stale?: boolean;
  archived?: boolean;
};

export type RankedNote = { slug: string; score: number };

/** Lowercase alphanumeric tokens; stemming is left to the FTS5 porter tokenizer. */
export function noteTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2))];
}

export function rankNotes(query: string, notes: readonly RankableNote[], dbPath?: string): RankedNote[] {
  const bm25 = ftsBm25Scores(query, dbPath);
  const lowered = query.toLowerCase();
  const ranked: RankedNote[] = [];
  for (const note of notes) {
    if (note.archived) {
      continue;
    }
    const score = (bm25.get(note.slug) ?? 0) + (lowered.includes(note.slug) ? SLUG_MENTION_SCORE : 0);
    if (score > 0) {
      ranked.push({ slug: note.slug, score });
    }
  }
  ranked.sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug));
  return ranked;
}

export function selectNoteForInjection(ranked: readonly RankedNote[]): RankedNote | null {
  const top = ranked[0];
  return top !== undefined && top.score >= MIN_RECALL_SCORE ? top : null;
}

export function selectNotesForInjection(ranked: readonly RankedNote[]): RankedNote[] {
  const top = selectNoteForInjection(ranked);
  if (top === null) {
    return [];
  }
  const second = ranked.find((entry) => entry.slug !== top.slug);
  return second !== undefined && second.score >= MIN_RECALL_SCORE && second.score >= top.score * RECALL_SECOND_MIN_RATIO
    ? [top, second]
    : [top];
}

const EXCERPT_MARKER = "[excerpt; note get <slug> for the full note]";
const RULES_HEADING = "## Rules";

/** Splits on `## ` heading lines; text before the first heading is its own section. */
function splitSections(body: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("## ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join("\n"));
  return sections.filter((section) => section.trim().length > 0);
}

function isRulesSection(section: string): boolean {
  return section.split("\n", 1)[0].trim() === RULES_HEADING;
}

/** Whole body when short, else the `## Rules` section plus the sections that best match the query, in original order. */
export function excerptBody(body: string, query: string, slug: string, maxChars: number): string {
  const redacted = redactForPrompt(body);
  if (redacted.length <= maxChars) {
    return redacted;
  }
  const marker = `\n${EXCERPT_MARKER.replace("<slug>", slug)}`;
  const budget = Math.max(0, maxChars - marker.length);
  const sections = splitSections(redacted);
  const queryTokens = noteTokens(query);
  const score = (section: string) => {
    const tokens = new Set(noteTokens(section));
    return queryTokens.filter((token) => tokens.has(token)).length;
  };
  const order = sections
    .map((section, index) => ({ index, rules: isRulesSection(section), score: score(section) }))
    .sort((left, right) => Number(right.rules) - Number(left.rules) || right.score - left.score || left.index - right.index);
  const chosen = new Set<number>();
  let used = 0;
  for (const { index } of order) {
    const section = sections[index];
    const size = section.length + (chosen.size > 0 ? 1 : 0);
    if (used + size > budget) {
      continue;
    }
    chosen.add(index);
    used += size;
  }
  if (chosen.size === 0) {
    return `${redacted.slice(0, budget)}${marker}`;
  }
  const text = sections.filter((_, index) => chosen.has(index)).join("\n");
  return chosen.size < sections.length ? `${text}${marker}` : text;
}

export type RecallResult = { text: string; key: string | null };

const NO_RECALL: RecallResult = { text: "", key: null };

/** Injects the best-matching Note (plus a close runner-up) so recall does not depend on the model calling `note get`. */
export async function recallPrefix(query: string, dbPath?: string): Promise<RecallResult> {
  const notes = await noteIndexForRecall(dbPath);
  const picks = selectNotesForInjection(rankNotes(query, notes, dbPath));
  const blocks: string[] = [];
  const keys: string[] = [];
  const total = RECALL_BODY_MAX_CHARS;
  for (const pick of picks) {
    const note = notes.find((entry) => entry.slug === pick.slug);
    if (note === undefined) {
      continue;
    }
    const redacted = redactForPrompt(note.body);
    // The system prompt already carries short procedure notes in full.
    if ((PROCEDURE_NOTE_SLUGS as readonly string[]).includes(pick.slug) && redacted.length <= PROCEDURE_NOTE_MAX_CHARS) {
      continue;
    }
    const max = blocks.length === 0 ? total - RECALL_SECOND_BODY_MAX_CHARS : RECALL_SECOND_BODY_MAX_CHARS;
    const attrs = `slug="${pick.slug}" updated="${note.updatedAt.slice(0, 10)}"${note.stale ? ' stale="true"' : ""}`;
    blocks.push(`<memory tier="semantic" ${attrs}>\n${excerptBody(note.body, query, pick.slug, max)}\n</memory>`);
    keys.push(`${pick.slug}@${note.updatedAt}`);
  }
  if (blocks.length === 0) {
    return NO_RECALL;
  }
  return { text: blocks.join("\n"), key: keys.join("|") };
}
