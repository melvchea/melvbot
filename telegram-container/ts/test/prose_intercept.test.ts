import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

import type { CalendarEventJson, TaskJson } from "../src/google/http.js";
import { tempDir } from "./helpers/temp.js";
import { mockApi, type Media, type Sent } from "./helpers/telegram_api.js";

await register(new URL("./resolve_ts.mjs", import.meta.url));

const { dispatchProseIntercept, wouldDispatchProseIntercept } = await import(
  "../src/telegram/prose_intercept.js"
);

const msg = { message_id: 1, chat: { id: 42 }, from: { id: 7 } };

const event = (over: Partial<CalendarEventJson>): CalendarEventJson => ({
  id: "1",
  summary: "Event",
  start: "",
  end: "",
  location: "",
  description: "",
  status: "confirmed",
  htmlLink: "",
  ...over,
});

const task = (title: string, due: string, status = "needsAction"): TaskJson => ({ id: title, title, status, due, completed: "", notes: "" });

function seedToml(root: string): string {
  const tomlPath = path.join(root, "melvbot.toml");
  writeFileSync(
    tomlPath,
    `[sheets]
owner1_spreadsheet_id = "sheet-m"
owner2_spreadsheet_id = "sheet-c"
ev_spreadsheet_id = "sheet-b"

[notes]
`,
  );
  return tomlPath;
}

test("dispatchProseIntercept does not hijack note or sheet rename phrases", async () => {
  const tomlPath = seedToml(tempDir("melvbot-prose-rename-miss-"));
  process.env.MELVBOT_TOML = tomlPath;
  const sent: Sent[] = [];
  const api = mockApi({ sent });
  assert.equal(await wouldDispatchProseIntercept("rename note x to tasks"), true);
  const deps = {};
  assert.equal(
    await dispatchProseIntercept(api as never, msg as never, "rename sheet Budget to Budget 2026", deps),
    false,
  );
  assert.equal(
    await dispatchProseIntercept(
      api as never,
      msg as never,
      "rename note phone-buy to Camera shortlist",
      deps,
    ),
    true,
  );
  assert.equal(sent.at(-1)?.text, "No matching Note.");
});

test("dispatchProseIntercept answers calendar and tasks without a model turn, and reports fetch failures", async () => {
  const sent: Sent[] = [];
  const api = mockApi({ sent });
  let window: [string, string] | null = null;
  const handled = await dispatchProseIntercept(api as never, msg as never, "what's on tomorrow", {
    listEvents: async (start, end) => {
      window = [start, end];
      return [event({ summary: "Dentist", start: "2026-10-04T15:00:00+08:00", end: "2026-10-04T16:00:00+08:00" })];
    },
  });
  assert.equal(handled, true);
  assert.ok(window !== null);
  assert.match(sent[0].text, /• 15:00–16:00 Dentist/);

  assert.equal(await dispatchProseIntercept(api as never, msg as never, "tasks", { listTasks: async () => [task("Pay rent", "")] }), true);
  assert.match(sent[1].text, /• Pay rent/);

  assert.equal(await dispatchProseIntercept(api as never, msg as never, "calendar", { listEvents: async () => Promise.reject(new Error("no token")) }), true);
  assert.equal(sent[2].text, "Could not fetch your calendar.");
  assert.equal(await dispatchProseIntercept(api as never, msg as never, "tasks", { listTasks: async () => Promise.reject(new Error("x")) }), true);
  assert.equal(sent[3].text, "Could not fetch your tasks.");
});

test("reminder lookup answers a matching reminder and falls through to Claude on no match", async () => {
  const sent: Sent[] = [];
  const api = mockApi({ sent });
  const deps = {
    listEvents: async () => [event({ summary: "Cancel Whizcomms and return router", start: "2026-10-20T09:00:00+08:00", end: "2026-10-20T09:15:00+08:00" })],
    listTasks: async () => [],
    listJobs: () => [],
  };
  assert.equal(await dispatchProseIntercept(api as never, msg as never, "when is reminder to cancel Whizcomms and return...", deps), true);
  assert.match(sent[0].text, /Cancel Whizcomms and return router/);
  assert.equal(await dispatchProseIntercept(api as never, msg as never, "when is my reminder about dentist?", deps), false);
  assert.equal(sent.length, 1);
});

test("an intercepted exchange is handed to the next Claude turn once, so follow-ups keep context", async () => {
  const { takeInterceptContext } = await import("../src/telegram/intercept_context.js");
  const sent: Sent[] = [];
  const api = mockApi({ sent });
  const other = { message_id: 2, chat: { id: 43 }, from: { id: 7 } };
  await dispatchProseIntercept(api as never, other as never, "tasks", { listTasks: async () => [task("Pay rent", "")] });
  assert.match(sent[0].text, /• Pay rent/);
  assert.match(takeInterceptContext("telegram:43"), /User: tasks\nBot \(instant reply\): .*Pay rent/s);
  assert.equal(takeInterceptContext("telegram:43"), "");
});
