import assert from "node:assert/strict";
import test from "node:test";

import { storeNoteDeleteOffer, takeNoteDeleteOffer } from "../src/telegram/prose_callbacks.js";

test("a delete confirmation offer is single-use and unknown nonces are rejected", () => {
  const nonce = storeNoteDeleteOffer({ slug: "groceries", senderId: 7 });
  assert.deepEqual(takeNoteDeleteOffer(nonce), { slug: "groceries", senderId: 7 });
  assert.equal(takeNoteDeleteOffer(nonce), undefined);
  assert.equal(takeNoteDeleteOffer("forged"), undefined);
});
