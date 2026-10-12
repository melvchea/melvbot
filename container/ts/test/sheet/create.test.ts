import assert from "node:assert/strict";
import { test } from "node:test";

import { createFreeFormSheet, parseSheetCreateArgs, type SheetCreateDeps } from "../../src/sheet/create.js";

function fakeDeps(body: string, failWrite = false) {
  const writes: { kind: string; args: unknown[] }[] = [];
  const deps: SheetCreateDeps = {
    createSpreadsheet: async () => "sheet123",
    getNote: async () => ({ body, revision_id: "rev1" }),
    replaceNoteText: async (...args) => {
      if (failWrite) throw new Error("revision mismatch");
      writes.push({ kind: "text", args });
      return {};
    },
    replaceNoteSection: async (...args) => {
      if (failWrite) throw new Error("revision mismatch");
      writes.push({ kind: "section", args });
      return {};
    },
  };
  return { deps, writes };
}

const request = parseSheetCreateArgs(["Alt", "scenario", "--note", "bank-save", "--tab", "Spend:Category, Amount"]);

test("create replaces the Sheet-link placeholder line in the Note with the URL", async () => {
  const body = "## Plan\nSheet: [Alt](https://docs.google.com/spreadsheets/d/[sheet-id]/edit)\n\nText";
  const { deps, writes } = fakeDeps(body);
  const result = await createFreeFormSheet(request!, deps);
  assert.equal(result.url, "https://docs.google.com/spreadsheets/d/sheet123/edit");
  assert.deepEqual(result.note, { slug: "bank-save", linked: true });
  assert.equal(writes[0].kind, "text");
  assert.equal(writes[0].args[1], "Sheet: [Alt](https://docs.google.com/spreadsheets/d/[sheet-id]/edit)");
  assert.equal(writes[0].args[2], "Sheet: Alt scenario https://docs.google.com/spreadsheets/d/sheet123/edit");
  assert.equal(writes[0].args[3], "rev1");
});

test("a Note write failure still returns the Sheet URL with note.error", async () => {
  const { deps } = fakeDeps("Text", true);
  const result = await createFreeFormSheet(request!, deps);
  assert.equal(result.url, "https://docs.google.com/spreadsheets/d/sheet123/edit");
  assert.equal(result.note?.linked, false);
  assert.match(result.note?.error ?? "", /revision mismatch/);
});
