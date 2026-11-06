import assert from "node:assert/strict";
import test from "node:test";

import { assertProtectedReplaceAllowed, encodeNoteDocument } from "../../src/note/notes_google.js";

const doc = (body: string) =>
  encodeNoteDocument({ title: "T", tags: [], body, createdAt: "2026-01-01", updatedAt: "2026-01-01", useWhen: "x" });
const big = doc(`## Plan\nkeep\n\n## Log\n${"- entry\n".repeat(200)}`);
const small = doc("## Plan\nkeep\n");

test("a replace that drops most of a Note is refused unless allowShrink is set", () => {
  assert.throws(() => assertProtectedReplaceAllowed("dca", big, small), /drop most of the document/);
  assert.doesNotThrow(() => assertProtectedReplaceAllowed("dca", big, small, true));
});

test("allowShrink never relaxes protected notes or a removed ## Rules section", () => {
  assert.throws(() => assertProtectedReplaceAllowed("house-rules", big, small, true), /drop most of the document/);
  const withRules = doc(`## Rules\nbe nice\n\n## Log\n${"- entry\n".repeat(200)}`);
  assert.throws(() => assertProtectedReplaceAllowed("dca", withRules, small, true), /remove ## Rules/);
});
