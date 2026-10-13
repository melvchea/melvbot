import assert from "node:assert/strict";
import { test } from "node:test";

import type { TurnLogEntry } from "../../src/assistant/conversation_store.js";
import { claudeStats } from "../../src/assistant/turns_cli.js";

function turn(fields: Partial<TurnLogEntry>): TurnLogEntry {
  return { createdAt: "2026-10-13T00:00:00.000Z", chatKey: "c", source: "telegram", route: "claude", tools: [], inputTokens: 40_000, outputTokens: 100, ms: 1000, status: "ok", prompt: "x", ...fields };
}

test("claudeStats cache hit is read/(read+write), ignoring input tokens, and p95 skips non-ok turns", () => {
  const stats = claudeStats([
    turn({ cacheReadTokens: 8000, cacheWriteTokens: 2000, ms: 1000 }),
    turn({ cacheReadTokens: 8000, cacheWriteTokens: 2000, ms: 3000 }),
    turn({ status: "aborted", ms: 99_000 }),
  ]);
  assert.match(stats, /ok=2 aborted=1/);
  assert.match(stats, /cache_hit=80%/);
  assert.match(stats, /p95=3000ms/);
});
