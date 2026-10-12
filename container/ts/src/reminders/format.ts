import type { CalendarEventJson, DueTask, TaskJson } from "../google/http.js";
import type { CronJob } from "../cron/store.js";
import { todaysSlots } from "../cron/due.js";

/**
 * The one formatter for calendar events and tasks: Morning Update prefetch, agenda prose,
 * the reminder ticker and the reminders listing all render through here.
 */
export type AgendaEvent = CalendarEventJson & { family?: boolean };

const SGT_OFFSET_MS = 8 * 3_600_000;
export const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function sgtParts(date: Date): { ymd: string; weekday: string; day: number; month: string; time: string } {
  const shifted = new Date(date.getTime() + SGT_OFFSET_MS);
  const iso = shifted.toISOString();
  return {
    ymd: iso.slice(0, 10),
    weekday: WEEKDAYS[shifted.getUTCDay()],
    day: shifted.getUTCDate(),
    month: MONTHS[shifted.getUTCMonth()],
    time: iso.slice(11, 16),
  };
}

export function sgtToday(now = new Date()): string {
  return sgtParts(now).ymd;
}

/** "Fri 3 Oct" for a YYYY-MM-DD day. */
export function dayLabel(ymd: string): string {
  const parts = sgtParts(new Date(`${ymd}T00:00:00+08:00`));
  return `${parts.weekday} ${parts.day} ${parts.month}`;
}

export function isAllDay(event: Pick<CalendarEventJson, "start">): boolean {
  return !event.start.includes("T");
}

/** Epoch ms used to time-sort events; all-day events sort at the start of their SGT day. */
export function eventStartMs(event: Pick<CalendarEventJson, "start">): number {
  return Date.parse(isAllDay(event) ? `${event.start}T00:00:00+08:00` : event.start);
}

export function eventPrefix(event: AgendaEvent): string {
  if (event.family) {
    return "👪 ";
  }
  return event.melvbot === "reminder" ? "⏰ " : "";
}

/** `15:00–16:00`, `15:00` for a reminder, `All day`. */
export function eventWhen(event: AgendaEvent): string {
  if (isAllDay(event)) {
    return "All day";
  }
  const start = sgtParts(new Date(event.start));
  if (event.melvbot === "reminder") {
    return start.time;
  }
  const end = event.end ? sgtParts(new Date(event.end)) : start;
  return end.ymd > start.ymd ? `${start.time}–${dayLabel(end.ymd)} ${end.time}` : `${start.time}–${end.time}`;
}

/** `• 15:00–16:00 Title`, `• All day Title`; family `• 👪 …`, melvbot reminder `• ⏰ …`. */
const PLACE_MAX = 25;

function shortPlace(location: string): string {
  const place = location.trim();
  if (!place) {
    return "";
  }
  return ` · ${place.length > PLACE_MAX ? `${place.slice(0, PLACE_MAX)}…` : place}`;
}

export function formatEventLine(event: AgendaEvent, opts: { withDay?: boolean } = {}): string {
  const day = opts.withDay && !isAllDay(event) ? `${dayLabel(sgtParts(new Date(event.start)).ymd)} ` : opts.withDay ? `${dayLabel(event.start)} ` : "";
  return `• ${eventPrefix(event)}${day}${eventWhen(event)} ${event.summary}${shortPlace(event.location)}`;
}

export function formatEventLines(events: readonly AgendaEvent[], opts: { withDay?: boolean } = {}): string[] {
  return [...events]
    .filter((event) => event.status !== "cancelled")
    .sort((left, right) => eventStartMs(left) - eventStartMs(right))
    .map((event) => formatEventLine(event, opts));
}

function taskDueDay(task: TaskJson): string {
  return task.due.slice(0, 10);
}

