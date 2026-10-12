import assert from "node:assert/strict";
import test from "node:test";
import { EXPIRED_TEXT, handleDigestLog, handleNudgeDoneSnooze } from "../../src/nudges/callbacks.js";
import { createDigestReceipt, shouldShowNudge } from "../../src/nudges/store.js";
import { tempDbPath } from "../helpers/temp.js";

test("digest log: pick runs sheet spend add with spentOn/merchant/amount positional, not as flags", async () => {
  const dbPath = tempDbPath();
  const now = new Date("2026-09-15T04:00:00Z");
  const receipt = createDigestReceipt({ merchant: "NTUC", spentOn: "2026-09-15", amount: "12.50" }, now, dbPath);
  let seenArgs: string[] | null = null;
  const result = await handleDigestLog(`pick|${receipt.code}|owner1`, dbPath, now, async (args) => {
    seenArgs = args;
    return { stdout: JSON.stringify({ inserted: true }) };
  });
  assert.deepEqual(seenArgs, [
    "sheet",
    "spend",
    "add",
    "--owner",
    "owner1",
    "--card",
    "card1",
    "2026-09-15",
    "NTUC",
    "12.50",
  ]);
  assert.equal(result.text, "Logged.");
});

