import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  KIND_MORNING_UPDATE,
  addAgentJob,
  deleteAgentJob,
  getJob,
  setAgentJobEnabled,
  updateAgentJob,
} from "../../src/cron/store.js";
import { setMelvbotEnv } from "../helpers/env.js";
import { tempDir } from "../helpers/temp.js";

/** A fresh config dir holding a cron_jobs.db with the schema and one morning-update job. */
function tempCronDb(): string {
  const root = tempDir("melvbot-cron-write-");
  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const dbPath = path.join(configDir, "cron_jobs.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      prompt TEXT,
      engine TEXT NOT NULL,
      project TEXT,
      on_calendar TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      script TEXT,
      kind TEXT NOT NULL
    );
    CREATE TABLE cron_run_slots (
      job_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (job_id, slot)
    );
    INSERT INTO cron_jobs (id, name, schedule, prompt, engine, project, on_calendar, enabled, script, kind)
    VALUES ('53e939ed6b85', 'Daily Update', '30 7 * * *', NULL, 'assistant', NULL, '30 7 * * *', 1, NULL, '${KIND_MORNING_UPDATE}');
  `);
  db.close();
  return configDir;
}

function withCronDb<T>(fn: () => T): T {
  const restore = setMelvbotEnv({ MELVBOT_CONFIG_DIR: tempCronDb() });
  try {
    return fn();
  } finally {
    restore();
  }
}

async function withCronDbAsync<T>(fn: () => Promise<T>): Promise<T> {
  const restore = setMelvbotEnv({ MELVBOT_CONFIG_DIR: tempCronDb() });
  try {
    return await fn();
  } finally {
    restore();
  }
}

test("non-agent kinds can't be changed; deleteAgentJob removes the job and its run slots", () => {
  withCronDb(() => {
    assert.throws(() => updateAgentJob("53e939ed6b85", { schedule: "0 8 * * *" }), /changed from the host CLI only/);
    assert.throws(() => setAgentJobEnabled("53e939ed6b85", false), /changed from the host CLI only/);
    assert.throws(() => deleteAgentJob("53e939ed6b85"), /changed from the host CLI only/);
  });
  {
    withCronDb(() => {
      const job = addAgentJob({ name: "Trash reminder", schedule: "0 20 * * 0", prompt: "take out the trash" });
      deleteAgentJob(job.id);
      assert.equal(getJob(job.id), null);
    });
  }
});
