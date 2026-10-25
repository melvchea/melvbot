import { cardLabel } from "../profile.js";
import {
  evIntervalCondition,
  headroomCondition,
  isNoteStale,
  matchDayCondition,
  nagoyaCountdownCondition,
  spendGapCondition,
  taskDeadlineCondition,
} from "./conditions.js";
import { isQuietHour, markNudgeFired, shouldShowNudge } from "./store.js";
import type { NudgesToml } from "./toml.js";

export type NudgeButton = { key: string; period: string; label: "Done" | "Snooze" | "Re-check" | "Review" | "Reviewed" };
export type BundleBlock = { text: string; buttons: NudgeButton[] };

export type HeadsUpCardInput = {
  owner: "owner1" | "owner2";
  card: "card1" | "card2";
  total: number;
  target: number;
  limit: number | null;
  cycleStart: string;
  cycleEnd: string;
  lastSpendOn: string | null;
};

export type HeadsUpInput = {
  cards: HeadsUpCardInput[];
  ev: { recentDayGaps: number[]; lastChargedOn: string } | null;
  /** Earliest upcoming booked date in the `nagoya-dec-2026` Note. */
  nagoyaStart?: string | null;
  /** Open tasks with a due date (YYYY-MM-DD). */
  tasks?: { id: string; title: string; dueDay: string }[];
  /** Watch-list entries, one per date. */
  matches?: { date: string; text: string }[];
  toml: NudgesToml;
  now: Date;
  dbPath?: string;
};

/** The SGT calendar date's y/m/d, not the container's own (UTC) local date:
 * a cron job firing at 07:30 SGT is still "yesterday" in UTC. */
