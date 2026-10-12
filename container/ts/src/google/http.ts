import { googleAccessToken, googleTokenPath } from "./token.js";
import { existsSync } from "node:fs";
import { GOOGLE_FETCH_TIMEOUT_MS } from "./retry.js";

const SGT = "Asia/Singapore";
const REMINDER_DEFAULT_MINUTES = 15;

function eventDateTime(dateTime: string): { dateTime: string; timeZone: string } {
  return { dateTime, timeZone: SGT };
}

/** Tasks store a date only, and the API reads that date from UTC midnight. */
export function taskDueUtcMidnight(due: string): string {
  const trimmed = due.trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (dateOnly) {
    return `${dateOnly[1]}T00:00:00.000Z`;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid task due: ${due}`);
  }
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: SGT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
  return `${day}T00:00:00.000Z`;
}

export { googleTokenPath };

export async function googleTokenPresent(): Promise<boolean> {
  return existsSync(googleTokenPath());
}

async function googleJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const token = await googleAccessToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS) });
  const raw = await response.text();
  const body = raw ? (JSON.parse(raw) as { error?: { message?: string } }) : {};
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Google HTTP ${response.status}`);
  }
  return body;
}

type CalendarEventRaw = {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  extendedProperties?: { private?: Record<string, string> };
};

export type CalendarKind = "reminder" | "event";

export type CalendarEventJson = {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string;
  description: string;
  status: string;
  htmlLink: string;
  /** Set only on events melvbot created (extendedProperties.private.melvbot). */
  melvbot?: CalendarKind;
};

function compactEvent(event: CalendarEventRaw): CalendarEventJson {
  const tag = event.extendedProperties?.private?.melvbot;
  return {
    ...(tag === "reminder" || tag === "event" ? { melvbot: tag } : {}),
    id: String(event.id ?? ""),
    summary: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
    location: event.location ?? "",
    description: event.description ?? "",
    status: event.status ?? "",
    htmlLink: event.htmlLink ?? "",
  };
}

export async function calendarList(
  fromIso: string,
  toIso: string,
  calendarId = "primary",
  maxResults = 25,
  privateExtendedProperty?: string,
  query?: string,
): Promise<CalendarEventJson[]> {
  const params = new URLSearchParams({
    timeMin: fromIso,
    timeMax: toIso,
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (privateExtendedProperty) {
    params.set("privateExtendedProperty", privateExtendedProperty);
  }
  if (query) {
    params.set("q", query);
  }
  const encoded = encodeURIComponent(calendarId);
  const body = (await googleJson(
    `https://www.googleapis.com/calendar/v3/calendars/${encoded}/events?${params}`,
  )) as { items?: CalendarEventRaw[] };
  return (body.items ?? []).map(compactEvent);
}

/** Default end for a reminder created without one: start + 15 min, same SGT wall-clock form. */
export function reminderDefaultEnd(start: string): string {
  const ms = new Date(start).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`invalid start: ${start}`);
  }
  const shifted = new Date(ms + REMINDER_DEFAULT_MINUTES * 60_000 + 8 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export async function calendarCreate(options: {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: string;
  calendarId?: string;
  kind?: CalendarKind;
}): Promise<{ status: string; id: string; summary: string; htmlLink: string }> {
  const calendarId = options.calendarId ?? "primary";
  const event: Record<string, unknown> = {
    summary: options.summary,
    start: eventDateTime(options.start),
    end: eventDateTime(options.end),
    // Telegram is the alert channel (src/reminders/ticker.ts), so no Google popup.
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { melvbot: options.kind ?? "event" } },
  };
  if (options.location) {
    event.location = options.location;
  }
  if (options.description) {
    event.description = options.description;
  }
  if (options.attendees) {
    event.attendees = options.attendees
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  }
  const result = (await googleJson(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: "POST", body: JSON.stringify(event) },
  )) as { id?: string; summary?: string; htmlLink?: string };
  return {
    status: "created",
    id: result.id ?? "",
    summary: result.summary ?? "",
    htmlLink: result.htmlLink ?? "",
  };
}

