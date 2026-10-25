import { cardLabel, vehicleName } from "../profile.js";
/** Pure condition functions for the six nudges: given data the caller already
 * fetched, decide whether to fire and how to word the line. No I/O here, so
 * every case is table-testable. */

export const HEADROOM_NUDGE_DAYS = 5;
export const LIMIT_WARN_PCT = 90;
export const EV_INTERVAL_SAMPLE = 5;
export const EV_OVERDUE_GRACE_DAYS = 2;
export const EV_MIN_SAMPLES = 3;
export const SPEND_GAP_DAYS = 7;
export const NOTE_STALE_DAYS = 30;

const MS_PER_DAY = 86_400_000;

function daysBetween(earlier: string, later: Date): number {
  return Math.floor((later.getTime() - Date.parse(`${earlier}T00:00:00Z`)) / MS_PER_DAY);
}

export type HeadroomInput = {
  owner: "owner1" | "owner2";
  card: "card1" | "card2";
  total: number;
  target: number;
  limit: number | null;
  cycleEnd: string;
  now: Date;
};

/** Fires when the cycle ends within HEADROOM_NUDGE_DAYS and the total is below
 * target, or (owner2 only) the total has passed LIMIT_WARN_PCT% of the limit. */
export function headroomCondition(input: HeadroomInput): string | null {
  const daysToEnd = daysBetween(input.cycleEnd, input.now) * -1;
  const nearEnd = daysToEnd >= 0 && daysToEnd <= HEADROOM_NUDGE_DAYS;
  const belowTarget = input.total < input.target;
  const limitPct = input.limit ? (input.total / input.limit) * 100 : 0;
  const overLimitWarn = input.limit !== null && limitPct >= LIMIT_WARN_PCT;
  if (overLimitWarn) {
    return `${cardLabel(input.owner, input.card)}: $${input.total.toFixed(0)} is ${limitPct.toFixed(0)}% of the $${input.limit!.toFixed(0)} limit`;
  }
  if (nearEnd && belowTarget) {
    const toGo = (input.target - input.total).toFixed(0);
    const dayWord = daysToEnd === 1 ? "day" : "days";
    return `${cardLabel(input.owner, input.card)}: $${toGo} to Target $${input.target.toFixed(0)}, cycle ends in ${daysToEnd} ${dayWord}`;
  }
  return null;
}

export type EvIntervalInput = {
  /** day_gap of the last EV_INTERVAL_SAMPLE full charges, most recent last. */
  recentDayGaps: number[];
  lastChargedOn: string;
  now: Date;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Fires when the days since the last charge reach the median interval plus
 * EV_OVERDUE_GRACE_DAYS. Skipped with fewer than EV_MIN_SAMPLES samples. */
export function evIntervalCondition(input: EvIntervalInput): string | null {
  if (input.recentDayGaps.length < EV_MIN_SAMPLES) {
    return null;
  }
  const samples = input.recentDayGaps.slice(-EV_INTERVAL_SAMPLE);
  const expected = median(samples);
  const daysSince = daysBetween(input.lastChargedOn, input.now);
  if (daysSince >= expected + EV_OVERDUE_GRACE_DAYS) {
    return `${vehicleName()} M6: ${daysSince} days since the last charge (usually every ${Math.round(expected)})`;
  }
  return null;
}

export type SpendGapInput = {
  owner: "owner1" | "owner2";
  card: "card1" | "card2";
  lastSpendOn: string | null;
  cycleStart: string;
  now: Date;
};

/** Fires when a card has no spend row for SPEND_GAP_DAYS inside the current cycle. */
export function spendGapCondition(input: SpendGapInput): string | null {
  const since = input.lastSpendOn ?? input.cycleStart;
  const daysSince = daysBetween(since, input.now);
  if (daysSince >= SPEND_GAP_DAYS) {
    const label = input.lastSpendOn ? `since ${input.lastSpendOn}` : "this cycle";
    return `No ${cardLabel(input.owner, input.card)} spend logged ${label}`;
  }
  return null;
}

export type NoteStaleInput = { updatedAt: string; tags: string[]; now: Date };

/** Matches system_prompt.ts's staleness rule: only `time-sensitive` Notes go stale. */
export function isNoteStale(input: NoteStaleInput): boolean {
  if (!input.tags.includes("time-sensitive")) {
    return false;
  }
  const updatedMs = Date.parse(input.updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return false;
  }
  return (input.now.getTime() - updatedMs) / MS_PER_DAY > NOTE_STALE_DAYS;
}

export const NAGOYA_MILESTONES = [30, 14, 7, 3, 1];
export const TASK_DEADLINE_DAYS = 7;
export const MATCH_DAY_LEAD_DAYS = 1;

/** Whole days from `today` to `target`, both SGT YYYY-MM-DD strings. */
export function daysUntil(target: string, today: string): number {
  return Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY);
}

/** The earliest YYYY-MM-DD on or after `today` in a Note body: the first booked date of the trip. */
export function firstUpcomingDate(body: string, today: string): string | null {
  const dates = (body.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).filter((date) => date >= today);
  return dates.sort()[0] ?? null;
}

/** Countdown line plus the milestone bracket (30/14/7/3/1) it belongs to, so a missed day still fires once. */
export function nagoyaCountdownCondition(input: { start: string; today: string }): { line: string; milestone: number } | null {
  const days = daysUntil(input.start, input.today);
  const milestone = NAGOYA_MILESTONES.filter((value) => value >= days).at(-1);
  if (days < 0 || milestone === undefined) {
    return null;
  }
  const when = days === 0 ? "starts today" : `in ${days} ${days === 1 ? "day" : "days"}`;
  return { line: `Nagoya trip ${when} (${input.start})`, milestone };
}

/** Fires for an open task due in 1..TASK_DEADLINE_DAYS days; today's are the 19:15 sweep's. */
export function taskDeadlineCondition(input: { title: string; dueDay: string; today: string }): string | null {
  const days = daysUntil(input.dueDay, input.today);
  if (days < 1 || days > TASK_DEADLINE_DAYS) {
    return null;
  }
  return `${input.title} is due in ${days} ${days === 1 ? "day" : "days"} (${input.dueDay})`;
}

/** Watch-list lines are `YYYY-MM-DD text`; one line per date, same-day entries joined. */
export function parseWatchList(body: string): { date: string; text: string }[] {
  const byDate = new Map<string, string[]>();
  for (const match of body.matchAll(/^[-*\s]*(\d{4}-\d{2}-\d{2})[\s:]+(.+)$/gm)) {
    byDate.set(match[1], [...(byDate.get(match[1]) ?? []), match[2].trim()]);
  }
  return [...byDate].map(([date, texts]) => ({ date, text: texts.join(" / ") }));
}

/** Fires on the match day and MATCH_DAY_LEAD_DAYS before it. */
export function matchDayCondition(input: { date: string; text: string; today: string }): { line: string; days: number } | null {
  const days = daysUntil(input.date, input.today);
  if (days < 0 || days > MATCH_DAY_LEAD_DAYS) {
    return null;
  }
  return { line: `${days === 0 ? "Today" : "Tomorrow"}: ${input.text}`, days };
}
