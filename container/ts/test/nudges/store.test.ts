import assert from "node:assert/strict";
import test from "node:test";
import {
  markNudgeDone,
  markNudgeFired,
  shouldShowNudge,
} from "../../src/nudges/store.js";
import { tempDbPath } from "../helpers/temp.js";

test("once per period: fired this period is not shown again until the next period; Done for the period hides it for that period, but a new period shows it again", () => {
  const db = tempDbPath();
  const now = new Date("2026-09-15T10:00:00Z");
  markNudgeFired("headroom:owner1", "2026-09-01", now, db);
  assert.equal(shouldShowNudge("headroom:owner1", "2026-09-01", now, db), false);
  assert.equal(shouldShowNudge("headroom:owner1", "2026-10-01", now, db), true);
  {
    const db = tempDbPath();
    const now = new Date("2026-09-15T10:00:00Z");
    markNudgeDone("headroom:owner1", "2026-09-01", now, db);
    assert.equal(shouldShowNudge("headroom:owner1", "2026-09-01", now, db), false);
    assert.equal(shouldShowNudge("headroom:owner1", "2026-10-01", now, db), true);
  }
});
