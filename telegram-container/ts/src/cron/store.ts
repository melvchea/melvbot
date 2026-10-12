import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { TRIGGERED } from "./due.js";
import { assertAgentPromptLength, assertMinimumInterval, assertValidAgentSchedule } from "./schedule.js";

export const KIND_AGENT = "agent";
// Stored value is legacy (job was once "Daily Update"); kept to avoid a DB migration of kind.
export const KIND_MORNING_UPDATE = "daily_update";
export const KIND_AFTERNOON_WEATHER = "afternoon_weather";
export const KIND_MAINT_REPORT = "maint_report";
export const KIND_SHOPEE = "shopee";
export const KIND_OUTLOOK_DIGEST = "outlook_digest";
export const KIND_IDLE_RESET = "idle_reset";
export const KIND_BACKUP = "backup";
export const KNOWN_KINDS = new Set([
  KIND_AGENT,
  KIND_MORNING_UPDATE,
  KIND_AFTERNOON_WEATHER,
  KIND_MAINT_REPORT,
  KIND_SHOPEE,
  KIND_OUTLOOK_DIGEST,
  KIND_IDLE_RESET,
  KIND_BACKUP,
]);

/** Remaining shell jobs that are POSIX-only (no python3). */
export const SHELL_CRON_SCRIPTS = new Set(["read-maint-report.sh"]);

export type CronJob = {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  engine: string;
  project: string | null;
  onCalendar: string;
  enabled: boolean;
  script: string | null;
  kind: string;
};

export function cronDbPath(): string {
  return path.join(
    process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config",
    "cron_jobs.db",
  );
}

function openDb(): DatabaseSync {
  const file = cronDbPath();
  if (!existsSync(file)) {
    throw new Error(`cron_jobs.db missing: ${file}`);
  }
  const db = new DatabaseSync(file);
  try {
    // Idempotent: the job was renamed from "Daily Update" to "Morning Update".
    db.prepare("UPDATE cron_jobs SET name=? WHERE name=? AND kind=?").run(
      "Morning Update",
      "Daily Update",
      KIND_MORNING_UPDATE,
    );
  } catch {
    // read-only DB or missing table: the rename is cosmetic, skip it
  }
  return db;
}

function rowToJob(row: Record<string, unknown>): CronJob {
  return {
    id: String(row.id),
    name: String(row.name),
    schedule: String(row.schedule),
    prompt: String(row.prompt ?? ""),
    engine: String(row.engine ?? "claude"),
    project: row.project == null ? null : String(row.project),
    onCalendar: String(row.on_calendar ?? ""),
    enabled: Boolean(row.enabled),
    script: row.script ? String(row.script) : null,
    kind: String(row.kind || KIND_AGENT),
  };
}

export function getJob(jobId: string): CronJob | null {
  const db = openDb();
  try {
    const row = db
      .prepare(
        "SELECT id, name, schedule, prompt, engine, project, on_calendar, enabled, script, kind FROM cron_jobs WHERE id=?",
      )
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  } finally {
    db.close();
  }
}

export function isTriggered(job: CronJob): boolean {
  return job.onCalendar.trim().toLowerCase() === TRIGGERED || job.schedule.trim().toLowerCase() === TRIGGERED;
}

export function claimRunSlot(jobId: string, slot: string): boolean {
  const db = openDb();
  try {
    const result = db
      .prepare("INSERT OR IGNORE INTO cron_run_slots (job_id, slot, claimed_at) VALUES (?, ?, ?)")
      .run(jobId, slot, new Date().toISOString());
    return Number(result.changes) === 1;
  } finally {
    db.close();
  }
}

export const RUN_SLOT_RETENTION_DAYS = 30;

export function pruneRunSlots(now = new Date()): number {
  const cutoff = new Date(now.getTime() - RUN_SLOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const db = openDb();
  try {
    const result = db
      .prepare(
        "DELETE FROM cron_run_slots WHERE claimed_at IS NOT NULL AND claimed_at < ?",
      )
      .run(cutoff.toISOString());
    return Number(result.changes);
  } finally {
    db.close();
  }
}

export function releaseRunSlot(jobId: string, slot: string): void {
  const db = openDb();
  try {
    db.prepare("DELETE FROM cron_run_slots WHERE job_id=? AND slot=?").run(jobId, slot);
  } finally {
    db.close();
  }
}

const AGENT_JOB_ID_BYTES = 6;

function generateJobId(): string {
  return randomBytes(AGENT_JOB_ID_BYTES).toString("hex");
}

function assertEditableAgentJob(job: CronJob | null, id: string): CronJob {
  if (!job) {
    throw new Error(`cron job not found: ${id}`);
  }
  if (job.kind !== KIND_AGENT) {
    throw new Error(`${job.name} (${id}) is a ${job.kind} job; changed from the host CLI only`);
  }
  return job;
}

export function addAgentJob(options: { name: string; schedule: string; prompt: string }): CronJob {
  assertValidAgentSchedule(options.schedule);
  assertMinimumInterval(options.schedule);
  assertAgentPromptLength(options.prompt);
  const name = options.name.trim();
  if (!name) {
    throw new Error("name must not be empty");
  }
  const id = generateJobId();
  const db = openDb();
  try {
    db.prepare(
      `INSERT INTO cron_jobs (id, name, schedule, prompt, engine, project, on_calendar, enabled, script, kind)
       VALUES (?, ?, ?, ?, 'assistant', NULL, ?, 1, NULL, ?)`,
    ).run(id, name, options.schedule, options.prompt, options.schedule, KIND_AGENT);
  } finally {
    db.close();
  }
  return getJob(id) as CronJob;
}

export function updateAgentJob(
  id: string,
  changes: { name?: string; schedule?: string; prompt?: string },
): CronJob {
  const existing = assertEditableAgentJob(getJob(id), id);
  const name = changes.name?.trim() || existing.name;
  const schedule = changes.schedule ?? existing.schedule;
  const prompt = changes.prompt ?? existing.prompt;
  if (changes.schedule !== undefined) {
    assertValidAgentSchedule(schedule);
    assertMinimumInterval(schedule);
  }
  if (changes.prompt !== undefined) {
    assertAgentPromptLength(prompt);
  }
  const db = openDb();
  try {
    db.prepare("UPDATE cron_jobs SET name=?, schedule=?, prompt=?, on_calendar=? WHERE id=?").run(
      name,
      schedule,
      prompt,
      schedule,
      id,
    );
  } finally {
    db.close();
  }
  return getJob(id) as CronJob;
}

export function setAgentJobEnabled(id: string, enabled: boolean): CronJob {
  assertEditableAgentJob(getJob(id), id);
  const db = openDb();
  try {
    db.prepare("UPDATE cron_jobs SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
  } finally {
    db.close();
  }
  return getJob(id) as CronJob;
}

export function deleteAgentJob(id: string): void {
  assertEditableAgentJob(getJob(id), id);
  const db = openDb();
  try {
    db.prepare("DELETE FROM cron_jobs WHERE id=?").run(id);
    db.prepare("DELETE FROM cron_run_slots WHERE job_id=?").run(id);
  } finally {
    db.close();
  }
}

export function listCronJobs(): CronJob[] {
  const file = cronDbPath();
  if (!existsSync(file)) {
    return [];
  }
  const db = openDb();
  try {
    const rows = db
      .prepare(
        "SELECT id, name, schedule, prompt, engine, project, on_calendar, enabled, script, kind FROM cron_jobs ORDER BY name",
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToJob);
  } finally {
    db.close();
  }
}
