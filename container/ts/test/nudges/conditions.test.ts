import assert from "node:assert/strict";
import test from "node:test";

import {
  evIntervalCondition,
  headroomCondition,
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
