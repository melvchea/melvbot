import assert from "node:assert/strict";
import test from "node:test";
import { matchOcrProse } from "../src/telegram/ocr_prose.js";
import { soleNonemptyLineStripped } from "../src/telegram/prose_line.js";
import { wouldDispatchProseIntercept } from "../src/telegram/prose_intercept.js";

/** Names of every instant matcher that accepts the message. */
function handlers(text: string): string[] {
  const hits: string[] = [];
  if (matchOcrProse(text)) hits.push("ocr");
  return hits;
}

const TABLE: [string, string | null][] = [
  ["ocr this", "ocr"],
  ["ocr", "ocr"],
  ["can you explain the weather in Tokyo?", null],
  ["is there a calendar for next month?", null],
];

test("each table message is claimed by exactly the expected handler", () => {
  for (const [message, expected] of TABLE) {
    assert.deepEqual(handlers(message), expected ? [expected] : [], JSON.stringify(message));
  }
});

test("polite filler and word order do not defeat an intercept; explain-style questions still reach Claude", async () => {
  for (const text of ["could you ocr this", "list notes pls"]) {
    assert.equal(await wouldDispatchProseIntercept(text), true, text);
  }
  for (const text of ["can you explain the weather in Tokyo?", "please", "hey there", "thanks"]) {
    assert.equal(await wouldDispatchProseIntercept(text), false, text);
  }
});
