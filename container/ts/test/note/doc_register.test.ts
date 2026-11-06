import assert from "node:assert/strict";
import test from "node:test";

import { upsertNoteDocument } from "../../src/note/notes_google.js";

test("a note write without a registered Doc is refused, so no unpinned Google Doc is ever created", async () => {
  const record = { title: "T", tags: [], body: "x", created_at: "2026-01-01", updated_at: "2026-01-01" };
  await assert.rejects(() => upsertNoteDocument("dca", undefined, record), /without a registered Doc/);
});
