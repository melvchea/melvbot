import { soleNonemptyLineStripped } from "./prose_line.js";

/** Whole-message "what reminders do I have" phrasings, answered with no model turn. */
const REMINDERS_RE =
  /^(?:(?:show|list|check|see)(?: me)?(?: all)?(?: of)?(?: my| the)? |what(?:'s|s| are| is) (?:my |the )?|any |my )?reminders?$|^what reminders (?:do i have|have i got|are (?:set|there)|am i (?:getting|set))(?: set)?$/;

export function matchRemindersProse(text: string): boolean {
  const line = soleNonemptyLineStripped(text)?.toLowerCase();
  return line !== undefined && line !== null && REMINDERS_RE.test(line);
}

const LOOKUP_RE = /^when(?:'s|s| is) (?:my |the )?reminder (?:to|for|about) (.+)$/;
const LOOKUP_STOP = new Set(["the", "and", "for", "with", "my", "to", "a", "of"]);

/** "when is (my) reminder to/for/about X": the lowercase keywords of X (a trailing "..." drops the cut-off last word), or null. */
export function matchReminderLookup(text: string): string[] | null {
  const line = soleNonemptyLineStripped(text)?.toLowerCase();
  const found = line ? LOOKUP_RE.exec(line.replace(/[?!]+$/, "")) : null;
  if (!found) {
    return null;
  }
  const truncated = /(?:\.\.\.|…)$/.test(found[1]);
  const words = found[1].replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w && !LOOKUP_STOP.has(w));
  if (truncated) {
    words.pop();
  }
  return words.length ? words : null;
}
