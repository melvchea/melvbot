import assert from "node:assert/strict";
import { it } from "node:test";
import { EV_ADD_USAGE, parseEvAddArgs, parseSpendAddBatch } from "../src/sheet/add_args.js";

it("rejects unknown flags and bad dates", () => {
  assert.deepEqual(parseEvAddArgs(["2026-10-01", "--kwh", "3"]), { ok: false, reason: "unknown option --kwh" });
  assert.equal(parseEvAddArgs(["10-01"]).ok, false);
  assert.ok(EV_ADD_USAGE.includes("--charged-on"));
});
