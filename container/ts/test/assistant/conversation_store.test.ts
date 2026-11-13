import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { tempDbPath } from "../helpers/temp.js";
import { ftsNotes, refreshNoteFts } from "../../src/assistant/recall_index.js";

import {
  formatEpisode,
  latestEpisode,
  recordTurn,
  TURN_LOG_PROMPT_DAYS,
  TURN_LOG_PROMPT_KEEP_CHARS,
  type StoredMessage,
  saveEpisode,
} from "../../src/assistant/conversation_store.js";

// Bug: ddeploy rolled back because doctor got "database is locked" while the fresh daemon was writing.
test("opening the conversation DB waits out a short write lock held by another process", async () => {
  const dbPath = tempDbPath();
  latestEpisode("chat", dbPath); // creates the schema
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN EXCLUSIVE");
       console.log("locked");
       setTimeout(() => { db.exec("COMMIT"); }, 400);`,
      dbPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    assert.doesNotThrow(() => latestEpisode("chat", dbPath));
  } finally {
    holder.kill();
  }
});

// Bug: doctor and the daemon's startup both refreshed the note index at once; the deferred BEGIN failed
// immediately with "database is locked" (a read-to-write upgrade ignores the busy timeout).
test("refreshNoteFts waits for another process holding the write lock instead of failing", async () => {
  const dbPath = tempDbPath();
  latestEpisode("chat", dbPath);
  refreshNoteFts([], dbPath); // creates note_fts
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       console.log("locked");
       setTimeout(() => { db.exec("COMMIT"); }, 400);`,
      dbPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
    refreshNoteFts([{ slug: "a", title: "A", useWhen: "", tags: [], body: "body" }], dbPath);
    assert.deepEqual(ftsNotes(["a"], dbPath).map((note) => note.body), ["body"]);
  } finally {
    holder.kill();
  }
});

test("saveEpisode keeps the newest 20 episodes per chat and omits untrusted web blocks; formatEpisode replaces untrusted blocks", () => {
  const dbPath = tempDbPath();
  const messages = [
    {
      role: "user",
      contentJson: JSON.stringify([{ type: "text", text: 'hi\n\n<untrusted source="web_search">\nsecret page\n</untrusted>' }]),
    },
  ] as unknown as Parameters<typeof saveEpisode>[1];
  for (let i = 0; i < 25; i += 1) {
    saveEpisode("chat", messages, dbPath);
  }
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE chat_key = ?").get("chat") as { n: number };
    assert.equal(row.n, 20);
  } finally {
    db.close();
  }
  const episode = latestEpisode("chat", dbPath);
  assert.match(episode?.body ?? "", /\[web results omitted\]/);
  assert.doesNotMatch(episode?.body ?? "", /secret page/);
  {
    const out = formatEpisode([
      storedMessage(1, "user", "search it"),
      storedMessage(2, "assistant", 'before <untrusted source="x">secret page text</untrusted> after'),
    ]);
    assert.equal(out, "user: search it\nassistant: before [web results omitted] after");
    assert.ok(!out.includes("secret page text"));
  }
});

function storedMessage(seq: number, role: "user" | "assistant", text: string): StoredMessage {
  return {
    chatKey: "c1",
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    role,
    contentJson: JSON.stringify([{ text }]),
    nativeProvider: null,
    nativeJson: null,
  };
}

test("recordTurn stores the top recall slug and score, and null when nothing ranked", () => {
  const dbPath = tempDbPath("turn_log.sqlite3");
  const entry = { chatKey: "c", source: "telegram", route: "claude", tools: [], inputTokens: 1, outputTokens: 1, ms: 1, status: "ok", prompt: "p" };
  recordTurn({ ...entry, recallSlug: "phone-buy", recallScore: 2.5 }, dbPath);
  recordTurn(entry, dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT recall_slug AS s, recall_score AS c FROM turn_log ORDER BY id").all() as { s: string | null; c: number | null }[];
    assert.deepEqual(rows.map((row) => [row.s, row.c]), [["phone-buy", 2.5], [null, null]]);
  } finally {
    db.close();
  }
});

test("recordTurn cuts prompts older than TURN_LOG_PROMPT_DAYS to a short prefix and keeps the row", () => {
  const dbPath = tempDbPath("turn_log.sqlite3");
  const now = new Date("2026-10-10T04:00:00Z");
  const entry = { chatKey: "c", source: "telegram", route: "claude", tools: [], inputTokens: 1, outputTokens: 1, ms: 1, status: "ok" };
  const old = new Date(now.getTime() - (TURN_LOG_PROMPT_DAYS + 1) * 24 * 60 * 60 * 1000);
  recordTurn({ ...entry, prompt: "p".repeat(500) }, dbPath, old);
  recordTurn({ ...entry, prompt: "q".repeat(500) }, dbPath, now);
  const db = new DatabaseSync(dbPath);
  try {
    const lengths = db.prepare("SELECT length(prompt) AS n FROM turn_log ORDER BY id").all() as { n: number }[];
    assert.deepEqual(lengths.map((row) => row.n), [TURN_LOG_PROMPT_KEEP_CHARS, 500]);
  } finally {
    db.close();
  }
});
