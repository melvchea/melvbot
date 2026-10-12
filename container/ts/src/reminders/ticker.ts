import { calendarList, tasksDueOrOverdue, type CalendarEventJson, type DueTask } from "../google/http.js";
import { loadNudgesToml } from "../nudges/toml.js";
import { configuredHomeChatId } from "../telegram/home_chat.js";
import type { TelegramApi } from "../telegram/api.js";
import { reminderKeyboard, taskButtonRows } from "./callbacks.js";
import { dueTaskLines, eventHeadsUpText, reminderAlertText, sgtParts, sgtToday } from "./format.js";
import { isAlertSent, isSweepSent, markAlertSent, markSweepSent, pruneAlerts } from "./store.js";

/**
 * Google stores, Telegram alerts: tagged calendar events (extendedProperties.private.melvbot)
 * are fetched every 5 min and alerted from cache every 60 s; the 19:15 SGT task sweep rides along.
 */
export const REFRESH_MS = 5 * 60_000;
export const TICK_MS = 60_000;
export const WINDOW_BEFORE_MS = 6 * 3_600_000;
export const WINDOW_AFTER_MS = 40 * 60_000;
export const EVENT_LEAD_MS = 30 * 60_000;
export const CATCH_UP_MS = 6 * 3_600_000;
export const SWEEP_START_MINUTE = 19 * 60 + 15;
export const SWEEP_END_MINUTE = 21 * 60;
const SWEEP_RETRY_MS = 5 * 60_000;

export type DueAlert = {
  event: CalendarEventJson;
  kind: "reminder" | "event";
  alertAt: number;
  missed: boolean;
};

/** When an event alerts: the start for a reminder, 30 min before for an appointment. */
export function alertTime(event: CalendarEventJson): number | null {
  if (!event.start.includes("T") || (event.melvbot !== "reminder" && event.melvbot !== "event")) {
    return null;
  }
  const start = Date.parse(event.start);
  if (Number.isNaN(start)) {
    return null;
  }
  return event.melvbot === "reminder" ? start : start - EVENT_LEAD_MS;
}

/**
 * Alerts that should fire now: alertAt reached, not sent, not older than the catch-up window.
 * `missed` marks alerts whose time passed before this process booted.
 */
export function selectDueAlerts(
  events: readonly CalendarEventJson[],
  now: number,
  bootMs: number,
  isSent: (eventId: string, startIso: string) => boolean,
): DueAlert[] {
  const due: DueAlert[] = [];
  for (const event of events) {
    const alertAt = alertTime(event);
    if (alertAt === null || event.status === "cancelled" || alertAt > now || now - alertAt > CATCH_UP_MS) {
      continue;
    }
    const kind = event.melvbot === "reminder" ? "reminder" : "event";
    if (kind === "event" && Date.parse(event.end || event.start) <= now) {
      continue; // appointment already over; a heads-up is pointless
    }
    if (isSent(event.id, event.start)) {
      continue;
    }
    due.push({ event, kind, alertAt, missed: alertAt < bootMs });
  }
  return due.sort((left, right) => left.alertAt - right.alertAt);
}

export type TickerDeps = {
  api: Pick<TelegramApi, "sendMessage">;
  chatId: number;
  now: () => Date;
  list: (fromIso: string, toIso: string) => Promise<CalendarEventJson[]>;
  dueTasks: (todaySgt: string) => Promise<DueTask[]>;
  taskEveningEnabled: () => boolean;
  dbPath?: string;
};

export type TickerState = {
  bootMs: number;
  cache: CalendarEventJson[];
  lastSweepAttempt: number;
};

export function newTickerState(bootMs = Date.now()): TickerState {
  return { bootMs, cache: [], lastSweepAttempt: 0 };
}

export async function refreshEvents(deps: TickerDeps, state: TickerState): Promise<void> {
  const now = deps.now().getTime();
  const events = await deps.list(new Date(now - WINDOW_BEFORE_MS).toISOString(), new Date(now + WINDOW_AFTER_MS).toISOString());
  state.cache = events.filter((event) => event.melvbot !== undefined);
}

/** Moves one cached event after a Snooze so the next tick sees the new time. */
export function patchCachedEvent(state: TickerState, moved: CalendarEventJson): void {
  state.cache = [...state.cache.filter((event) => event.id !== moved.id), moved];
}

