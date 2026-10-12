import assert from "node:assert/strict";
import test from "node:test";

import { containsSpendColumnTable, spendBulletsToGfm, spendColumnsToGfm } from "../src/telegram/rich.js";

test("spend rows convert to a GFM table with merchant names intact", () => {
  const table = spendColumnsToGfm("1 Jan Coffee Shop $5.00\n2 Jan Books $6.00");
  assert.ok(table?.includes("| Coffee Shop |"), table ?? "null");
});

test("a backslash before a pipe in a merchant is escaped too, so the cell keeps one literal pipe", () => {
  const table = spendColumnsToGfm("1 Jan A\\|B $5.00\n2 Jan Cafe $6.00");
  assert.ok(table?.includes("A\\\\\\|B"), table ?? "null");
});

test("long rows without an amount are rejected without backtracking blow-up", () => {
  const words = "word ".repeat(20000);
  assert.equal(containsSpendColumnTable(`1 Jan ${words}\n1 Jan ${words}`), false);
  assert.equal(spendBulletsToGfm(`• 1 Jan — a${" ".repeat(50000)}x`), null);
});
