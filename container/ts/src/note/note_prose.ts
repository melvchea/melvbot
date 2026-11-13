import { googleDocEditUrl } from "../google/drive_urls.js";
import { listNotes } from "./notes.js";
import { getNoteRecord, renameDriveFile, upsertNoteDocument } from "./notes_google.js";
import { loadNotesToml } from "../sheet/toml.js";
import { NOTES_TABLE, rewriteSheetTomlKey } from "../sheet/toml_rewrite.js";
import { renameOfferDismissals } from "../assistant/conversation_store.js";
import { RESERVED_NOTE_SLUGS } from "./note_schema.js";
import { assembleLinkListLines, type LinkListMessage } from "../telegram/link_list.js";

const NOTE_LIST_RE =
  /^(?:list|show)\s+(?:my\s+)?(?:notes|docs|google\s+docs)$|^my\s+(?:notes|google\s+docs)$/i;

export function parseNoteListDirective(line: string): boolean {
  return NOTE_LIST_RE.test(line.trim());
}

export async function noteListReply(): Promise<LinkListMessage> {
  const notes = await listNotes();
  const ids = loadNotesToml();
  if (!notes.length) {
    return { text: "No Notes.", entities: [] };
  }
  return assembleLinkListLines(
    notes.map((row) => {
      const docId = ids[row.slug];
      return {
        prefix: `${row.slug} — `,
        label: row.title,
        url: docId ? googleDocEditUrl(docId) : undefined,
      };
    }),
    "No Notes.",
  );
}

export async function applyNoteRename(
  slug: string,
  title: string,
): Promise<{ ok: true; slug: string; title: string; oldTitle: string } | { ok: false; message: string }> {
  const cleanedTitle = title.trim();
  if (!cleanedTitle) {
    return { ok: false, message: "Title must not be empty." };
  }
  const docId = loadNotesToml()[slug];
  if (!docId) {
    return { ok: false, message: `Note not found: ${slug}.` };
  }
  const existing = await getNoteRecord(slug, docId);
  if (!existing) {
    return { ok: false, message: `Note not found: ${slug}.` };
  }
  await renameDriveFile(docId, cleanedTitle);
  const now = new Date().toISOString();
  await upsertNoteDocument(slug, docId, {
    title: cleanedTitle,
    tags: existing.tags,
    body: existing.body,
    created_at: existing.created_at,
    updated_at: now,
  });
  return { ok: true, slug, title: cleanedTitle, oldTitle: existing.title };
}

const NOTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Moves a Note to a new slug: same Doc, new key in melvbot.toml. The Doc text holds no slug, so nothing else changes. */
export function applyNoteSlugRename(
  oldSlug: string,
  newSlug: string,
): { ok: true; oldSlug: string; newSlug: string; docId: string } | { ok: false; message: string } {
  if (!NOTE_SLUG_RE.test(newSlug)) {
    return { ok: false, message: `New slug must be lowercase hyphenated; got ${newSlug}.` };
  }
  if (oldSlug === newSlug) {
    return { ok: false, message: "New slug is the same as the old one." };
  }
  if (RESERVED_NOTE_SLUGS.has(oldSlug)) {
    return { ok: false, message: `Note ${oldSlug} is referenced by code or prompts; its slug cannot be changed here.` };
  }
  const ids = loadNotesToml();
  const docId = ids[oldSlug];
  if (!docId) {
    return { ok: false, message: `Note not found: ${oldSlug}.` };
  }
  if (newSlug in ids) {
    return { ok: false, message: `Note ${newSlug} already exists.` };
  }
  rewriteSheetTomlKey({ table: NOTES_TABLE, key: newSlug, value: docId });
  try {
    rewriteSheetTomlKey({ table: NOTES_TABLE, key: oldSlug, value: null });
  } catch (error) {
    rewriteSheetTomlKey({ table: NOTES_TABLE, key: newSlug, value: null });
    throw error;
  }
  renameOfferDismissals(oldSlug, newSlug);
  return { ok: true, oldSlug, newSlug, docId };
}
