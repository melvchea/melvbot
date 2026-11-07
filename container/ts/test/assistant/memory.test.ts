import assert from "node:assert/strict";
import { test } from "node:test";


import { cliCmdLabel } from "../../src/assistant/custom_tools.js";
import { recallMissFlag } from "../../src/assistant/turn.js";
import { selectNoteForInjection, untrustedSource } from "../../src/assistant/recall.js";
import { assertSheetHeaders } from "../../src/sheet/sheets.js";

test("selectNoteForInjection returns only the top note and gates weak scores", () => {
  assert.equal(selectNoteForInjection([{ slug: "a", score: 3 }, { slug: "b", score: 2.9 }])?.slug, "a");
  assert.equal(selectNoteForInjection([{ slug: "a", score: 0.01 }]), null);
  assert.equal(selectNoteForInjection([]), null);
});

test("cliCmdLabel keeps the note slug but never free text, and recallMissFlag still sees `note get <slug>`", () => {
  assert.equal(cliCmdLabel(["note", "get", "phone-buy"]), "note get phone-buy");
  assert.equal(cliCmdLabel(["note", "--json", "replace-text", "bank-save", "secret"]), "note replace-text bank-save");
  assert.equal(cliCmdLabel(["sheet", "spend", "add", "Grab $30"]), "sheet spend");
  assert.equal(recallMissFlag(["note get phone-buy"], false), 1);
  assert.equal(recallMissFlag(["note get phone-buy"], true), 0);
  assert.equal(recallMissFlag(["note append-history x"], false), 0);
});

test("assertSheetHeaders rejects a drifted Rules header", () => {
  assert.doesNotThrow(() => assertSheetHeaders([["key", "value"], ["target", "1.00"]], ["key", "value"], "Rules"));
  assert.throws(() => assertSheetHeaders([["name", "amount"]], ["key", "value"], "Rules"), /format 1/);
});

test("untrustedSource flags forwarded and web notes, and treats untagged as typed", () => {
  assert.equal(untrustedSource(["Source:Web", "ev"]), "web");
  assert.equal(untrustedSource(["source:forwarded"]), "forwarded");
  assert.equal(untrustedSource(["travel"]), null);
});