export async function calendarUpdate(
  eventId: string,
  changes: { summary?: string; start?: string; end?: string; location?: string },
  calendarId = "primary",
): Promise<CalendarEventJson> {
  const patch: Record<string, unknown> = {};
  if (changes.summary !== undefined) {
    patch.summary = changes.summary;
  }
  if (changes.start !== undefined) {
    patch.start = eventDateTime(changes.start);
  }
  if (changes.end !== undefined) {
    patch.end = eventDateTime(changes.end);
  }
  if (changes.location !== undefined) {
    patch.location = changes.location;
  }
  const encoded = encodeURIComponent(calendarId);
  const result = (await googleJson(
    `https://www.googleapis.com/calendar/v3/calendars/${encoded}/events/${encodeURIComponent(eventId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  )) as CalendarEventRaw;
  return compactEvent(result);
}

export async function calendarDelete(eventId: string, calendarId = "primary"): Promise<{ status: string; eventId: string }> {
  await googleJson(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
  return { status: "deleted", eventId };
}

export type TaskJson = {
  id: string;
  title: string;
  status: string;
  due: string;
  completed: string;
  notes: string;
};

export async function tasksList(maxResults = 20, tasklist = "@default"): Promise<TaskJson[]> {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    showCompleted: "false",
  });
  const body = (await googleJson(
    `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks?${params}`,
  )) as {
    items?: Array<{ id?: string; title?: string; status?: string; due?: string; completed?: string; notes?: string }>;
  };
  return (body.items ?? []).map((task) => ({
    id: task.id ?? "",
    title: task.title ?? "(no title)",
    status: task.status ?? "needsAction",
    due: task.due ?? "",
    completed: task.completed ?? "",
    notes: task.notes ?? "",
  }));
}

/** Tasks API has no search: page through the list and keep tasks whose title or notes contain `query` (case-insensitive). */
export async function tasksSearch(
  query: string,
  options: { completed?: boolean; tasklist?: string } = {},
): Promise<TaskJson[]> {
  const needle = query.toLowerCase();
  const found: TaskJson[] = [];
  let pageToken = "";
  for (let page = 0; page < TASKS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      maxResults: String(TASKS_PAGE_SIZE),
      showCompleted: options.completed ? "true" : "false",
    });
    if (options.completed) {
      params.set("showHidden", "true");
    }
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const body = (await googleJson(
      `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(options.tasklist ?? "@default")}/tasks?${params}`,
    )) as { items?: Array<Partial<TaskJson>>; nextPageToken?: string };
    for (const task of body.items ?? []) {
      const title = task.title ?? "(no title)";
      const notes = task.notes ?? "";
      if (`${title}\n${notes}`.toLowerCase().includes(needle)) {
        found.push({
          id: task.id ?? "",
          title,
          status: task.status ?? "needsAction",
          due: task.due ?? "",
          completed: task.completed ?? "",
          notes,
        });
      }
    }
    pageToken = body.nextPageToken ?? "";
    if (!pageToken) {
      break;
    }
  }
  return found;
}

export type DueTask = TaskJson & {
  /** YYYY-MM-DD the task is due. */
  dueDay: string;
  /** Whole days past due; 0 when due today. */
  daysOverdue: number;
  /** "today" or "overdue Nd". */
  label: string;
};

const TASKS_PAGE_SIZE = 100;
const TASKS_MAX_PAGES = 10;
const DAY_MS = 86_400_000;

/** Open tasks on @default due today or earlier (todaySgt = YYYY-MM-DD), oldest due first. */
export async function tasksDueOrOverdue(todaySgt: string, tasklist = "@default"): Promise<DueTask[]> {
  const all: TaskJson[] = [];
  let pageToken = "";
  for (let page = 0; page < TASKS_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      maxResults: String(TASKS_PAGE_SIZE),
      showCompleted: "false",
      dueMax: `${todaySgt}T23:59:59.000Z`,
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }
    const body = (await googleJson(
      `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks?${params}`,
    )) as { items?: Array<Partial<TaskJson>>; nextPageToken?: string };
    for (const task of body.items ?? []) {
      all.push({
        id: task.id ?? "",
        title: task.title ?? "(no title)",
        status: task.status ?? "needsAction",
        due: task.due ?? "",
        completed: task.completed ?? "",
        notes: task.notes ?? "",
      });
    }
    pageToken = body.nextPageToken ?? "";
    if (!pageToken) {
      break;
    }
  }
  const todayMs = Date.parse(`${todaySgt}T00:00:00Z`);
  return all
    .filter((task) => task.status !== "completed" && task.due.length >= 10)
    .map((task) => {
      const dueDay = task.due.slice(0, 10);
      const daysOverdue = Math.max(0, Math.round((todayMs - Date.parse(`${dueDay}T00:00:00Z`)) / DAY_MS));
      return { ...task, dueDay, daysOverdue, label: daysOverdue > 0 ? `overdue ${daysOverdue}d` : "today" };
    })
    .filter((task) => task.dueDay <= todaySgt)
    .sort((left, right) => left.dueDay.localeCompare(right.dueDay) || left.title.localeCompare(right.title));
}

export async function tasksCreate(options: {
  title: string;
  due?: string;
  notes?: string;
  tasklist?: string;
}): Promise<{ status: string; id: string; title: string }> {
  const tasklist = options.tasklist ?? "@default";
  const body: Record<string, string> = { title: options.title };
  if (options.due) {
    body.due = taskDueUtcMidnight(options.due);
  }
  if (options.notes) {
    body.notes = options.notes;
  }
  const result = (await googleJson(
    `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks`,
    { method: "POST", body: JSON.stringify(body) },
  )) as { id?: string; title?: string };
  return { status: "created", id: result.id ?? "", title: result.title ?? "" };
}

export async function tasksUpdate(
  taskId: string,
  changes: { title?: string; due?: string; notes?: string },
  tasklist = "@default",
): Promise<{ status: string; id: string; title: string }> {
  const patch: Record<string, string> = {};
  if (changes.title !== undefined) {
    patch.title = changes.title;
  }
  if (changes.due !== undefined) {
    patch.due = taskDueUtcMidnight(changes.due);
  }
  if (changes.notes !== undefined) {
    patch.notes = changes.notes;
  }
  const result = (await googleJson(
    `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  )) as { id?: string; title?: string };
  return { status: "updated", id: result.id ?? "", title: result.title ?? "" };
}

export async function tasksComplete(
  taskId: string,
  tasklist = "@default",
): Promise<{ status: string; id: string; title: string }> {
  const existing = (await googleJson(
    `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(taskId)}`,
  )) as Record<string, unknown>;
  existing.status = "completed";
  const result = (await googleJson(
    `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PUT", body: JSON.stringify(existing) },
  )) as { id?: string; title?: string };
  return { status: "completed", id: result.id ?? "", title: result.title ?? "" };
}

export async function tasksDelete(taskId: string, tasklist = "@default"): Promise<{ status: string; taskId: string }> {
  await googleJson(
    `https://www.googleapis.com/tasks/v1/lists/${encodeURIComponent(tasklist)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE" },
  );
  return { status: "deleted", taskId };
}
