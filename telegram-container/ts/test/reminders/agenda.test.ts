import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { listMergedAgenda } from "../../src/reminders/agenda.js";
import { tempDir } from "../helpers/temp.js";

test("family calendar id comes from profile.toml and is skipped when unset", async () => {
  const dir = tempDir("agenda-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "profile.toml"), 'family_calendar_id = "fam@example.com"\n');
  const saved = { dir: process.env.MELVBOT_CONFIG_DIR, fam: process.env.FAMILY_CALENDAR_ID };
  delete process.env.FAMILY_CALENDAR_ID;
  const calls: string[] = [];
  const lister = (async (_from: string, _to: string, calendar?: string) => {
    calls.push(calendar ?? "");
    return [];
  }) as unknown as Parameters<typeof listMergedAgenda>[3];
  try {
    process.env.MELVBOT_CONFIG_DIR = dir;
    await listMergedAgenda("a", "b", 5, lister);
    assert.deepEqual(calls.sort(), ["fam@example.com", "primary"]);

    calls.length = 0;
    process.env.MELVBOT_CONFIG_DIR = path.join(dir, "missing");
    await listMergedAgenda("a", "b", 5, lister);
    assert.deepEqual(calls, ["primary"]);
  } finally {
    for (const [key, value] of [["MELVBOT_CONFIG_DIR", saved.dir], ["FAMILY_CALENDAR_ID", saved.fam]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
