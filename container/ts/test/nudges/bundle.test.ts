import assert from "node:assert/strict";
import test from "node:test";
import { buildHeadsUpBlock, buildMonthlyReviewBlock } from "../../src/nudges/bundle.js";
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

test("the monthly review lists each card's last-cycle total against its Target", () => {
  const block = buildMonthlyReviewBlock({
    notes: [],
    lastCycleSpend: [
      { owner: "owner1", card: "card1", total: 700, target: 625, cycleEnd: "2026-09-30" },
      { owner: "owner2", card: "card2", total: 500, target: 800, cycleEnd: "2026-10-14" },
    ],
    houseRulesBulletCount: 0,
    autoHistoryEntries: [],
    toml,
    now: new Date("2026-10-01T00:00:00Z"),
  });
  assert.ok(block);
  assert.match(block.text, /\$700 of \$625 Target, met \(cycle to 2026-09-30\)/);
  assert.match(block.text, /\$500 of \$800 Target, short/);
});

test("Nagoya, task-deadline and match-day lines fire once each and not again", () => {
  const dbPath = tempDbPath();
  const input = {
    cards: [],
    ev: null,
    nagoyaStart: "2026-09-22",
    tasks: [
      { id: "abcdefghijklmnop", title: "Book museum", dueDay: "2026-09-20" },
      { id: "farfarfarfarfar", title: "Far task", dueDay: "2026-12-01" },
    ],
    matches: [{ date: "2026-09-16", text: "Worlds: T1 vs BLG" }],
    toml,
    dbPath,
  };
  const first = buildHeadsUpBlock({ ...input, now: daytimeNow });
  assert.ok(first);
  assert.match(first.text, /Nagoya trip in 7 days \(2026-09-22\)/);
  assert.match(first.text, /Book museum is due in 5 days/);
  assert.doesNotMatch(first.text, /Far task/);
  assert.match(first.text, /Tomorrow: Worlds: T1 vs BLG/);
  assert.equal(buildHeadsUpBlock({ ...input, now: new Date(daytimeNow.getTime() + 3_600_000) }), null);
});
