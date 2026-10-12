import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { tempDbPath } from "../helpers/temp.js";

import {
  formatEpisode,
  latestEpisode,
  recordTurn,
  TURN_LOG_PROMPT_DAYS,
  TURN_LOG_PROMPT_KEEP_CHARS,
  type StoredMessage,
  saveEpisode,
} from "../../src/assistant/conversation_store.js";

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