/** "today", "overdue 2d" or "due Fri 3 Oct" (nothing without a due date). */
export function taskDueLabel(task: TaskJson, todaySgt: string): string {
  const due = taskDueDay(task);
  if (!due) {
    return "";
  }
  if (due === todaySgt) {
    return "today";
  }
  if (due < todaySgt) {
    const days = Math.round((Date.parse(`${todaySgt}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY_MS);
    return `overdue ${days}d`;
  }
  return `due ${dayLabel(due)}`;
}

export function formatTaskLine(task: TaskJson, todaySgt: string): string {
  const label = taskDueLabel(task, todaySgt);
  return label ? `• ${task.title} · ${label}` : `• ${task.title}`;
}

/** Open tasks, oldest due first, undated last. */
export function sortTasksDueFirst<T extends TaskJson>(tasks: readonly T[]): T[] {
  return tasks
    .filter((task) => task.status !== "completed")
    .sort((left, right) => (taskDueDay(left) || "9999-99-99").localeCompare(taskDueDay(right) || "9999-99-99") || left.title.localeCompare(right.title));
}

export function formatTaskLines(tasks: readonly TaskJson[], todaySgt: string, limit = Infinity): string[] {
  const sorted = sortTasksDueFirst(tasks);
  const lines = sorted.slice(0, limit).map((task) => formatTaskLine(task, todaySgt));
  if (sorted.length > limit) {
    lines.push(`+${sorted.length - limit} more`);
  }
  return lines;
}

/** Open tasks under Overdue / Today / Upcoming / No date headings; empty groups are omitted. */
export function formatTaskGroups(tasks: readonly TaskJson[], todaySgt: string, limit = Infinity): string[] {
  const all = sortTasksDueFirst(tasks);
  const sorted = all.slice(0, limit);
  const groups: [string, TaskJson[]][] = [
    ["Overdue", sorted.filter((task) => taskDueDay(task) && taskDueDay(task) < todaySgt)],
    ["Today", sorted.filter((task) => taskDueDay(task) === todaySgt)],
    ["Upcoming", sorted.filter((task) => taskDueDay(task) > todaySgt)],
    ["No date", sorted.filter((task) => !taskDueDay(task))],
  ];
  const out: string[] = [];
  for (const [title, list] of groups) {
    if (list.length > 0) {
      out.push(...(out.length ? [""] : []), title, ...list.map((task) => formatTaskLine(task, todaySgt)));
    }
  }
  if (all.length > limit) {
    out.push(`+${all.length - limit} more`);
  }
  return out;
}

export function dueTaskLines(tasks: readonly DueTask[]): string[] {
  return tasks.map((task) => `• ${task.title} · ${task.label}`);
}

/** Ticker message for a one-off reminder: `⏰ 15:00 Call the bank`. */
export function reminderAlertText(event: AgendaEvent, missed = false): string {
  const start = sgtParts(new Date(event.start));
  return `⏰ ${start.time} ${event.summary}${missed ? " (missed while offline)" : ""}`;
}

/** Ticker heads-up for an appointment: `📅 in 30 min · 15:00–16:00 Dentist · location`. */
export function eventHeadsUpText(event: AgendaEvent, missed = false): string {
  const place = event.location ? ` · ${event.location}` : "";
  return `📅 ${missed ? "starting" : "in 30 min"} · ${eventWhen(event)} ${event.summary}${place}${missed ? " (missed while offline)" : ""}`;
}

// --- recurring cron jobs in plain words -----------------------------------

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function listNumbers(field: string): number[] | null {
  if (field === "*") {
    return null;
  }
  const values = field.split(",").map((part) => Number(part.trim()));
  return values.every((value) => Number.isInteger(value)) ? values : null;
}

/** Five-field cron (as the agent jobs use) in plain words, e.g. "weekdays at 09:00". */
export function describeSchedule(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return schedule.trim();
  }
  const [minuteF, hourF, domF, monthF, dowF] = parts;
  const minutes = listNumbers(minuteF);
  const hours = listNumbers(hourF);
  const doms = listNumbers(domF);
  const dows = listNumbers(dowF);
  if (monthF !== "*" || (minuteF !== "*" && !minutes) || (hourF !== "*" && !hours) || (domF !== "*" && !doms) || (dowF !== "*" && !dows)) {
    return schedule.trim();
  }
  let when: string;
  if (hours && minutes) {
    when = `at ${hours.flatMap((hour) => minutes.map((minute) => clock(hour, minute))).join(", ")}`;
  } else if (minutes && !hours) {
    when = `every hour at :${String(minutes[0]).padStart(2, "0")}`;
  } else {
    when = "every minute";
  }
  let days = "daily";
  if (dows) {
    const set = [...new Set(dows.map((dow) => dow % 7))].sort();
    if (set.join() === "1,2,3,4,5") {
      days = "weekdays";
    } else if (set.join() === "0,6") {
      days = "weekends";
    } else {
      days = set.map((dow) => WEEKDAY_NAMES[dow]).join(", ");
    }
  } else if (doms) {
    days = `day ${doms.join(", ")} of the month`;
  }
  return `${days} ${when}`;
}

/** Next SGT slot of a cron schedule within the coming 8 days, or null. */
export function nextRun(schedule: string, now = new Date()): Date | null {
  for (let offset = 0; offset <= 8; offset += 1) {
    try {
      const slot = todaysSlots(schedule, new Date(now.getTime() + offset * DAY_MS)).find((candidate) => candidate.getTime() > now.getTime());
      if (slot) {
        return slot;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function formatRecurringLine(job: Pick<CronJob, "name" | "schedule">, now = new Date()): string {
  const next = nextRun(job.schedule, now);
  const nextText = next ? `${dayLabel(sgtParts(next).ymd)} ${sgtParts(next).time}` : "n/a";
  return `• ${job.name} · ${describeSchedule(job.schedule)} · next ${nextText}`;
}

/** The "reminders" listing: Recurring, Upcoming 7 days, Tasks. */
export function formatRemindersReply(input: {
  jobs: readonly Pick<CronJob, "name" | "schedule">[];
  events: readonly AgendaEvent[];
  tasks: readonly TaskJson[];
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const today = sgtToday(now);
  const recurring = input.jobs.map((job) => formatRecurringLine(job, now));
  const upcoming = formatEventLines(input.events, { withDay: true });
  const tasks = formatTaskGroups(input.tasks, today, 25);
  const section = (title: string, lines: string[]) => `${title}\n${lines.length ? lines.join("\n") : "• none"}`;
  return [section("🔁 Recurring", recurring), section("📅 Upcoming 7 days", upcoming), section("✅ Tasks", tasks)].join("\n\n");
}
