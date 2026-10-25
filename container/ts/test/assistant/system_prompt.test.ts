import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { tempDir } from "../helpers/temp.js";
import { writePrompt } from "../helpers/prompts.js";

import {
  buildSystemPrompt,
  clearAboutMeCache,
  clearHouseRulesCache,
  clearNotesIndexCache,
  invalidateNoteCachesForWrite,
} from "../../src/assistant/system_prompt.js";

type NoteFixture = {
  slug: string;
  docId: string;
  title: string;
  tags: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
  useWhen?: string;
};

function noteDocText(note: NoteFixture): string {
  const useWhenLine = note.useWhen ? `\nuse_when: ${note.useWhen}` : "";
  return `title: ${note.title}\ntags: ${JSON.stringify(note.tags)}\ncreated_at: ${note.createdAt}\nupdated_at: ${note.updatedAt}${useWhenLine}\n\n${note.body}`;
}

function installFixtures(notes: NoteFixture[]): {
  dir: string;
  cleanup: () => void;
} {
  const dir = tempDir("assistant-sysprompt-");
  const notesTable = notes.map((note) => `"${note.slug}" = "${note.docId}"`).join("\n");
  writeFileSync(path.join(dir, "melvbot.toml"), `[notes]\n${notesTable}\n`);
  writeFileSync(path.join(dir, "google_token.json"), JSON.stringify({ token: "t" }));
  const docById = new Map(notes.map((note) => [note.docId, note]));
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/batch/drive")) {
      throw new Error("Drive batch endpoint must not be used; list notes with per-file reads");
    }
    const docIdMatch = /files\/([^?]+)\?/.exec(href) ?? /documents\/([^?:]+)/.exec(href);
    const docId = docIdMatch?.[1];
    const note = docId ? docById.get(docId) : undefined;
    if (!note) {
      throw new Error(`unexpected fetch: ${href}`);
    }
    if (href.includes("drive/v3/files/")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            id: note.docId,
            name: note.title,
            trashed: false,
            createdTime: note.createdAt,
            modifiedTime: note.updatedAt,
            appProperties: {
              tags: JSON.stringify(note.tags),
              created_at: note.createdAt,
              use_when: note.useWhen ?? "",
            },
          }),
      } as Response;
    }
    if (href.includes("docs.googleapis.com/v1/documents/")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            documentId: note.docId,
            body: {
              content: [
                { endIndex: 5, paragraph: { elements: [{ textRun: { content: noteDocText(note) } }] } },
              ],
            },
          }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
  process.env.MELVBOT_TOML = path.join(dir, "melvbot.toml");
  process.env.MELVBOT_GOOGLE_HOME = dir;
  return {
    dir,
    cleanup: () => {
      globalThis.fetch = prevFetch;
      clearAboutMeCache();
      clearHouseRulesCache();
      clearNotesIndexCache();
    },
  };
}

test("invalidateNoteCachesForWrite makes a house-rules write visible on the very next buildSystemPrompt call", async () => {
  const houseRulesNote: NoteFixture = {
    slug: "house-rules",
    docId: "doc-house",
    title: "House rules",
    tags: [],
    body: "- OLD RULE",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
  const { cleanup } = installFixtures([houseRulesNote]);
  const promptsDir = tempDir("assistant-prompts-");
  try {
    writePrompt(promptsDir, "learn-sheets-notes", "Recall policy", true, "Always body");

    const before = await buildSystemPrompt(promptsDir);
    assert.match(before.text, /OLD RULE/);

    // Simulate the Confirmed write (the Note body changes) followed by the
    // cache invalidation our write paths call right after `note add`.
    houseRulesNote.body = "- NEW RULE";
    houseRulesNote.updatedAt = "2026-09-21T00:00:00.000Z";
    invalidateNoteCachesForWrite(["note", "add", "house-rules"]);

    // Without invalidation this would still read OLD RULE for up to
    // HOUSE_RULES_CACHE_MS (5 minutes).
    const after = await buildSystemPrompt(promptsDir);
    assert.match(after.text, /NEW RULE/);
    assert.doesNotMatch(after.text, /OLD RULE/);
  } finally {
    cleanup();
  }
});
