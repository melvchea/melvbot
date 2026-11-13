import assert from "node:assert/strict";
import { test } from "node:test";

import { tempDbPath } from "../helpers/temp.js";

process.env.MELVBOT_ASSISTANT_CONVERSATION_DB = tempDbPath();

import { writeFileSync } from "node:fs";
import path from "node:path";

import { setMelvbotEnv } from "../helpers/env.js";
import { tempDir } from "../helpers/temp.js";
import { actionRequiresConfirm } from "../../src/assistant/confirm.js";
import { applyNoteSlugRename } from "../../src/note/note_prose.js";
import { loadNotesToml } from "../../src/sheet/toml.js";

test("slug rename moves the key to the same Doc and refuses reserved, taken, invalid and missing slugs", () => {
  const file = path.join(tempDir("slug-rename-"), "melvbot.toml");
  // Production format: quoted note keys and no trailing newline (regression: the insert used to glue onto the last line).
  writeFileSync(file, '[notes]\n"old-note" = "doc1"\n"other-note" = "doc2"\n"about-me" = "doc3"');
  const restore = setMelvbotEnv({ MELVBOT_TOML: file });
  try {
    assert.deepEqual(applyNoteSlugRename("old-note", "new-note"), { ok: true, oldSlug: "old-note", newSlug: "new-note", docId: "doc1" });
    assert.deepEqual(loadNotesToml(), { "new-note": "doc1", "other-note": "doc2", "about-me": "doc3" });

    const refused = (from: string, to: string) => {
      const result = applyNoteSlugRename(from, to);
      assert.equal(result.ok, false);
    };
    refused("new-note", "other-note"); // target exists: would orphan its Doc
    refused("new-note", "Bad Slug");
    refused("missing", "anything");
    refused("about-me", "me"); // code and prompts depend on it
    assert.deepEqual(loadNotesToml(), { "new-note": "doc1", "other-note": "doc2", "about-me": "doc3" });
  } finally {
    restore();
  }
});

test("slug rename always needs Confirm", () => {
  assert.equal(actionRequiresConfirm("note rename-slug"), true);
});
