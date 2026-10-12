import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { notifyReminderText, parseDcaReply, runCronOnce } from "../src/cron/run_once.js";
import { latestSlotToday, slotKey, todaysSlots } from "../src/cron/due.js";
import { BACKUP_KEEP, backupRestoreReport, runBackup } from "../src/cron/backup.js";
import { isMonthlyFromWeeklyPrompt, renderMonthlyFromWeekly } from "../src/cron/weekly_reminder.js";
import { googleHome } from "./helpers/google_home.js";
import { stubFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";

const WEEKLY_PROMPT =
  "Start with one title line: Weekly reminder for {Day D Mon} in Asia/Singapore.\n\nThen list these weekly items as bullets only (• …):\n• Book basketball\n• Charge car this evening\n\nIf today is also the 1st, append these monthly items in the SAME Telegram message after the weekly bullets:\n• Pay housing loan\n\nIf today is also the 14th, append these monthly items in the SAME Telegram message after the weekly bullets:\n• Clean kitchen hood\n\nOn a normal Saturday, include only the weekly bullets.\n\nYour entire reply is that reminder list.";

test("cron slots honor SGT schedule and slot keys", () => {
  const now = new Date("2026-09-20T14:00:00+08:00");
  const slots = todaysSlots("0 13 * * *", now);
  assert.equal(slots.length, 1);
  assert.equal(slotKey(slots[0]), "2026-09-20T13:00+08:00");
  assert.equal(latestSlotToday("0 13 * * *", now)?.getTime(), slots[0].getTime());
  assert.equal(todaysSlots("triggered", now).length, 0);
});

test("a failed run releases its slot so the systemd retry can claim it", async () => {
  const root = tempDir("melvbot-cron-fail-");
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const dbPath = path.join(configDir, "cron_jobs.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT NOT NULL, prompt TEXT,
      engine TEXT NOT NULL, project TEXT, on_calendar TEXT NOT NULL, enabled INTEGER NOT NULL,
      script TEXT, kind TEXT NOT NULL
    );
    CREATE TABLE cron_run_slots (
      job_id TEXT NOT NULL, slot TEXT NOT NULL, claimed_at TEXT NOT NULL,
      PRIMARY KEY (job_id, slot)
    );
    INSERT INTO cron_jobs (id, name, schedule, prompt, engine, project, on_calendar, enabled, script, kind)
    VALUES ('maintfail', 'Maint', '0 0 * * *', '', 'assistant', NULL, '0 0 * * *', 1, NULL, 'maint_report');
  `);
  db.close();
  const prev = process.env.MELVBOT_CONFIG_DIR;
  process.env.MELVBOT_CONFIG_DIR = configDir;
  try {
    await assert.rejects(() => runCronOnce("maintfail"), /requires a script/);
    const read = new DatabaseSync(dbPath, { readOnly: true });
    const row = read.prepare("SELECT COUNT(*) AS n FROM cron_run_slots WHERE job_id=?").get("maintfail") as { n: number };
    read.close();
    assert.equal(row.n, 0);
  } finally {
    process.env.MELVBOT_CONFIG_DIR = prev;
  }
});


test("weekly backup writes notes and one CSV per spreadsheet tab into the dated folder and keeps the newest 8", async () => {
  const { dir: home, restore: restoreEnv } = googleHome({ notes: { house: "doc-n" } });
  const root = path.join(home, ".melvbot", "backups");
  for (let day = 1; day <= 9; day += 1) {
    mkdirSync(path.join(root, `2026-10-0${day}`), { recursive: true });
  }
  const tabsById: Record<string, string[]> = { m: ["Transactions", "Rules"], c: ["Tab"], b: ["Tab"] };
  const stub = stubFetch((url) => {
    if (url.hostname === "www.googleapis.com") {
      return new Response("exported");
    }
    const id = url.pathname.split("/")[3];
    if (url.pathname.includes("/values/")) {
      return new Response(JSON.stringify({ values: [["h1", "h2"], ["a,b", "c"]] }));
    }
    return new Response(JSON.stringify({ sheets: tabsById[id].map((title) => ({ properties: { title } })) }));
  });
  try {
    assert.equal(await runBackup(new Date("2026-10-11T04:00:00Z"), root), null);
    const day = readdirSync(root).sort().at(-1);
    assert.equal(day, "2026-10-11");
    assert.deepEqual(readdirSync(path.join(root, day!, "sheets")).sort(), ["ev_Tab.csv", "owner1_Rules.csv", "owner1_Transactions.csv", "owner2_Tab.csv"]);
    assert.equal(readFileSync(path.join(root, day!, "sheets", "owner1_Rules.csv"), "utf8"), 'h1,h2\n"a,b",c\n');
    assert.equal(readFileSync(path.join(root, day!, "notes", "house.md"), "utf8"), "exported");
    assert.equal(readdirSync(root).length, BACKUP_KEEP);
    assert.equal(stub.calls.filter((call) => call.url.hostname === "www.googleapis.com").length, 1);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("weekly backup returns a titled failure line when one export fails and still writes the rest", async () => {
  const { dir: home, restore: restoreEnv } = googleHome({ notes: { house: "doc-n" } });
  const root = path.join(home, "backups");
  const stub = stubFetch((url) => {
    if (url.pathname.includes("doc-n")) {
      return new Response("", { status: 500 });
    }
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "Tab" } }], values: [["x"]] }));
  });
  try {
    const failure = await runBackup(new Date("2026-10-11T04:00:00Z"), root);
    assert.match(failure ?? "", /^Backup Failed Sun 11 Oct 12:00\n\n1 of 4 exports failed, first error: Google export failed with status 500$/);
    assert.equal(readdirSync(path.join(root, "2026-10-11", "sheets")).length, 3);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("weekly backup fails an empty note export instead of writing an empty file", async () => {
  const { dir: home, restore: restoreEnv } = googleHome({ notes: { house: "doc-n" } });
  const root = path.join(home, "backups");
  const stub = stubFetch((url) => {
    if (url.hostname === "www.googleapis.com") {
      return new Response(" \n");
    }
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "Tab" } }], values: [["x"]] }));
  });
  try {
    const failure = await runBackup(new Date("2026-10-11T04:00:00Z"), root);
    assert.equal(failure, "Backup Failed Sun 11 Oct 12:00\n\n1 of 4 exports failed, first error: note house exported empty");
    assert.equal(readdirSync(path.join(root, "2026-10-11", "sheets")).length, 3);
    assert.equal(readdirSync(path.join(root, "2026-10-11")).includes("notes"), false);
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("backup restore report classifies saved files as same, differs, missing from live or extra in live", async () => {
  const { dir: home, restore: restoreEnv } = googleHome({ notes: { house: "doc-n" } });
  const root = path.join(home, "backups");
  mkdirSync(path.join(root, "2026-10-11", "notes"), { recursive: true });
  mkdirSync(path.join(root, "2026-10-11", "sheets"), { recursive: true });
  writeFileSync(path.join(root, "2026-10-11", "notes", "house.md"), "exported");
  writeFileSync(path.join(root, "2026-10-11", "notes", "gone.md"), "x");
  writeFileSync(path.join(root, "2026-10-11", "sheets", "owner1_Rules.csv"), "old\n");
  writeFileSync(path.join(root, "2026-10-11", "sheets", "owner2_Rules.csv"), "h1,h2\n");
  const stub = stubFetch((url) => {
    if (url.hostname === "www.googleapis.com") {
      return new Response("exported");
    }
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "Rules" } }], values: [["h1", "h2"]] }));
  });
  try {
    assert.deepEqual(await backupRestoreReport("2026-10-11", root), {
      day: "2026-10-11",
      same: ["notes/house.md", "sheets/owner2_Rules.csv"],
      differs: ["sheets/owner1_Rules.csv"],
      missingLive: ["notes/gone.md"],
      extraLive: ["sheets/ev_Rules.csv"],
      failures: [],
      shrunk: [],
      fewerRows: [],
    });
  } finally {
    stub.restore();
    restoreEnv();
  }
});

test("backup alerts when a note lost over half its bytes or a sheet lost rows against the previous dated backup", async () => {
  const { dir: home, restore: restoreEnv } = googleHome({ notes: { house: "doc-n" } });
  const root = path.join(home, "backups");
  mkdirSync(path.join(root, "2026-10-10", "notes"), { recursive: true });
  mkdirSync(path.join(root, "2026-10-10", "sheets"), { recursive: true });
  writeFileSync(path.join(root, "2026-10-10", "notes", "house.md"), "x".repeat(30));
  writeFileSync(path.join(root, "2026-10-10", "sheets", "owner1_Rules.csv"), "h1,h2\na,b\nc,d\n");
  writeFileSync(path.join(root, "2026-10-10", "sheets", "ev_Rules.csv"), "h1,h2\n");
  const stub = stubFetch((url) => {
    if (url.hostname === "www.googleapis.com") {
      return new Response("exported");
    }
    return new Response(JSON.stringify({ sheets: [{ properties: { title: "Rules" } }], values: [["h1", "h2"]] }));
  });
  try {
    assert.equal(
      await runBackup(new Date("2026-10-11T04:00:00Z"), root),
      "Backup Alert Sun 11 Oct 12:00\n\nnotes shrunk over 50%: notes/house.md\nsheets with fewer rows: sheets/owner1_Rules.csv",
    );
    const report = await backupRestoreReport("2026-10-11", root);
    assert.deepEqual(report.shrunk, ["notes/house.md"]);
    assert.deepEqual(report.fewerRows, ["sheets/owner1_Rules.csv"]);
  } finally {
    stub.restore();
    restoreEnv();
  }
});
