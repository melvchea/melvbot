import { calendarList } from "../google/http.js";
import { loadProfile } from "../profile.js";
import { eventStartMs, type AgendaEvent } from "./format.js";

/** Env wins; else profile.toml `family_calendar_id`; empty means no family calendar. */
export function familyCalendarId(): string {
  return process.env.FAMILY_CALENDAR_ID || loadProfile().family_calendar_id || "";
}

export type CalendarLister = typeof calendarList;

/** Primary + family calendars merged and time-sorted; family events carry `family: true`. */
export async function listMergedAgenda(
  fromIso: string,
  toIso: string,
  max = 50,
  list: CalendarLister = calendarList,
  query?: string,
): Promise<AgendaEvent[]> {
  // Extra args only when searching, so plain calls keep the original lister signature.
  const extra: [undefined, string] | [] = query ? [undefined, query] : [];
  const familyId = familyCalendarId();
  const [primary, family] = await Promise.all([
    list(fromIso, toIso, "primary", max, ...extra),
    familyId ? list(fromIso, toIso, familyId, max, ...extra) : Promise.resolve([]),
  ]);
  const merged: AgendaEvent[] = [...primary, ...family.map((event) => ({ ...event, family: true }))];
  return merged.sort((left, right) => eventStartMs(left) - eventStartMs(right));
}
