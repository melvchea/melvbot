import assert from "node:assert/strict";
import test from "node:test";
import { buildHeadsUpBlock } from "../../src/nudges/bundle.js";
import { markNudgeDone } from "../../src/nudges/store.js";
import { parseNudgesSection } from "../../src/nudges/toml.js";
import { tempDbPath } from "../helpers/temp.js";

const toml = parseNudgesSection("");
const daytimeNow = new Date("2026-09-15T04:00:00Z"); // 12:00 SGT, not quiet

test("after a Done callback, a second render for the same cycle doesn't contain the headroom line", () => {
  const dbPath = tempDbPath();
  const cardInput = {
    cards: [
      {
        owner: "owner1" as const,
        card: "card1" as const,
        total: 400,
        target: 625,
        limit: null,
        cycleStart: "2026-09-01",
        cycleEnd: "2026-09-18",
        lastSpendOn: "2026-09-14",
      },
    ],
    ev: null,
    toml,
    dbPath,
  };
  const first = buildHeadsUpBlock({ ...cardInput, now: daytimeNow });
  assert.ok(first);
  markNudgeDone("headroom:owner1", "2026-09-01", daytimeNow, dbPath);
  const second = buildHeadsUpBlock({ ...cardInput, now: new Date(daytimeNow.getTime() + 3_600_000) });
  assert.equal(second, null);
});

test("a bundle run in quiet hours holds every nudge for the next bundle", () => {
  const dbPath = tempDbPath();
  const block = buildHeadsUpBlock({
    cards: [
      {
        owner: "owner1",
        card: "card1",
        total: 400,
        target: 625,
        limit: null,
        cycleStart: "2026-09-01",
        cycleEnd: "2026-09-18",
        lastSpendOn: "2026-09-14",
      },
    ],
    ev: null,
    toml,
    now: new Date("2026-09-15T14:00:00Z"), // 22:00 SGT, quiet
    dbPath,
  });
  assert.equal(block, null);
});
