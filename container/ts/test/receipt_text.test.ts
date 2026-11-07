import assert from "node:assert/strict";
import test from "node:test";
import { friendlyCliOutput } from "../src/telegram/receipt_text.js";

// Bug: a confirmed "delete spend" replied with the raw {"voided": true, "id": …} JSON.
test("friendlyCliOutput words spend void results as plain text", () => {
  assert.equal(friendlyCliOutput('{\n  "voided": true,\n  "id": 1000088\n}'), "Voided entry 1000088.");
  assert.equal(friendlyCliOutput('{"voided":true,"ids":[1,2]}'), "Voided entries 1, 2.");
});
