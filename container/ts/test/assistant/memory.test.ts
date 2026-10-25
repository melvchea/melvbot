import assert from "node:assert/strict";
import { test } from "node:test";


import { selectNoteForInjection } from "../../src/assistant/recall.js";
import { assertSheetHeaders } from "../../src/sheet/sheets.js";

test("selectNoteForInjection returns only the top note and gates weak scores", () => {
  assert.equal(selectNoteForInjection([{ slug: "a", score: 3 }, { slug: "b", score: 2.9 }])?.slug, "a");
  assert.equal(selectNoteForInjection([{ slug: "a", score: 0.01 }]), null);
  assert.equal(selectNoteForInjection([]), null);
});

test("assertSheetHeaders rejects a drifted Rules header", () => {
  assert.doesNotThrow(() => assertSheetHeaders([["key", "value"], ["target", "1.00"]], ["key", "value"], "Rules"));
  assert.throws(() => assertSheetHeaders([["name", "amount"]], ["key", "value"], "Rules"), /format 1/);
});
