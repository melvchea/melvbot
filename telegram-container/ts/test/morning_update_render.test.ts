import assert from "node:assert/strict";
import test from "node:test";
import { renderMorningUpdate, splitMorningUpdate } from "../src/cron/morning_update.js";

test("morning update renders from prefetched data without Claude and survives the sender's splitter", () => {
  const now = new Date("2026-10-06T23:30:00Z"); // Wed 7 Oct SGT
  const world = [{ title: "Quake hits coast - BBC News", url: "https://bbc.example/a", published: now, source: "bbc" }];
  const text = renderMorningUpdate(now, ["• 09:00 Standup"], [], { world, tech: [], singapore: [] });
  assert.equal(
    text,
    "Morning Update Wed 7 Oct 07:30\n\n📅 Google Calendar:\n• 09:00 Standup\n\n🌍 World News (last 24h):\n- [Quake hits coast](https://bbc.example/a)",
  );
  const chunks = splitMorningUpdate(text, { news: { world } });
  assert.equal(chunks.flatMap((c) => c.entities ?? [])[0]?.url, "https://bbc.example/a");
});
