import { googleDocEditUrl } from "../google/drive_urls.js";
import { listNotes } from "./notes.js";
import { getNoteRecord, renameDriveFile, upsertNoteDocument } from "./notes_google.js";
import { loadNotesToml } from "../sheet/toml.js";
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
        label: `${row.slug} — ${row.title}`,
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
