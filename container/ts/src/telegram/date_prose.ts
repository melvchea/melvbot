const OFFSETS: Record<string, number> = { today: 0, tomorrow: 1, tmrw: 1, tmr: 1, yesterday: -1 };
const WORD = "(today|tomorrow|tmrw|tmr|yesterday)";
const DATE_RE = new RegExp(
  `^(?:what(?:'|’)?s|what is|what was|tell me)?\\s*(?:the\\s+)?(?:${WORD}(?:'|’)?s?\\s+date|date\\s+${WORD}|day\\s+(?:is|was)\\s+(?:it\\s+)?${WORD}|day\\s+${WORD})\\s*\\??$|^what\\s+day\\s+(?:is|was)\\s+(?:it\\s+)?${WORD}\\s*\\??$`,
  "i",
);

/** Day offset for "what is tmrw's date" / "what day is today"; null for anything else (left to Claude). */
export function matchDateProse(text: string): number | null {
  const m = DATE_RE.exec(text.trim());
  const word = m?.slice(1).find((g) => g !== undefined);
  return word === undefined ? null : OFFSETS[word.toLowerCase()];
}

/** "Wednesday, 7 Oct 2026" in Asia/Singapore, `offset` days from `now`. */
export function dateReply(offset: number, now: Date = new Date()): string {
  const target = new Date(now.getTime() + offset * 86_400_000);
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(target);
  return text.replace(/^(\w+) /, "$1, ");
}
