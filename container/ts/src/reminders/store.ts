import type { DatabaseSync } from "node:sqlite";

import { openNudgesDb } from "../nudges/store.js";

/** Alert rows older than this are pruned. */
export const ALERT_RETENTION_DAYS = 30;

export type AlertStatus = "sent" | "done";

function openDb(dbPath?: string): DatabaseSync {
  const db = openNudgesDb(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_alerts (
      event_id TEXT NOT NULL,
      start_iso TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      PRIMARY KEY (event_id, start_iso)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_sweeps (
      day TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL
    )
  `);
  return db;
}

function withDb<T>(dbPath: string | undefined, run: (db: DatabaseSync) => T): T {
  const db = openDb(dbPath);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

export function isAlertSent(eventId: string, startIso: string, dbPath?: string): boolean {
  return withDb(dbPath, (db) => db.prepare("SELECT 1 FROM reminder_alerts WHERE event_id = ? AND start_iso = ?").get(eventId, startIso) !== undefined);
}

export function markAlertSent(eventId: string, startIso: string, now = new Date(), dbPath?: string): void {
  withDb(dbPath, (db) => {
    db.prepare("INSERT OR IGNORE INTO reminder_alerts (event_id, start_iso, status, sent_at) VALUES (?, ?, 'sent', ?)").run(
      eventId,
      startIso,
      now.toISOString(),
    );
  });
}

/** Alerts sent at or after `sinceIso` (status bar of `,status`). */
export function alertsSentSince(sinceIso: string, dbPath?: string): number {
  return withDb(dbPath, (db) => Number((db.prepare("SELECT COUNT(*) AS n FROM reminder_alerts WHERE sent_at >= ?").get(sinceIso) as { n: number }).n));
}

/** Done tap: every alert row of the event becomes `done` (kept, so it is never re-sent). */
export function markAlertDone(eventId: string, dbPath?: string): void {
  withDb(dbPath, (db) => {
    db.prepare("UPDATE reminder_alerts SET status = 'done' WHERE event_id = ?").run(eventId);
  });
}

/** Snooze tap: the event moved, so its old sent flag goes away. */
export function clearAlerts(eventId: string, dbPath?: string): void {
  withDb(dbPath, (db) => {
    db.prepare("DELETE FROM reminder_alerts WHERE event_id = ?").run(eventId);
  });
}

export function pruneAlerts(now = new Date(), dbPath?: string): number {
  const cutoff = new Date(now.getTime() - ALERT_RETENTION_DAYS * 86_400_000).toISOString();
  return withDb(dbPath, (db) => {
    const alerts = db.prepare("DELETE FROM reminder_alerts WHERE sent_at < ?").run(cutoff);
    db.prepare("DELETE FROM task_sweeps WHERE sent_at < ?").run(cutoff);
    return Number(alerts.changes);
  });
}

export function isSweepSent(day: string, dbPath?: string): boolean {
  return withDb(dbPath, (db) => db.prepare("SELECT 1 FROM task_sweeps WHERE day = ?").get(day) !== undefined);
}

export function markSweepSent(day: string, now = new Date(), dbPath?: string): void {
  withDb(dbPath, (db) => {
    db.prepare("INSERT OR IGNORE INTO task_sweeps (day, sent_at) VALUES (?, ?)").run(day, now.toISOString());
  });
}