function sgtDateParts(now: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function sgtYmd(now: Date): string {
  const { year, month, day } = sgtDateParts(now);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MAX_TASK_NUDGES = 5;

function isoWeek(now: Date): string {
  const { year, month, day } = sgtDateParts(now);
  const date = new Date(Date.UTC(year, month - 1, day));
  const isoDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - isoDay);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Builds the "Heads up" block appended to the Morning Update: card headroom,
 * EV charge interval and spend gaps. Fires each condition at most once per
 * period (recorded in the nudge store); has no network calls itself, so the
 * caller does all the fetching first.
 */
export function buildHeadsUpBlock(input: HeadsUpInput): BundleBlock | null {
  if (isQuietHour(input.now)) {
    return null;
  }
  const lines: string[] = [];
  const buttons: NudgeButton[] = [];

  if (input.toml.headroom) {
    for (const card of input.cards) {
      const key = `headroom:${card.owner.toLowerCase()}`;
      const period = card.cycleStart;
      if (!shouldShowNudge(key, period, input.now, input.dbPath)) {
        continue;
      }
      const line = headroomCondition({ ...card, now: input.now });
      if (line) {
        lines.push(line);
        buttons.push({ key, period, label: "Done" }, { key, period, label: "Snooze" });
        markNudgeFired(key, period, input.now, input.dbPath);
      }
    }
  }

  if (input.toml.evInterval && input.ev) {
    const key = "ev_interval:m6";
    const period = input.ev.lastChargedOn;
    if (shouldShowNudge(key, period, input.now, input.dbPath)) {
      const line = evIntervalCondition({ ...input.ev, now: input.now });
      if (line) {
        lines.push(line);
        buttons.push({ key, period, label: "Done" }, { key, period, label: "Snooze" });
        markNudgeFired(key, period, input.now, input.dbPath);
      }
    }
  }

  if (input.toml.spendGap) {
    for (const card of input.cards) {
      const key = `spend_gap:${card.owner.toLowerCase()}`;
      const period = isoWeek(input.now);
      if (!shouldShowNudge(key, period, input.now, input.dbPath)) {
        continue;
      }
      const line = spendGapCondition({ ...card, now: input.now });
      if (line) {
        lines.push(line);
        buttons.push({ key, period, label: "Done" }, { key, period, label: "Snooze" });
        markNudgeFired(key, period, input.now, input.dbPath);
      }
    }
  }

  const today = sgtYmd(input.now);

  if (input.toml.nagoyaCountdown && input.nagoyaStart) {
    const countdown = nagoyaCountdownCondition({ start: input.nagoyaStart, today });
    const period = countdown ? `${input.nagoyaStart}:${countdown.milestone}` : "";
    if (countdown && shouldShowNudge("nagoya", period, input.now, input.dbPath)) {
      lines.push(countdown.line);
      buttons.push({ key: "nagoya", period, label: "Done" }, { key: "nagoya", period, label: "Snooze" });
      markNudgeFired("nagoya", period, input.now, input.dbPath);
    }
  }

  if (input.toml.taskDeadline) {
    for (const task of (input.tasks ?? []).slice(0, MAX_TASK_NUDGES)) {
      const key = `task_deadline:${task.id.slice(0, 12)}`;
      const line = taskDeadlineCondition({ title: task.title, dueDay: task.dueDay, today });
      if (line && shouldShowNudge(key, task.dueDay, input.now, input.dbPath)) {
        lines.push(line);
        buttons.push({ key, period: task.dueDay, label: "Done" }, { key, period: task.dueDay, label: "Snooze" });
        markNudgeFired(key, task.dueDay, input.now, input.dbPath);
      }
    }
  }

  if (input.toml.matchDay) {
    for (const match of input.matches ?? []) {
      const alert = matchDayCondition({ ...match, today });
      const key = `match_day:${match.date}`;
      const period = alert ? `d${alert.days}` : "";
      if (alert && shouldShowNudge(key, period, input.now, input.dbPath)) {
        lines.push(alert.line);
        buttons.push({ key, period, label: "Done" }, { key, period, label: "Snooze" });
        markNudgeFired(key, period, input.now, input.dbPath);
      }
    }
  }

  if (lines.length === 0) {
    return null;
  }
  return { text: ["Heads up:", ...lines.map((line) => `• ${line}`)].join("\n"), buttons };
}

export type StaleNoteInput = { slug: string; updatedAt: string; tags: string[] };
export type AutoHistoryCount = { slug: string; count: number };

export type CycleSpendTotal = {
  owner: "owner1" | "owner2";
  card: "card1" | "card2";
  total: number;
  target: number;
  cycleEnd: string;
};

export type MonthlyReviewInput = {
  notes: StaleNoteInput[];
  /** Totals of the cycle containing the day before the review; owner2's may still be open. */
  lastCycleSpend?: CycleSpendTotal[];
  houseRulesBulletCount: number;
  autoHistoryEntries: AutoHistoryCount[];
  episodeCount?: number;
  toml: NudgesToml;
  now: Date;
};

function monthKey(now: Date): string {
  const { year, month } = sgtDateParts(now);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Builds the "Monthly review" block appended to the Monthly 1st job: stale
 * time-sensitive Notes, the house-rules bullet count, and (auto) History
 * entries added since the last review. No network calls; the caller fetches
 * the Notes list and house-rules body first.
 */
export function buildMonthlyReviewBlock(input: MonthlyReviewInput): BundleBlock | null {
  if (!input.toml.monthlyReview) {
    return null;
  }
  const period = monthKey(input.now);
  const lines: string[] = [];
  const buttons: NudgeButton[] = [];

  for (const spend of input.lastCycleSpend ?? []) {
    const verdict = spend.total >= spend.target ? "met" : "short";
    lines.push(
      `${cardLabel(spend.owner, spend.card)}: $${spend.total.toFixed(0)} of $${spend.target.toFixed(0)} Target, ${verdict} (cycle to ${spend.cycleEnd})`,
    );
  }

  const staleSlugs = input.notes
    .filter((note) => isNoteStale({ updatedAt: note.updatedAt, tags: note.tags, now: input.now }))
    .map((note) => note.slug);
  if (staleSlugs.length > 0) {
    lines.push(`Stale Notes: ${staleSlugs.join(", ")}`);
    buttons.push({ key: "monthly_review:stale", period, label: "Re-check" });
  }

  if (input.houseRulesBulletCount > 0) {
    const word = input.houseRulesBulletCount === 1 ? "bullet" : "bullets";
    lines.push(`House rules: ${input.houseRulesBulletCount} ${word}`);
    buttons.push({ key: "monthly_review:house_rules", period, label: "Review" });
  }

  if ((input.episodeCount ?? 0) > 0) {
    lines.push(`Episodic snapshots saved: ${input.episodeCount}`);
  }

  const autoTotal = input.autoHistoryEntries.reduce((sum, entry) => sum + entry.count, 0);
  if (autoTotal > 0) {
    const names = input.autoHistoryEntries.map((entry) => entry.slug).join(", ");
    const word = autoTotal === 1 ? "entry" : "entries";
    lines.push(`${autoTotal} auto-saved ${word}: ${names}`);
    buttons.push({ key: "monthly_review:reviewed", period, label: "Reviewed" });
  }

  if (lines.length === 0) {
    return null;
  }
  return { text: ["Monthly review:", ...lines.map((line) => `• ${line}`)].join("\n"), buttons };
}