export async function tickAlerts(deps: TickerDeps, state: TickerState): Promise<number> {
  const now = deps.now();
  let sent = 0;
  for (const alert of selectDueAlerts(state.cache, now.getTime(), state.bootMs, (id, start) => isAlertSent(id, start, deps.dbPath))) {
    const { event } = alert;
    try {
      if (alert.kind === "reminder") {
        await deps.api.sendMessage(deps.chatId, reminderAlertText(event, alert.missed), { reply_markup: reminderKeyboard(event.id) });
      } else {
        await deps.api.sendMessage(deps.chatId, eventHeadsUpText(event, alert.missed));
      }
    } catch (error) {
      console.error("reminder_alert_failed", error instanceof Error ? error.message : String(error));
      continue; // not marked sent, so the next tick retries
    }
    markAlertSent(event.id, event.start, now, deps.dbPath);
    sent += 1;
  }
  return sent;
}

/** 19:15 SGT: "Still open today:" with task buttons, once per date; silent when nothing is open. */
export async function tickTaskSweep(deps: TickerDeps, state: TickerState): Promise<boolean> {
  const now = deps.now();
  const time = sgtParts(now).time;
  const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  if (minute < SWEEP_START_MINUTE || minute >= SWEEP_END_MINUTE || !deps.taskEveningEnabled()) {
    return false;
  }
  const day = sgtToday(now);
  if (isSweepSent(day, deps.dbPath) || now.getTime() - state.lastSweepAttempt < SWEEP_RETRY_MS) {
    return false;
  }
  state.lastSweepAttempt = now.getTime();
  const tasks = await deps.dueTasks(day);
  if (tasks.length > 0) {
    await deps.api.sendMessage(deps.chatId, `Still open today:\n${dueTaskLines(tasks).join("\n")}`, {
      reply_markup: { inline_keyboard: taskButtonRows(tasks) },
    });
  }
  markSweepSent(day, now, deps.dbPath);
  return tasks.length > 0;
}

// --- daemon wiring --------------------------------------------------------

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let state: TickerState | undefined;
let busy = false;
let liveDeps: TickerDeps | undefined;
let refreshRequested: ReturnType<typeof setTimeout> | undefined;
export const REFRESH_DEBOUNCE_MS = 2_000;

/** Debounced refresh + tick on the live ticker; no-op when it is not started. */
export function requestReminderRefresh(debounceMs = REFRESH_DEBOUNCE_MS, run?: () => Promise<void>): void {
  if (!state || !liveDeps || refreshRequested) {
    return;
  }
  const current = state;
  const deps = liveDeps;
  refreshRequested = setTimeout(() => {
    refreshRequested = undefined;
    void (run ?? (async () => {
      await refreshEvents(deps, current);
      await tickAlerts(deps, current);
    }))().catch((error) => console.error("reminder_refresh_failed", error instanceof Error ? error.message : String(error)));
  }, debounceMs);
  refreshRequested.unref();
}

export function reminderTickerState(): TickerState | undefined {
  return state;
}

export function startReminderTicker(api: Pick<TelegramApi, "sendMessage">, chatId = configuredHomeChatId()): void {
  if (refreshTimer || chatId === null) {
    return;
  }
  const deps: TickerDeps = {
    api,
    chatId,
    now: () => new Date(),
    list: (from, to) => calendarList(from, to, "primary", 100),
    dueTasks: tasksDueOrOverdue,
    taskEveningEnabled: () => loadNudgesToml().taskEvening,
  };
  const current = newTickerState();
  state = current;
  liveDeps = deps;
  const refresh = async (): Promise<void> => {
    try {
      await refreshEvents(deps, current);
    } catch (error) {
      console.error("reminder_refresh_failed", error instanceof Error ? error.message : String(error));
    }
  };
  const tick = async (): Promise<void> => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      await tickAlerts(deps, current);
      await tickTaskSweep(deps, current);
    } catch (error) {
      console.error("reminder_tick_failed", error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  };
  try {
    pruneAlerts();
  } catch (error) {
    console.error("reminder_prune_failed", error instanceof Error ? error.message : String(error));
  }
  void refresh().then(tick);
  refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
  tickTimer = setInterval(() => void tick(), TICK_MS);
  refreshTimer.unref();
  tickTimer.unref();
}

export function stopReminderTicker(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
  if (refreshRequested) {
    clearTimeout(refreshRequested);
    refreshRequested = undefined;
  }
  state = undefined;
  liveDeps = undefined;
}
