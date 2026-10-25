/**
 * Fetches the live data the pure bundle builders (`bundle.ts`) need, so
 * `run_once.ts` only has to call `collectHeadsUpInput`/`collectMonthlyReviewInput`
 * and hand the result to `buildHeadsUpBlock`/`buildMonthlyReviewBlock`.
 */
import { countEpisodes } from "../assistant/conversation_store.js";
import { tasksList } from "../google/http.js";
import { getNote, listNotes } from "../note/notes.js";
import { listEv } from "../sheet/ev_list.js";
import { parseMoney } from "../sheet/spend_cycle.js";
import { listSpend } from "../sheet/spend_list.js";
import type { AutoHistoryCount, CycleSpendTotal, HeadsUpCardInput, HeadsUpInput, MonthlyReviewInput, StaleNoteInput } from "./bundle.js";
import { firstUpcomingDate, parseWatchList, TASK_DEADLINE_DAYS, daysUntil } from "./conditions.js";
import { lastReviewedAt } from "./store.js";
import type { NudgesToml } from "./toml.js";

const HOUSE_RULES_BULLET_RE = /^- \d{4}-\d{2}-\d{2}: /gm;
const AUTO_HISTORY_LINE_RE = /^- (\d{4}-\d{2}-\d{2}) \(auto\)/gm;

/**
 * The SGT calendar date, not the container's own (UTC) local date: cron
 * jobs like the Morning Update fire at 07:30 SGT, which is still "yesterday"
 * in UTC, so a naive `toISOString().slice(0, 10)` would resolve the wrong
 * spend cycle right after it rolls over. Matches run_once.ts's googlePrefetch.
 */
function ymd(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function headsUpCard(owner: "owner1" | "owner2", card: "card1" | "card2", now: Date): Promise<HeadsUpCardInput> {
  const summary = await listSpend({ owner, card, cycleDate: ymd(now) });
  const lastEntry = summary.entries.at(-1);
  return {
    owner,
    card,
    total: parseMoney(summary.total),
    target: parseMoney(summary.target),
    limit: summary.limit === null ? null : parseMoney(summary.limit),
    cycleStart: summary.cycle_start,
    cycleEnd: summary.cycle_end,
    lastSpendOn: lastEntry ? lastEntry.spent_on : null,
  };
}

export async function collectHeadsUpInput(toml: NudgesToml, now: Date, dbPath?: string): Promise<HeadsUpInput> {
  const cards = await Promise.all([
    headsUpCard("owner1", "card1", now),
    headsUpCard("owner2", "card2", now),
  ]);
  let ev: HeadsUpInput["ev"] = null;
  try {
    const rows = await listEv();
    const recentDayGaps = rows.filter((row) => row.day_gap !== null).map((row) => row.day_gap as number);
    const lastChargedOn = rows.at(-1)?.charge.charged_on ?? null;
    if (lastChargedOn) {
      ev = { recentDayGaps, lastChargedOn };
    }
  } catch {
    ev = null;
  }
  const today = ymd(now);
  const [nagoyaStart, tasks, matches] = await Promise.all([
    toml.nagoyaCountdown ? nagoyaStartDate(today) : null,
    toml.taskDeadline ? upcomingTasks(today) : [],
    toml.matchDay ? watchList() : [],
  ]);
  return { cards, ev, nagoyaStart, tasks, matches, toml, now, dbPath };
}

// Each extra source fails open: a missing Note or Google error drops only its own nudge.
async function nagoyaStartDate(today: string): Promise<string | null> {
  try {
    return firstUpcomingDate((await getNote("nagoya-dec-2026")).body, today);
  } catch {
    return null;
  }
}

async function upcomingTasks(today: string): Promise<NonNullable<HeadsUpInput["tasks"]>> {
  try {
    return (await tasksList(100))
      .map((task) => ({ id: task.id, title: task.title, dueDay: task.due.slice(0, 10) }))
      .filter((task) => task.id && task.dueDay && daysUntil(task.dueDay, today) >= 1 && daysUntil(task.dueDay, today) <= TASK_DEADLINE_DAYS);
  } catch {
    return [];
  }
}

async function watchList(): Promise<NonNullable<HeadsUpInput["matches"]>> {
  try {
    return parseWatchList((await getNote("watch-list")).body);
  } catch {
    return [];
  }
}

async function lastCycleSpend(owner: "owner1" | "owner2", card: "card1" | "card2", now: Date): Promise<CycleSpendTotal> {
  const yesterday = ymd(new Date(now.getTime() - 86_400_000));
  const summary = await listSpend({ owner, card, cycleDate: yesterday });
  return { owner, card, total: parseMoney(summary.total), target: parseMoney(summary.target), cycleEnd: summary.cycle_end };
}

export async function collectMonthlyReviewInput(toml: NudgesToml, now: Date, dbPath?: string): Promise<MonthlyReviewInput> {
  // A sheet failure must not block the rest of the monthly review.
  const lastCycleSpendTotals = await Promise.all([
    lastCycleSpend("owner1", "card1", now),
    lastCycleSpend("owner2", "card2", now),
  ].map((pending) => pending.catch(() => null)));
  const index = await listNotes();
  const notes: StaleNoteInput[] = index.map((note) => ({ slug: note.slug, updatedAt: note.updated_at, tags: note.tags }));

  let houseRulesBulletCount = 0;
  try {
    const houseRules = await getNote("house-rules");
    houseRulesBulletCount = houseRules.body.match(HOUSE_RULES_BULLET_RE)?.length ?? 0;
  } catch {
    houseRulesBulletCount = 0;
  }

  const sinceMs = lastReviewedAt("monthly_review", dbPath);
  const sinceEpoch = sinceMs ? Date.parse(sinceMs) : 0;
  const autoHistoryEntries: AutoHistoryCount[] = [];
  for (const noteIndex of index) {
    try {
      const note = await getNote(noteIndex.slug);
      const matches = [...note.body.matchAll(AUTO_HISTORY_LINE_RE)];
      const count = matches.filter((match) => Date.parse(`${match[1]}T00:00:00Z`) > sinceEpoch).length;
      if (count > 0) {
        autoHistoryEntries.push({ slug: noteIndex.slug, count });
      }
    } catch {
      // A single unreadable Note must not block the monthly review block.
    }
  }

  return {
    notes,
    lastCycleSpend: lastCycleSpendTotals.filter((entry): entry is CycleSpendTotal => entry !== null),
    houseRulesBulletCount,
    autoHistoryEntries,
    episodeCount: countEpisodes(dbPath),
    toml,
    now,
  };
}
