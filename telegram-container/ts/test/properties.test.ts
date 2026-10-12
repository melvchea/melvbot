import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { stripTags } from "../src/html_text.js";
import { containsSpendColumnTable, spendColumnsToGfm } from "../src/telegram/rich.js";

const SEED = 20261012;
const RUNS = 50;

const htmlish = fc
  .array(fc.constantFrom("<", ">", "/", "a", "b", " ", "\n", "=", "\"", "<b>", "</i>"), { maxLength: 60 })
  .map((parts) => parts.join(""));

test("stripTags is idempotent and leaves no complete tag behind", () => {
  fc.assert(
    fc.property(fc.oneof(htmlish, fc.string()), (input) => {
      const once = stripTags(input);
      assert.equal(stripTags(once), once);
      assert.doesNotMatch(once, /<[^>]+>/);
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

// Splits a GFM row on pipes that are not preceded by an odd run of backslashes.
function splitUnescapedPipes(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "|") {
      let run = 0;
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) {
        run += 1;
      }
      if (run % 2 === 0) {
        cells.push(current);
        current = "";
        continue;
      }
    }
    current += line[i];
  }
  cells.push(current);
  return cells;
}

test("merchant pipes in a spend table are escaped so no unescaped pipe leaks into the cell", () => {
  const merchantChars = fc.constantFrom("A", "B", "|", "\\", "x", "1");
  const merchant = fc
    .array(merchantChars, { minLength: 1, maxLength: 20 })
    .map((chars) => chars.join(""));
  fc.assert(
    fc.property(merchant, (name) => {
      const table = spendColumnsToGfm(`1 Jan ${name} $5.00\n2 Jan Cafe $6.00`);
      assert.notEqual(table, null);
      const row = table!.split("\n")[2];
      const cells = splitUnescapedPipes(row);
      // Leading empty cell, date, merchant, amount, trailing empty cell.
      assert.equal(cells.length, 5, row);
      const escaped = cells[2];
      for (let i = 0; i < escaped.length; i += 1) {
        if (escaped[i] !== "|") {
          continue;
        }
        let run = 0;
        for (let j = i - 1; j >= 0 && escaped[j] === "\\"; j -= 1) {
          run += 1;
        }
        assert.equal(run % 2, 1, `unescaped pipe in merchant cell: ${row}`);
      }
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

test("spend row detection finishes fast on long whitespace and word inputs", () => {
  const filler = fc.array(fc.constantFrom("word", " ", " ", "\t", "  ", "x"), {
    minLength: 1,
    maxLength: 4000,
  });
  fc.assert(
    fc.property(filler, (parts) => {
      const line = `1 Jan ${parts.join("")}`;
      const started = performance.now();
      const found = containsSpendColumnTable(`${line}\n${line}`);
      const elapsed = performance.now() - started;
      assert.equal(found, false);
      assert.ok(elapsed < 200, `spend row check took ${elapsed.toFixed(1)} ms`);
    }),
    { seed: SEED, numRuns: RUNS },
  );
});
