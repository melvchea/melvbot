import assert from "node:assert/strict";
import test from "node:test";
import { friendlyCliOutput } from "../src/telegram/receipt_text.js";

// Bug: `note rename-slug` replied with its raw flat receipt JSON instead of the message sentence.
test("friendlyCliOutput shows the message of a flat receipt", () => {
  const json = '{"receipt":true,"action":"note rename-slug","verified":true,"message":"Renamed Note slug: a → b"}';
  assert.equal(friendlyCliOutput(json), "Renamed Note slug: a → b");
});

// Bug: a confirmed "delete spend" replied with the raw {"voided": true, "id": …} JSON.
test("friendlyCliOutput words spend void results as plain text", () => {
  assert.equal(friendlyCliOutput('{\n  "voided": true,\n  "id": 1000088\n}'), "Voided entry 1000088.");
  assert.equal(friendlyCliOutput('{"voided":true,"ids":[1,2]}'), "Voided entries 1, 2.");
});
