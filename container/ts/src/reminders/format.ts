import type { CalendarEventJson, DueTask } from "../google/http.js";

/**
 * The one formatter for calendar events and tasks: Morning Update prefetch and
 * the reminder ticker all render through here.
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
