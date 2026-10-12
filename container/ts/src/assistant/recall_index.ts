import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { conversationDbPath } from "./conversation_store.js";
import { noteTokens } from "./recall.js";

export type NoteFtsRow = {
  slug: string;
  title: string;
  useWhen: string;
  tags: string[];
  body: string;
};

function openFtsDb(dbPath = conversationDbPath()): DatabaseSync {
  return new DatabaseSync(dbPath);
}

export function ensureNoteFts(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
      slug UNINDEXED,
      title,
      use_when,
      tags,
      body,
      tokenize='porter unicode61'
    )
  `);
}

export function refreshNoteFts(notes: readonly NoteFtsRow[], dbPath = conversationDbPath()): void {
  if (!existsSync(dbPath)) {
    return;
  }
  const db = openFtsDb(dbPath);
  try {
    ensureNoteFts(db);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM note_fts");
      const insert = db.prepare(
        "INSERT INTO note_fts (slug, title, use_when, tags, body) VALUES (?, ?, ?, ?, ?)",
      );
      for (const note of notes) {
        insert.run(note.slug, note.title, note.useWhen, note.tags.join(" "), note.body);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

function ftsQueryFromTokens(tokens: string[]): string | null {
  const terms = tokens.filter((token) => token.length > 0);
  if (terms.length === 0) {
    return null;
  }
  return terms.map((token) => `"${token.replaceAll('"', "")}"`).join(" OR ");
}

/** Higher is better. Empty when FTS is unavailable or the query has no tokens. */
export function ftsBm25Scores(query: string, dbPath = conversationDbPath()): Map<string, number> {
  const ftsQuery = ftsQueryFromTokens(noteTokens(query));
  if (ftsQuery === null || !existsSync(dbPath)) {
    return new Map();
  }
  const db = openFtsDb(dbPath);
  try {
    ensureNoteFts(db);
    const rows = db
      .prepare(
        `SELECT slug, bm25(note_fts) AS rank
         FROM note_fts
         WHERE note_fts MATCH ?
         ORDER BY rank
         LIMIT 30`,
      )
      .all(ftsQuery) as { slug: string; rank: number }[];
    const scores = new Map<string, number>();
    for (const row of rows) {
      scores.set(row.slug, -Number(row.rank));
    }
    return scores;
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

/** Bodies and titles of indexed notes by slug, straight from the local FTS table (no Google round trip). */
export function ftsNotes(slugs: readonly string[], dbPath = conversationDbPath()): { slug: string; title: string; body: string }[] {
  if (slugs.length === 0 || !existsSync(dbPath)) {
    return [];
  }
  const db = openFtsDb(dbPath);
  try {
    ensureNoteFts(db);
    const select = db.prepare("SELECT slug, title, body FROM note_fts WHERE slug = ?");
    return slugs.flatMap((slug) => {
      const row = select.get(slug) as { slug: string; title: string; body: string } | undefined;
      return row ? [row] : [];
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}
