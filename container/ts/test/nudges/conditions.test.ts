import assert from "node:assert/strict";
import test from "node:test";

import {
  evIntervalCondition,
  firstUpcomingDate,
  headroomCondition,
  matchDayCondition,
  nagoyaCountdownCondition,
  parseWatchList,
  taskDeadlineCondition,
} from "../../src/nudges/conditions.js";
import { FIXTURE_PROFILE, withProfile } from "../helpers/profile.js";

withProfile(FIXTURE_PROFILE);

test("headroom fires 5 days before the cycle end when below target", () => {
  const line = headroomCondition({
    owner: "owner1",
    card: "card1",
    total: 400,
    target: 625,
    limit: null,
    cycleEnd: "2026-09-20",
    now: new Date("2026-09-15T00:00:00Z"),
  });
  assert.match(line ?? "", /Alice CardOne/);
  assert.match(line ?? "", /\$225/);
});

test("EV interval fires once days-since reaches the median plus the grace days", () => {
  const line = evIntervalCondition({
    recentDayGaps: [10, 11, 10, 12, 11],
    lastChargedOn: "2026-09-01",
    now: new Date("2026-09-13T00:00:00Z"), // 12 days since; median 11 + grace 2 = 13, not yet
  });
  assert.equal(line, null);
  const fired = evIntervalCondition({
    recentDayGaps: [10, 11, 10, 12, 11],
    lastChargedOn: "2026-09-01",
    now: new Date("2026-09-14T00:00:00Z"), // 13 days since >= 13
  });
  assert.match(fired ?? "", /EV M6/);
});

test("Nagoya milestones bracket the days left, and the start is the first upcoming Note date", () => {
  assert.equal(nagoyaCountdownCondition({ start: "2026-12-20", today: "2026-11-19" }), null);
  assert.equal(nagoyaCountdownCondition({ start: "2026-12-20", today: "2026-12-10" })?.milestone, 14);
  assert.equal(nagoyaCountdownCondition({ start: "2026-12-20", today: "2026-12-19" })?.milestone, 1);
  assert.equal(nagoyaCountdownCondition({ start: "2026-12-20", today: "2026-12-21" }), null);
  assert.equal(firstUpcomingDate("- 2026-10-10: saved\nHotel 2026-12-22\nFlight 2026-12-20", "2026-10-25"), "2026-12-20");
});

test("task deadline fires only 1-7 days out; watch list joins same-day entries and alerts today and tomorrow", () => {
  assert.equal(taskDeadlineCondition({ title: "T", dueDay: "2026-11-01", today: "2026-10-25" }), "T is due in 7 days (2026-11-01)");
  assert.equal(taskDeadlineCondition({ title: "T", dueDay: "2026-10-25", today: "2026-10-25" }), null);
  assert.equal(taskDeadlineCondition({ title: "T", dueDay: "2026-11-02", today: "2026-10-25" }), null);
  const [entry] = parseWatchList("- 2026-11-02 Worlds: T1 vs BLG\n2026-11-02: Worlds: G2 vs FNC");
  assert.equal(entry.text, "Worlds: T1 vs BLG / Worlds: G2 vs FNC");
  assert.equal(matchDayCondition({ ...entry, today: "2026-11-01" })?.line, "Tomorrow: Worlds: T1 vs BLG / Worlds: G2 vs FNC");
  assert.equal(matchDayCondition({ ...entry, today: "2026-10-31" }), null);
});
