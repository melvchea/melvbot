import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { type DueTask, type TaskJson } from "../src/google/http.js";
import {
  applyReminderCallback,
  reminderKeyboard,
} from "../src/reminders/callbacks.js";
import {
  type AgendaEvent,
} from "../src/reminders/format.js";
import { isAlertSent, markAlertSent } from "../src/reminders/store.js";
import {
  alertTime,
  newTickerState,
  patchCachedEvent,
  selectDueAlerts,
  tickAlerts,
  tickTaskSweep,
  type TickerDeps,
} from "../src/reminders/ticker.js";
import { parseNudgesSection } from "../src/nudges/toml.js";
import { tempDir } from "./helpers/temp.js";

const tmp = tempDir("reminders-");
const DB = path.join(tmp, "nudges.sqlite3");
const home = path.join(tmp, "google-home");
process.env.MELVBOT_GOOGLE_HOME = home;
mkdirSync(home, { recursive: true });
writeFileSync(path.join(home, "google_token.json"), JSON.stringify({ token: "t", expiry_date: Date.now() + 3_600_000 * 24 }));

const ev = (over: Partial<AgendaEvent>): AgendaEvent => ({
  id: "e1",
  summary: "Event",
  start: "2026-10-02T15:00:00+08:00",
  end: "2026-10-02T16:00:00+08:00",
  location: "",
  description: "",
  status: "confirmed",
  htmlLink: "",
  ...over,
});
const at = (iso: string) => Date.parse(iso);

const task = (title: string, due: string, id = title): TaskJson => ({ id, title, status: "needsAction", due, completed: "", notes: "" });

test("selectDueAlerts: fires once due, dedupes, honours the 6h catch-up window and marks missed", () => {
  const boot = at("2026-10-02T14:00:00+08:00");
  const events = [ev({ id: "r", melvbot: "reminder" }), ev({ id: "a", melvbot: "event" })];
  const none = () => false;
  assert.deepEqual(selectDueAlerts(events, at("2026-10-02T14:29:00+08:00"), boot, none), []);
  const first = selectDueAlerts(events, at("2026-10-02T14:31:00+08:00"), boot, none);
  assert.deepEqual(first.map((a) => [a.event.id, a.kind, a.missed]), [["a", "event", false]]);
  const both = selectDueAlerts(events, at("2026-10-02T15:00:30+08:00"), boot, (id) => id === "a");
  assert.deepEqual(both.map((a) => a.event.id), ["r"]);
  // Boot after the alert time: catch-up flagged as missed.
  const late = selectDueAlerts([ev({ id: "r", melvbot: "reminder" })], at("2026-10-02T18:00:00+08:00"), at("2026-10-02T17:59:00+08:00"), none);
  assert.deepEqual(late.map((a) => a.missed), [true]);
  // Older than 6h: skipped.
  assert.deepEqual(selectDueAlerts([ev({ melvbot: "reminder" })], at("2026-10-02T21:01:00+08:00"), boot, none), []);
  // Appointment already over: no heads-up.
  assert.deepEqual(selectDueAlerts([ev({ melvbot: "event" })], at("2026-10-02T16:01:00+08:00"), boot, none), []);
});

function fakeDeps(over: Partial<TickerDeps> & { now: Date }): { deps: TickerDeps; sent: { text: string; extra?: Record<string, unknown> }[] } {
  const sent: { text: string; extra?: Record<string, unknown> }[] = [];
  const deps: TickerDeps = {
    api: { sendMessage: async (_c: number, text: string, extra?: Record<string, unknown>) => void sent.push({ text, extra }) },
    chatId: 1,
    list: async () => [],
    dueTasks: async () => [],
    taskEveningEnabled: () => true,
    dbPath: DB,
    ...over,
    now: () => over.now,
  };
  return { deps, sent };
}

