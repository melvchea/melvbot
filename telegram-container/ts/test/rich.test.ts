import assert from "node:assert/strict";
import test from "node:test";

import { containsSpendColumnTable, spendBulletsToGfm } from "../src/telegram/rich.js";

test("long rows without an amount are rejected without backtracking blow-up", () => {
  const words = "word ".repeat(10000);
  assert.equal(containsSpendColumnTable(`1 Jan ${words}\n1 Jan ${words}`), false);
  assert.equal(spendBulletsToGfm(`• 1 Jan — a${" ".repeat(50000)}x`), null);
});
