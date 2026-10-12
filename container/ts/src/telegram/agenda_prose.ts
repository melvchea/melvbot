import type { TaskJson } from "../google/http.js";
import { DAY_MS, dayLabel, eventStartMs, formatEventLine, formatTaskGroups, isAllDay, sgtParts, sgtToday, type AgendaEvent } from "../reminders/format.js";
import { soleNonemptyLineStripped } from "./prose_line.js";

/**
 * Whole-message "calendar" / "tasks" phrasings answered straight from Google, with no model turn:
 * the read is deterministic, so it should cost no Claude quota and no latency.
 */
export type CalendarRange = "today" | "tomorrow" | "week";
export type AgendaIntent = { kind: "calendar"; range: CalendarRange } | { kind: "tasks" };

const CALENDAR_RE =
  /^(?:(?:what(?:'s|s| is)|show(?: me)?|check|any|list) )?(?:(?:on|in) )?(?:my |the )?(?:(?<pre>today's|todays|tomorrow's|tomorrows|this week's|weekly) )?(?:calendar|schedule|agenda|events?)(?: (?:for )?(?<post>today|tomorrow|this week|the week|week))?$/;
const WHATS_ON_RE = /^what(?:'s|s| is) on (?:my calendar )?(?<when>today|tomorrow|this week)$/;
const TASKS_RE =
  /^(?:(?:show|check|list)(?: me)?(?: my)? |my |what(?:'s|s| is) on my )?(?:tasks?|to-?dos?|task list|to-?do list)$/;

function rangeFrom(word: string | undefined): CalendarRange {
  if (!word) {
    return "today";
  }
  if (word.startsWith("tomorrow")) {
    return "tomorrow";
  }
  if (word.includes("week")) {
    return "week";
  }
  return "today";
}

export function matchAgendaProse(text: string): AgendaIntent | null {
  const line = soleNonemptyLineStripped(text)?.toLowerCase();
  if (!line) {
    return null;
  }
  if (TASKS_RE.test(line)) {
    return { kind: "tasks" };
  }
  const whatsOn = WHATS_ON_RE.exec(line);
  if (whatsOn) {
    return { kind: "calendar", range: rangeFrom(whatsOn.groups?.when) };
  }
  const calendar = CALENDAR_RE.exec(line);
  if (calendar) {
    return { kind: "calendar", range: rangeFrom(calendar.groups?.post ?? calendar.groups?.pre) };
  }
  return null;
}

/** Window in SGT: [start, end) as ISO strings with +08:00 offsets, plus the first day (YYYY-MM-DD). */
export function calendarWindow(range: CalendarRange, now = new Date()): { start: string; end: string; firstDay: string } {
  const today = sgtParts(now).ymd;
  const startDay = range === "tomorrow" ? sgtParts(new Date(new Date(`${today}T00:00:00+08:00`).getTime() + DAY_MS)).ymd : today;
  const days = range === "week" ? 7 : 1;
  const endDay = sgtParts(new Date(new Date(`${startDay}T00:00:00+08:00`).getTime() + days * DAY_MS)).ymd;
  return { start: `${startDay}T00:00:00+08:00`, end: `${endDay}T00:00:00+08:00`, firstDay: startDay };
}

function rangeTitle(range: CalendarRange): string {
  return range === "week" ? "next 7 days" : range;
}

export function formatCalendarReply(events: readonly AgendaEvent[], range: CalendarRange, firstDay: string): string {
  const live = events.filter((event) => event.status !== "cancelled");
  if (live.length === 0) {
    return `Nothing on your calendar (${rangeTitle(range)}).`;
  }
  const perDay = new Map<string, AgendaEvent[]>();
  for (const event of live) {
    const startDay = isAllDay(event) ? event.start : sgtParts(new Date(event.start)).ymd;
    const day = startDay < firstDay ? firstDay : startDay;
    perDay.set(day, [...(perDay.get(day) ?? []), event]);
  }
  const sections = [...perDay.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([day, list]) => {
      const sorted = [...list].sort((left, right) => eventStartMs(left) - eventStartMs(right));
      return `${dayLabel(day)}\n${sorted.map((event) => formatEventLine(event)).join("\n")}`;
    });
  return [`📅 Calendar (${rangeTitle(range)})`, ...sections].join("\n\n");
}

const TASKS_SHOWN = 25;

export function formatTasksReply(tasks: readonly TaskJson[], now = new Date()): string {
  const lines = formatTaskGroups(tasks, sgtToday(now), TASKS_SHOWN);
  return lines.length === 0 ? "No open tasks." : ["✅ Tasks", "", ...lines].join("\n");
}
