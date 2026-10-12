import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import {
  appendNoteHistory,
  assertHouseRulesSize,
  capNoteBodyForRead,
  overwriteGuardError,
  replaceNoteSection,
} from "../src/note/notes.js";
import { runNoteCli } from "../src/note/cli.js";
import { trashDriveFile } from "../src/note/notes_google.js";
import { setMelvbotEnv } from "./helpers/env.js";
import { jsonResponse, stubFetch } from "./helpers/fetch.js";
import { tempDir } from "./helpers/temp.js";

test("appendNoteHistory refuses about-me and house-rules before touching the network", async () => {
  await assert.rejects(() => appendNoteHistory("about-me", "some fact"), /refuses about-me/);
  await assert.rejects(() => appendNoteHistory("house-rules", "some rule"), /refuses house-rules/);
});

test("house-rules write over 1600 chars is refused when it grows the body, allowed when it shrinks or keeps the length", () => {
  assert.throws(() => assertHouseRulesSize("house-rules", "x".repeat(1601), "x".repeat(1500)), /house-rules is 1601\/2000 chars; merge or prune/);
  assert.doesNotThrow(() => assertHouseRulesSize("house-rules", "x".repeat(1700), "x".repeat(1800)));
  assert.doesNotThrow(() => assertHouseRulesSize("house-rules", "x".repeat(1601), "x".repeat(1601)));
});

test("replaceNoteSection requires a known note and --expect-rev before writing", async () => {
  await assert.rejects(() => replaceNoteSection("Bad Slug", "## Rules", "x", "rev"), /lowercase hyphenated/);
  await assert.rejects(() => replaceNoteSection("ok-slug", "Rules", "x", "rev"), /single "## Title" line/);
});

test("overwrite guard skips a Doc this call just created but refuses an already-pinned slug without a revision", () => {
  // new slug: addNote passes no existing record (Doc just created) -> no refusal
  assert.equal(overwriteGuardError("new-note", undefined, {}), null);
  // pinned slug without --expect-rev -> refused with the re-read instruction; with it -> allowed
  assert.match(overwriteGuardError("old-note", "rev1", {}) ?? "", /already exists.*re-read the note \(note get\) and retry/);
  assert.equal(overwriteGuardError("old-note", "rev1", { expectRevisionId: "rev1" }), null);
});

test("note delete trashes the Doc via PATCH trashed, never a permanent Drive DELETE", async () => {
  const dir = tempDir("note-trash-");
  writeFileSync(path.join(dir, "google_token.json"), JSON.stringify({ token: "t" }));
  const restoreEnv = setMelvbotEnv({ MELVBOT_GOOGLE_HOME: dir });
  const stub = stubFetch(() => jsonResponse({}));
  try {
    await trashDriveFile("doc1");
    assert.deepEqual(
      stub.calls.map((call) => [call.init?.method, call.url.pathname, call.init?.body]),
      [["PATCH", "/drive/v3/files/doc1", JSON.stringify({ trashed: true })]],
    );
  } finally {
    stub.restore();
    restoreEnv();
  }
});