test("tickAlerts sends reminder buttons once, heads-up without buttons, and snooze re-arms", async () => {
  const state = newTickerState(at("2026-10-02T09:00:00+08:00"));
  state.cache = [ev({ id: "rem1", melvbot: "reminder", summary: "Call bank" }), ev({ id: "app1", melvbot: "event", summary: "Dentist" })];
  const { deps, sent } = fakeDeps({ now: new Date("2026-10-02T15:00:10+08:00") });
  assert.equal(await tickAlerts(deps, state), 2);
  assert.equal(await tickAlerts(deps, state), 0);
  assert.equal(sent[0].text.startsWith("📅 in 30 min"), true);
  assert.equal(sent[0].extra, undefined);
  assert.equal(sent[1].text, "⏰ 15:00 Call bank");
  assert.deepEqual(sent[1].extra?.reply_markup, reminderKeyboard("rem1"));
  assert.equal(isAlertSent("rem1", "2026-10-02T15:00:00+08:00", DB), true);

  // Snooze 10m: Google patched, old flag cleared, cache follows, alert fires again at the new time.
  const patched: unknown[] = [];
  const result = await applyReminderCallback(
    { action: "snooze", eventId: "rem1", minutes: 10 },
    "⏰ 15:00 Call bank",
    {
      now: () => new Date("2026-10-02T15:01:00+08:00"),
      dbPath: DB,
      update: (async (id: string, changes: unknown) => {
        patched.push([id, changes]);
        return ev({ id: "rem1", melvbot: "reminder", summary: "Call bank", start: "2026-10-02T15:11:00+08:00", end: "2026-10-02T15:26:00+08:00" });
      }) as never,
    },
  );
  assert.deepEqual(patched, [["rem1", { start: "2026-10-02T15:11:00+08:00", end: "2026-10-02T15:26:00+08:00" }]]);
  assert.equal(result.text, "💤 snoozed to 15:11");
  assert.equal(isAlertSent("rem1", "2026-10-02T15:00:00+08:00", DB), false);
  patchCachedEvent(state, result.moved!);
  assert.equal(await tickAlerts(fakeDeps({ now: new Date("2026-10-02T15:10:00+08:00") }).deps, state), 0);
  const again = fakeDeps({ now: new Date("2026-10-02T15:11:05+08:00") });
  assert.equal(await tickAlerts(again.deps, state), 1);
  assert.equal(again.sent[0].text, "⏰ 15:11 Call bank");
});

test("evening sweep: only at 19:15-21:00 SGT, once per date, silent when nothing is due, gated by toml", async () => {
  const due: DueTask[] = [{ ...task("Pay rent", "2026-10-02T00:00:00.000Z", "t1"), dueDay: "2026-10-02", daysOverdue: 0, label: "today" }];
  const state = newTickerState();
  const early = fakeDeps({ now: new Date("2026-10-02T19:05:00+08:00"), dueTasks: async () => due });
  assert.equal(await tickTaskSweep(early.deps, state), false);
  const evening = fakeDeps({ now: new Date("2026-10-02T19:16:00+08:00"), dueTasks: async () => due });
  assert.equal(await tickTaskSweep(evening.deps, state), true);
  assert.equal(evening.sent[0].text, "Still open today:\n• Pay rent · today");
  assert.equal(await tickTaskSweep(fakeDeps({ now: new Date("2026-10-02T19:10:00+08:00"), dueTasks: async () => due }).deps, state), false);
  const empty = fakeDeps({ now: new Date("2026-10-03T19:20:00+08:00"), dueTasks: async () => [] });
  assert.equal(await tickTaskSweep(empty.deps, newTickerState()), false);
  assert.equal(empty.sent.length, 0);
  const off = fakeDeps({ now: new Date("2026-10-04T19:20:00+08:00"), dueTasks: async () => due, taskEveningEnabled: () => false });
  assert.equal(await tickTaskSweep(off.deps, newTickerState()), false);
  assert.equal(parseNudgesSection("[nudges]\ntask_evening = false\n").taskEvening, false);
  assert.equal(parseNudgesSection("").taskEvening, true);
});
