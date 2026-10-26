import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { diffLines } from "../assistant/confirm.js";
import { currentSourceRef } from "../source_ref.js";
import { conversationDbPath } from "../assistant/conversation_store.js";

export type ChangeLogEntry = {
  id: number;
  action: string;
  target: string;
  beforeJson: string | null;
  afterJson: string | null;
  sourceRef: string;
  createdAt: string;
  undoneAt: string | null;
  chatKey: string | null;
};

export type WriteReceipt = {
  receipt: true;
  action: string;
  target: string;
  verified: boolean;
  changeId?: number;
  sourceRef?: string;
  url?: string;
  updatedAt?: string;
  revisionId?: string;
  diff?: { removed: string[]; added: string[] };
};

function openDb(dbPath = conversationDbPath()): DatabaseSync {
  const resolved = dbPath;
  const dir = path.dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(resolved);
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      source_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      undone_at TEXT,
      chat_key TEXT
    )
  `);
  chmodSync(resolved, 0o600);
  return db;
}

function rowToEntry(row: Record<string, unknown>): ChangeLogEntry {
  return {
    id: Number(row.id),
    action: String(row.action),
    target: String(row.target),
    beforeJson: row.before_json == null ? null : String(row.before_json),
    afterJson: row.after_json == null ? null : String(row.after_json),
    sourceRef: String(row.source_ref),
    createdAt: String(row.created_at),
    undoneAt: row.undone_at == null ? null : String(row.undone_at),
    chatKey: row.chat_key == null ? null : String(row.chat_key),
  };
}

/** Actions `memory undo` can reverse; everything else in the log is history only. */
const UNDOABLE_ACTIONS = ["note add", "note append-history", "note replace-section", "note replace-text", "note delete", "note rename", "offer_save"];

export function recordChange(entry: {
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  chatKey?: string | null;
  dbPath?: string;
}): number {
  const db = openDb(entry.dbPath);
  try {
    const result = db
      .prepare(
        `INSERT INTO change_log (action, target, before_json, after_json, source_ref, created_at, chat_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.action,
        entry.target,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        currentSourceRef(),
        new Date().toISOString(),
        entry.chatKey ?? process.env.MELVBOT_CHAT_KEY ?? null,
      );
    return Number(result.lastInsertRowid);
  } finally {
    db.close();
  }
}

/** created_at of the newest `action` entry for `target`, or null when none. */
export function lastChangeAt(action: string, target: string, dbPath = conversationDbPath()): string | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT created_at FROM change_log WHERE action = ? AND target = ? ORDER BY id DESC LIMIT 1")
      .get(action, target) as { created_at: string } | undefined;
    return row ? row.created_at : null;
  } finally {
    db.close();
  }
}

/** Newest not-yet-undone Note change, limited to `chatKey` when given. */
export function latestUndoableChange(
  chatKey: string | null = null,
  dbPath = conversationDbPath(),
): ChangeLogEntry | null {
  const db = openDb(dbPath);
  try {
    const actions = UNDOABLE_ACTIONS.map(() => "?").join(", ");
    const scope = chatKey === null ? "" : " AND chat_key = ?";
    const row = db
      .prepare(
        `SELECT * FROM change_log WHERE undone_at IS NULL AND action IN (${actions})${scope} ORDER BY id DESC LIMIT 1`,
      )
      .get(...UNDOABLE_ACTIONS, ...(chatKey === null ? [] : [chatKey])) as Record<string, unknown> | undefined;
    return row ? rowToEntry(row) : null;
  } finally {
    db.close();
  }
}

export function markChangeUndone(id: number, dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare("UPDATE change_log SET undone_at = ? WHERE id = ? AND undone_at IS NULL").run(
      new Date().toISOString(),
      id,
    );
  } finally {
    db.close();
  }
}

export function buildBodyDiffReceipt(
  action: string,
  target: string,
  beforeBody: string | null,
  afterBody: string,
  changeId: number,
  extra: {
    url?: string;
    updatedAt?: string;
    revisionId?: string;
    verified?: boolean;
    sourceRef?: string;
  } = {},
): WriteReceipt {
  const diff = beforeBody === null ? undefined : diffLines(beforeBody, afterBody);
  return {
    receipt: true,
    action,
    target,
    verified: extra.verified ?? true,
    changeId,
    sourceRef: extra.sourceRef,
    url: extra.url,
    updatedAt: extra.updatedAt,
    revisionId: extra.revisionId,
    diff,
  };
}
