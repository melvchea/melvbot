import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Hours a Snooze tap holds a nudge before it can be shown again. */
export const NUDGE_SNOOZE_HOURS = 24;
/** Every host message already goes out before 9pm; these only matter for a
 * manual `cron run-once` call run outside that window. */
export const NUDGE_QUIET_START_HOUR = 21;
export const NUDGE_QUIET_END_HOUR = 7;
/** How long a digest Log button's receipt details are kept in the store.
 * A receipt is created the moment its digest is sent, and the Log button
 * stays on that message indefinitely, so this needs to cover a realistic
 * "read the digest later today" gap, not just a few minutes. */
export const DIGEST_RECEIPT_TTL_MS = 24 * 60 * 60_000;

const MS_PER_HOUR = 3_600_000;

export type NudgeStatus = "fired" | "done" | "snoozed";

export type NudgeState = {
  key: string;
  period: string;
  status: NudgeStatus;
  snoozeUntil: string | null;
  firedAt: string | null;
};

export type DigestReceipt = {
  code: string;
  createdAt: string;
  merchant: string;
  spentOn: string;
  amount: string;
};

export function nudgesDbPath(): string {
  return (
    process.env.MELVBOT_NUDGES_DB ??
    path.join(
      process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config",
      "nudges.sqlite3",
    )
  );
}

export function openNudgesDb(dbPath = nudgesDbPath()): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudge_state (
      key TEXT PRIMARY KEY,
      period TEXT NOT NULL,
      status TEXT NOT NULL,
      snooze_until TEXT,
      fired_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_receipts (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      merchant TEXT NOT NULL,
      spent_on TEXT NOT NULL,
      amount TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      kind TEXT PRIMARY KEY,
      reviewed_at TEXT NOT NULL
    )
  `);
  return db;
}

function rowToState(row: Record<string, unknown>): NudgeState {
  return {
    key: String(row.key),
    period: String(row.period),
    status: String(row.status) as NudgeStatus,
    snoozeUntil: row.snooze_until == null ? null : String(row.snooze_until),
    firedAt: row.fired_at == null ? null : String(row.fired_at),
  };
}

export function getNudgeState(key: string, dbPath?: string): NudgeState | null {
  const db = openNudgesDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM nudge_state WHERE key = ?").get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToState(row) : null;
  } finally {
    db.close();
  }
}

function upsertState(state: NudgeState, dbPath?: string): void {
  const db = openNudgesDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO nudge_state (key, period, status, snooze_until, fired_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         period = excluded.period,
         status = excluded.status,
         snooze_until = excluded.snooze_until,
         fired_at = excluded.fired_at`,
    ).run(state.key, state.period, state.status, state.snoozeUntil, state.firedAt);
  } finally {
    db.close();
  }
}

/**
 * Whether a nudge should be shown this period: not already done for this
 * period, not currently snoozed, and not already fired this period (once
 * shown, it waits for the next period rather than repeating every bundle).
 */
export function shouldShowNudge(key: string, period: string, now = new Date(), dbPath?: string): boolean {
  const state = getNudgeState(key, dbPath);
  if (!state) {
    return true;
  }
  if (state.status === "done" && state.period === period) {
    return false;
  }
  if (state.status === "snoozed" && state.snoozeUntil && now.getTime() < Date.parse(state.snoozeUntil)) {
    return false;
  }
  if (state.status === "fired" && state.period === period) {
    return false;
  }
  return true;
}

export function markNudgeFired(key: string, period: string, now = new Date(), dbPath?: string): void {
  upsertState({ key, period, status: "fired", snoozeUntil: null, firedAt: now.toISOString() }, dbPath);
}

export function markNudgeDone(key: string, period: string, now = new Date(), dbPath?: string): void {
  const existing = getNudgeState(key, dbPath);
  upsertState(
    { key, period, status: "done", snoozeUntil: null, firedAt: existing?.firedAt ?? now.toISOString() },
    dbPath,
  );
}

export function markNudgeSnoozed(key: string, period: string, now = new Date(), dbPath?: string): void {
  const existing = getNudgeState(key, dbPath);
  const snoozeUntil = new Date(now.getTime() + NUDGE_SNOOZE_HOURS * MS_PER_HOUR).toISOString();
  upsertState({ key, period, status: "snoozed", snoozeUntil, firedAt: existing?.firedAt ?? now.toISOString() }, dbPath);
}

/** Held for manual `cron run-once` calls only; every scheduled bundle already runs before 9pm. */
export function isQuietHour(now = new Date(), timeZone = "Asia/Singapore"): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }).format(now),
  );
  const normalized = hour === 24 ? 0 : hour;
  return normalized >= NUDGE_QUIET_START_HOUR || normalized < NUDGE_QUIET_END_HOUR;
}

const RECEIPT_CODE_BYTES = 4;

function generateReceiptCode(): string {
  return randomBytes(RECEIPT_CODE_BYTES).toString("hex");
}

export function createDigestReceipt(
  fields: { merchant: string; spentOn: string; amount: string },
  now = new Date(),
  dbPath?: string,
): DigestReceipt {
  const receipt: DigestReceipt = {
    code: generateReceiptCode(),
    createdAt: now.toISOString(),
    merchant: fields.merchant,
    spentOn: fields.spentOn,
    amount: fields.amount,
  };
  const db = openNudgesDb(dbPath);
  try {
    db.prepare(
      "INSERT INTO digest_receipts (code, created_at, merchant, spent_on, amount) VALUES (?, ?, ?, ?, ?)",
    ).run(receipt.code, receipt.createdAt, receipt.merchant, receipt.spentOn, receipt.amount);
  } finally {
    db.close();
  }
  return receipt;
}

/** Returns the receipt for `code`, or null if unknown or past DIGEST_RECEIPT_TTL_MS. */
export function getDigestReceipt(code: string, now = new Date(), dbPath?: string): DigestReceipt | null {
  const db = openNudgesDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM digest_receipts WHERE code = ?").get(code) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    const receipt: DigestReceipt = {
      code: String(row.code),
      createdAt: String(row.created_at),
      merchant: String(row.merchant),
      spentOn: String(row.spent_on),
      amount: String(row.amount),
    };
    if (now.getTime() - Date.parse(receipt.createdAt) > DIGEST_RECEIPT_TTL_MS) {
      return null;
    }
    return receipt;
  } finally {
    db.close();
  }
}

export function deleteDigestReceipt(code: string, dbPath?: string): void {
  const db = openNudgesDb(dbPath);
  try {
    db.prepare("DELETE FROM digest_receipts WHERE code = ?").run(code);
  } finally {
    db.close();
  }
}

export function lastReviewedAt(kind: string, dbPath?: string): string | null {
  const db = openNudgesDb(dbPath);
  try {
    const row = db.prepare("SELECT reviewed_at FROM reviews WHERE kind = ?").get(kind) as
      | { reviewed_at: string }
      | undefined;
    return row ? row.reviewed_at : null;
  } finally {
    db.close();
  }
}

export function markReviewed(kind: string, now = new Date(), dbPath?: string): void {
  const db = openNudgesDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO reviews (kind, reviewed_at) VALUES (?, ?)
       ON CONFLICT(kind) DO UPDATE SET reviewed_at = excluded.reviewed_at`,
    ).run(kind, now.toISOString());
  } finally {
    db.close();
  }
}
