import { calendarUpdate, tasksComplete, tasksUpdate, type CalendarEventJson, type DueTask } from "../google/http.js";
import type { CallbackKeyboard } from "../nudges/callbacks.js";
import { clearAlerts, markAlertDone } from "./store.js";
import { DAY_MS, sgtParts, sgtToday } from "./format.js";

export const REMINDER_PREFIX = "rm:";
export const TASK_PREFIX = "tk:";
export const REMINDER_DEFAULT_MINUTES = 15;
const TASK_BUTTON_LIMIT = 6;
const SHORT_TITLE_MAX = 18;

export type ReminderCallback = { action: "done" } | { action: "snooze"; minutes: number };
export type TaskCallback = { action: "complete" | "tomorrow"; taskId: string } | { action: "noop" };

// --- reminders (rm:) ------------------------------------------------------

export function encodeReminderDone(eventId: string): string {
  return `${REMINDER_PREFIX}d|${eventId}`;
}

export function encodeReminderSnooze(eventId: string, minutes: number): string {
  return `${REMINDER_PREFIX}s|${eventId}|${minutes}`;
}

export function reminderKeyboard(eventId: string): CallbackKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "Done", callback_data: encodeReminderDone(eventId) },
        { text: "Snooze 10m", callback_data: encodeReminderSnooze(eventId, 10) },
        { text: "Snooze 1h", callback_data: encodeReminderSnooze(eventId, 60) },
      ],
    ],
  };
}

/** Parses the part after `rm:`: `d|<eventId>` or `s|<eventId>|<minutes>`. */
export function parseReminderCallback(data: string): ({ eventId: string } & ReminderCallback) | null {
  const parts = data.split("|");
  const [action, eventId, minutes] = parts;
  if (!eventId) {
    return null;
  }
  if (action === "d" && parts.length === 2) {
    return { action: "done", eventId };
  }
  const mins = Number(minutes);
  if (action === "s" && parts.length === 3 && Number.isInteger(mins) && mins > 0 && mins <= 24 * 60) {
    return { action: "snooze", eventId, minutes: mins };
  }
  return null;
}

/** SGT wall-clock ISO (`2026-10-02T15:00:00+08:00`) for an instant. */
export function toSgtIso(ms: number): string {
  return `${new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`;
}

export type ReminderCallbackDeps = {
  update: typeof calendarUpdate;
  now: () => Date;
  dbPath?: string;
};

export type ReminderCallbackResult = {
  /** New message text (the buttons go away with it). */
  text: string;
  /** Set on a snooze so the ticker cache can follow the moved event. */
  moved?: CalendarEventJson;
};

/** `text` is the original alert text, so the edit keeps the reminder's title. */
export async function applyReminderCallback(
  parsed: { eventId: string } & ReminderCallback,
  originalText: string,
  deps: Partial<ReminderCallbackDeps> = {},
): Promise<ReminderCallbackResult> {
  const update = deps.update ?? calendarUpdate;
  const now = deps.now?.() ?? new Date();
  const body = originalText.replace(/^[^\s]+\s/, "");
  if (parsed.action === "done") {
    markAlertDone(parsed.eventId, deps.dbPath);
    return { text: `✅ ${body}` };
  }
  const startMs = now.getTime() + parsed.minutes * 60_000;
  const moved = await update(parsed.eventId, {
    start: toSgtIso(startMs),
    end: toSgtIso(startMs + REMINDER_DEFAULT_MINUTES * 60_000),
  });
  clearAlerts(parsed.eventId, deps.dbPath);
  return { text: `💤 snoozed to ${sgtParts(new Date(startMs)).time}`, moved };
}

// --- tasks (tk:) ----------------------------------------------------------

export function shortTitle(title: string, max = SHORT_TITLE_MAX): string {
  const clean = title.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export function encodeTaskCallback(action: "c" | "t", taskId: string): string {
  return `${TASK_PREFIX}${action}|${taskId}`;
}

/** Rows of [✓ title] [→ Tomorrow] for up to 6 tasks. */
export function taskButtonRows(tasks: readonly Pick<DueTask, "id" | "title">[]): CallbackKeyboard["inline_keyboard"] {
  return tasks.slice(0, TASK_BUTTON_LIMIT).map((task) => [
    { text: `✓ ${shortTitle(task.title)}`, callback_data: encodeTaskCallback("c", task.id) },
    { text: "→ Tomorrow", callback_data: encodeTaskCallback("t", task.id) },
  ]);
}

export const TASK_NOOP_DATA = `${TASK_PREFIX}n`;

/** Parses the part after `tk:`. */
export function parseTaskCallback(data: string): TaskCallback | null {
  if (data === "n") {
    return { action: "noop" };
  }
  const [action, taskId, ...rest] = data.split("|");
  if (!taskId || rest.length > 0) {
    return null;
  }
  if (action === "c") {
    return { action: "complete", taskId };
  }
  if (action === "t") {
    return { action: "tomorrow", taskId };
  }
  return null;
}

export function tomorrowSgt(now = new Date()): string {
  return sgtToday(new Date(now.getTime() + DAY_MS));
}

export type TaskCallbackDeps = {
  complete: typeof tasksComplete;
  update: typeof tasksUpdate;
  now: () => Date;
};

/** Runs the Google write and returns the replacement row for the tapped task. */
export async function applyTaskCallback(
  parsed: Exclude<TaskCallback, { action: "noop" }>,
  keyboardRowTitle: string,
  deps: Partial<TaskCallbackDeps> = {},
): Promise<{ row: { text: string; callback_data: string }[]; toast: string }> {
  const title = keyboardRowTitle.replace(/^✓\s*/, "");
  if (parsed.action === "complete") {
    await (deps.complete ?? tasksComplete)(parsed.taskId);
    return { row: [{ text: `✅ ${title}`, callback_data: TASK_NOOP_DATA }], toast: "Done." };
  }
  const due = tomorrowSgt(deps.now?.());
  await (deps.update ?? tasksUpdate)(parsed.taskId, { due });
  return { row: [{ text: `→ ${title} · ${due}`, callback_data: TASK_NOOP_DATA }], toast: "Moved to tomorrow." };
}

/** The keyboard with the tapped task's row swapped for `row`. */
export function replaceTaskRow(
  keyboard: CallbackKeyboard["inline_keyboard"],
  taskId: string,
  row: { text: string; callback_data: string }[],
): CallbackKeyboard["inline_keyboard"] {
  return keyboard.map((existing) =>
    existing.some((button) => button.callback_data.startsWith(TASK_PREFIX) && button.callback_data.endsWith(`|${taskId}`)) ? row : existing,
  );
}
