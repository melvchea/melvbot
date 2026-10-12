import { googleDocEditUrl } from "../google/drive_urls.js";
import { loadNotesToml } from "../sheet/toml.js";
import { NOTES_TABLE, rewriteSheetTomlKey } from "../sheet/toml_rewrite.js";
import { buildBodyDiffReceipt, recordChange, type WriteReceipt } from "../memory/change_log.js";
import { currentSourceRef } from "../source_ref.js";
import {
  assertDriveFileNotTrashed,
  createNoteDocument,
  getNoteRecord,
  listNoteIndexes,
  restoreTrashedDriveFile,
  trashDriveFile,
  upsertNoteDocument,
} from "./notes_google.js";

import { PROCEDURE_NOTE_SLUGS, validateProcedureNoteBody } from "./note_schema.js";
import { HOUSE_RULES_MAX_CHARS, HOUSE_RULES_SLUG, HOUSE_RULES_WRITE_MAX_CHARS } from "../assistant/system_prompt.js";

export { PROCEDURE_NOTE_SLUGS };

/** house-rules rides in every system prompt, so a write may not grow it past the write cap (shrinking or same-length writes pass). */
export function assertHouseRulesSize(slug: string, body: string, previousBody: string): void {
  if (slug !== HOUSE_RULES_SLUG || body.length <= HOUSE_RULES_WRITE_MAX_CHARS || body.length <= previousBody.length) {
    return;
  }
  throw new Error(
    `house-rules is ${body.length}/${HOUSE_RULES_MAX_CHARS} chars; merge or prune existing rules (replace-text/replace-section) before adding more`,
  );
}
const NOTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIMILAR_TOKEN_MIN_LENGTH = 4;
const HISTORY_HEADING = "## History";
const NO_HISTORY_WRITE_SLUGS = new Set<string>(["about-me", "house-rules"]);

export function findSimilarNoteSlugs(
  title: string,
  slug: string,
  notes: ReadonlyArray<{ slug: string; title: string }>,
): string[] {
  const tokens = new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= SIMILAR_TOKEN_MIN_LENGTH),
  );
  const hits: string[] = [];
  for (const note of notes) {
    if (note.slug === slug) {
      continue;
    }
    const overlap = note.title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= SIMILAR_TOKEN_MIN_LENGTH && tokens.has(token));
    if (overlap.length >= 2) {
      hits.push(note.slug);
    }
  }
  return hits;
}

export function validateSlug(slug: string): string {
  const cleaned = slug.trim();
  if (!NOTE_SLUG_RE.test(cleaned)) {
    throw new Error(`slug must be lowercase hyphenated words (example: phone-buy); got ${slug}`);
  }
  return cleaned;
}

function validateTitle(title: string): string {
  const cleaned = title.trim();
  if (!cleaned) {
    throw new Error("title must not be empty");
  }
  return cleaned;
}

function validateBody(body: string): string {
  const cleaned = body.trim();
  if (!cleaned) {
    throw new Error("body must not be empty");
  }
  return cleaned;
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const cleaned = tag.trim();
    if (!cleaned) {
      continue;
    }
    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

export async function listNotes(tag?: string): Promise<
  Array<{ slug: string; title: string; tags: string[]; created_at: string; updated_at: string; use_when: string }>
> {
  const filter = tag === undefined ? null : tag.trim();
  if (tag !== undefined && !filter) {
    throw new Error("tag filter must not be empty");
  }
  return listNoteIndexes(loadNotesToml(), filter);
}

export async function getNote(slug: string): Promise<{
  slug: string;
  title: string;
  tags: string[];
  body: string;
  created_at: string;
  updated_at: string;
  use_when: string;
  revision_id: string;
  last_source_ref: string;
  url: string;
}> {
  const cleaned = validateSlug(slug);
  const docId = loadNotesToml()[cleaned];
  if (!docId) {
    throw new Error(`note not found: ${cleaned}`);
  }
  const record = await getNoteRecord(cleaned, docId);
  if (record === null) {
    throw new Error(`note not found: ${cleaned}`);
  }
  return { ...record, last_source_ref: record.last_source_ref, url: googleDocEditUrl(docId) };
}

/** Body cap for `note get` output; longer bodies get a truncation marker (write paths read the full body). */
export const NOTE_GET_MAX_CHARS = 12_000;

export function capNoteBodyForRead(body: string, maxChars = NOTE_GET_MAX_CHARS): string {
  if (body.length <= maxChars) {
    return body;
  }
  return `${body.slice(0, maxChars)}\n[truncated, ${body.length - maxChars} chars omitted]`;
}

async function pinNoteSlug(slug: string, docId: string): Promise<void> {
  rewriteSheetTomlKey({ table: NOTES_TABLE, key: slug, value: docId });
}

async function unpinNoteSlug(slug: string): Promise<void> {
  rewriteSheetTomlKey({ table: NOTES_TABLE, key: slug, value: null });
}

async function rollbackCreatedNote(createdDocId: string | undefined, slug: string): Promise<void> {
  if (createdDocId === undefined) {
    return;
  }
  let trashError: unknown;
  try {
    await trashDriveFile(createdDocId);
  } catch (error) {
    trashError = error;
  }
  try {
    await unpinNoteSlug(slug);
  } catch {
    /* pin may be absent */
  }
  if (trashError !== undefined) {
    throw new Error(
      `failed after creating note ${slug}; orphaned Doc ${createdDocId} (trash failed: ${String(trashError)})`,
    );
  }
}

type NoteSnapshot = {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  use_when: string;
  docId: string;
  revision_id?: string;
};

function noteSnapshot(record: Awaited<ReturnType<typeof getNote>>): NoteSnapshot {
  const docId = loadNotesToml()[record.slug] ?? "";
  return {
    slug: record.slug,
    title: record.title,
    body: record.body,
    tags: record.tags,
    use_when: record.use_when,
    docId,
    revision_id: record.revision_id,
  };
}

export function overwriteGuardError(
  slug: string,
  existingRevisionId: string | undefined,
  options: { expectRevisionId?: string },
): string | null {
  if (existingRevisionId === undefined || options.expectRevisionId !== undefined) {
    return null;
  }
  return `note ${slug} already exists: re-read the note (note get) and retry with --expect-rev before replacing the body`;
}

export async function addNote(options: {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  docId?: string;
  useWhen?: string;
  expectRevisionId?: string;
  skipChangeLog?: boolean;
  internalWrite?: boolean;
  changeAction?: string;
  chatKey?: string | null;
}): Promise<{
  inserted: boolean;
  pinned: boolean;
  similar_slugs: string[];
  note: Awaited<ReturnType<typeof getNote>>;
  receipt?: WriteReceipt;
}> {
  const slug = validateSlug(options.slug);
  const title = validateTitle(options.title);
  const body = validateBody(options.body);
  const tags = normalizeTags(options.tags);
  const existingIds = loadNotesToml();
  const wasNew = !(slug in existingIds);
  if (wasNew && options.docId === undefined) {
    validateProcedureNoteBody(slug, body);
  }
  let createdDocId: string | undefined;
  let pinned = false;
  try {
    if (options.docId !== undefined) {
      const attached = options.docId.trim();
      if (!attached) {
        throw new Error("--doc-id must not be empty");
      }
      await assertDriveFileNotTrashed(attached, `note ${slug}`);
      await pinNoteSlug(slug, attached);
      pinned = true;
    } else if (!(slug in existingIds)) {
      createdDocId = await createNoteDocument(title);
      await pinNoteSlug(slug, createdDocId);
      pinned = true;
    }
    const now = new Date().toISOString();
    const pinnedIds = loadNotesToml();
    // A Doc this call just created is empty and new: no overwrite guard, no "before" snapshot.
    const existing =
      pinnedIds[slug] && createdDocId === undefined ? await getNoteRecord(slug, pinnedIds[slug]) : null;
    const guardError = overwriteGuardError(slug, existing?.revision_id, options);
    if (guardError) {
      throw new Error(guardError);
    }
    if (!(wasNew && options.docId === undefined)) {
      validateProcedureNoteBody(slug, body, existing?.body);
    }
    assertHouseRulesSize(slug, body, existing?.body ?? "");
    const createdAt = existing?.created_at || now;
    const useWhen = options.useWhen !== undefined ? options.useWhen.trim() : existing?.use_when || "";
    const beforeSnapshot =
      existing && pinnedIds[slug]
        ? {
            slug,
            title: existing.title,
            body: existing.body,
            tags: existing.tags,
            use_when: existing.use_when,
            docId: pinnedIds[slug],
          }
        : null;
    const persisted = await upsertNoteDocument(
      slug,
      pinnedIds[slug],
      {
        title,
        tags,
        body,
        created_at: createdAt,
        updated_at: now,
        use_when: useWhen,
      },
      { expectRevisionId: options.expectRevisionId },
    );
    if (!(slug in pinnedIds) && persisted.docId) {
      await pinNoteSlug(slug, persisted.docId);
      pinned = true;
    }
    const finalDocId = loadNotesToml()[slug];
    let similarSlugs: string[] = [];
    try {
      similarSlugs = findSimilarNoteSlugs(title, slug, await listNotes());
    } catch {
      similarSlugs = [];
    }
    const note = {
      slug,
      title,
      tags,
      body,
      created_at: createdAt,
      updated_at: now,
      use_when: useWhen,
      revision_id: persisted.revision_id,
      last_source_ref: currentSourceRef(),
      url: googleDocEditUrl(finalDocId),
    };
    let receipt: WriteReceipt | undefined;
    if (!options.skipChangeLog && !options.internalWrite) {
      const loggedAction = options.changeAction ?? "note add";
      const changeId = recordChange({
        action: loggedAction,
        target: slug,
        before: beforeSnapshot,
        after: noteSnapshot(note),
        chatKey: options.chatKey ?? null,
      });
      receipt = buildBodyDiffReceipt(loggedAction, slug, beforeSnapshot?.body ?? null, body, changeId, {
        url: note.url,
        updatedAt: note.updated_at,
        revisionId: note.revision_id,
        sourceRef: currentSourceRef(),
      });
    }
    return {
      inserted: wasNew,
      pinned,
      similar_slugs: similarSlugs,
      note,
      receipt,
    };
  } catch (error) {
    await rollbackCreatedNote(createdDocId, slug);
    throw error;
  }
}

export async function describeNote(
  slug: string,
  useWhen: string,
  addTags: string[] = [],
  expectRevisionId?: string,
): Promise<Awaited<ReturnType<typeof getNote>>> {
  const cleaned = validateSlug(slug);
  const cleanedUseWhen = useWhen.trim();
  if (!cleanedUseWhen) {
    throw new Error("use_when must not be empty");
  }
  const existing = await getNote(cleaned);
  if (expectRevisionId === undefined) {
    throw new Error(
      `note ${cleaned}: re-read the note (note get) and retry with --expect-rev before describe`,
    );
  }
  const tags = normalizeTags([...existing.tags, ...addTags]);
  const docId = loadNotesToml()[cleaned];
  const persisted = await upsertNoteDocument(
    cleaned,
    docId,
    {
      title: existing.title,
      tags,
      body: existing.body,
      created_at: existing.created_at,
      updated_at: existing.updated_at,
      use_when: cleanedUseWhen,
    },
    { expectRevisionId },
  );
  return { ...existing, tags, use_when: cleanedUseWhen, revision_id: persisted.revision_id };
}

export function insertAutoHistoryLine(body: string, line: string): string {
  const headingIndex = body.indexOf(HISTORY_HEADING);
  if (headingIndex === -1) {
    const separator = body.trim() ? "\n\n" : "";
    return `${body}${separator}${HISTORY_HEADING}\n${line}\n`;
  }
  const afterHeading = headingIndex + HISTORY_HEADING.length;
  const before = body.slice(0, afterHeading);
  const after = body.slice(afterHeading);
  const nextHeadingMatch = /\n##\s/.exec(after.slice(1));
  const insertAt = nextHeadingMatch ? 1 + nextHeadingMatch.index : after.length;
  const section = after.slice(0, insertAt).replace(/\s*$/, "");
  const rest = after.slice(insertAt);
  return `${before}${section}\n${line}${rest}`;
}

const SECTION_HEADING_RE = /^##\s+\S[^\n]*$/;

export type SectionPosition = "top" | "bottom";

export function validateSectionHeading(heading: string): string {
  const cleaned = heading.trim();
  if (!SECTION_HEADING_RE.test(cleaned)) {
    throw new Error(`section heading must be a single "## Title" line; got ${heading}`);
  }
  return cleaned;
}

/**
 * Replaces the text under `heading` (up to the next `#`/`##` heading), leaving
 * every other section untouched. A missing heading is inserted at `position`.
 */
export function replaceSectionInBody(
  body: string,
  heading: string,
  content: string,
  position: SectionPosition = "top",
): string {
  const cleanedHeading = validateSectionHeading(heading);
  const contentLines = content.trim().split("\n");
  if (contentLines[0].trim() === cleanedHeading) {
    contentLines.shift();
  }
  const cleanedContent = contentLines.join("\n").trim();
  if (!cleanedContent) {
    throw new Error("section content must not be empty");
  }
  const block = [cleanedHeading, ...cleanedContent.split("\n")];
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === cleanedHeading);
  if (start === -1) {
    const trimmed = body.trim();
    if (!trimmed) {
      return block.join("\n");
    }
    return position === "top" ? `${block.join("\n")}\n\n${body.replace(/^\s+/, "")}` : `${body.replace(/\s+$/, "")}\n\n${block.join("\n")}`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const after = lines.slice(end);
  return [...lines.slice(0, start), ...block, ...(after.length > 0 ? [""] : []), ...after].join("\n");
}

/**
 * Section-scoped write: replaces (or inserts) one `## Heading` section and
 * keeps the rest of the Note, so large Notes can be restructured without a
 * full-body replace.
 */
export async function replaceNoteSection(
  slug: string,
  heading: string,
  content: string,
  expectRevisionId?: string,
  options: { position?: SectionPosition; skipChangeLog?: boolean; chatKey?: string | null } = {},
): Promise<{ receipt?: WriteReceipt }> {
  const cleaned = validateSlug(slug);
  const cleanedHeading = validateSectionHeading(heading);
  const docId = loadNotesToml()[cleaned];
  if (!docId) {
    throw new Error(`note not found: ${cleaned}`);
  }
  const existing = await getNoteRecord(cleaned, docId);
  if (existing === null) {
    throw new Error(`note not found: ${cleaned}`);
  }
  if (expectRevisionId === undefined) {
    throw new Error(
      `note ${cleaned}: re-read the note (note get) and retry with --expect-rev before replace-section`,
    );
  }
  const body = replaceSectionInBody(existing.body, cleanedHeading, content, options.position ?? "top");
  validateProcedureNoteBody(cleaned, body, existing.body);
  assertHouseRulesSize(cleaned, body, existing.body);
  const beforeSnapshot: NoteSnapshot = {
    slug: cleaned,
    title: existing.title,
    body: existing.body,
    tags: existing.tags,
    use_when: existing.use_when,
    docId,
  };
  const now = new Date().toISOString();
  const persisted = await upsertNoteDocument(
    cleaned,
    docId,
    {
      title: existing.title,
      tags: existing.tags,
      body,
      created_at: existing.created_at,
      updated_at: now,
      use_when: existing.use_when,
    },
    { expectRevisionId },
  );
  let receipt: WriteReceipt | undefined;
  if (!options.skipChangeLog) {
    const afterNote = {
      slug: cleaned,
      title: existing.title,
      body,
      tags: existing.tags,
      use_when: existing.use_when,
      created_at: existing.created_at,
      updated_at: now,
      revision_id: persisted.revision_id,
      last_source_ref: currentSourceRef(),
      url: googleDocEditUrl(docId),
    };
    const changeId = recordChange({
      action: "note replace-section",
      target: cleaned,
      before: beforeSnapshot,
      after: noteSnapshot(afterNote),
      chatKey: options.chatKey ?? null,
    });
    receipt = buildBodyDiffReceipt("note replace-section", cleaned, existing.body, body, changeId, {
      url: afterNote.url,
      updatedAt: now,
      revisionId: persisted.revision_id,
      sourceRef: currentSourceRef(),
    });
  }
  return { receipt };
}

/** Replaces the single occurrence of `oldText` in `body`; throws with the count when it is not exactly one. */
export function replaceTextInBody(body: string, oldText: string, newText: string): string {
  if (!oldText) {
    throw new Error("old text must not be empty");
  }
  const count = body.split(oldText).length - 1;
  if (count === 0) {
    throw new Error("old text not found in note body (0 matches); run note get and copy the exact text");
  }
  if (count > 1) {
    throw new Error(`old text matches ${count} places in note body; include more surrounding text so it is unique`);
  }
  const at = body.indexOf(oldText);
  return body.slice(0, at) + newText + body.slice(at + oldText.length);
}

/**
 * Exact-text write: replaces one unique occurrence of `oldText` with `newText`
 * (empty deletes it) and keeps the rest of the Note, for small edits.
 */
export async function replaceNoteText(
  slug: string,
  oldText: string,
  newText: string,
  expectRevisionId?: string,
  options: { skipChangeLog?: boolean; chatKey?: string | null } = {},
): Promise<{ receipt?: WriteReceipt }> {
  const cleaned = validateSlug(slug);
  const docId = loadNotesToml()[cleaned];
  if (!docId) {
    throw new Error(`note not found: ${cleaned}`);
  }
  const existing = await getNoteRecord(cleaned, docId);
  if (existing === null) {
    throw new Error(`note not found: ${cleaned}`);
  }
  if (expectRevisionId === undefined) {
    throw new Error(
      `note ${cleaned}: re-read the note (note get) and retry with --expect-rev before replace-text`,
    );
  }
  const body = replaceTextInBody(existing.body, oldText, newText);
  validateProcedureNoteBody(cleaned, body, existing.body);
  assertHouseRulesSize(cleaned, body, existing.body);
  const beforeSnapshot: NoteSnapshot = {
    slug: cleaned,
    title: existing.title,
    body: existing.body,
    tags: existing.tags,
    use_when: existing.use_when,
    docId,
  };
  const now = new Date().toISOString();
  const persisted = await upsertNoteDocument(
    cleaned,
    docId,
    {
      title: existing.title,
      tags: existing.tags,
      body,
      created_at: existing.created_at,
      updated_at: now,
      use_when: existing.use_when,
    },
    { expectRevisionId },
  );
  let receipt: WriteReceipt | undefined;
  if (!options.skipChangeLog) {
    const afterNote = {
      slug: cleaned,
      title: existing.title,
      body,
      tags: existing.tags,
      use_when: existing.use_when,
      created_at: existing.created_at,
      updated_at: now,
      revision_id: persisted.revision_id,
      last_source_ref: currentSourceRef(),
      url: googleDocEditUrl(docId),
    };
    const changeId = recordChange({
      action: "note replace-text",
      target: cleaned,
      before: beforeSnapshot,
      after: noteSnapshot(afterNote),
      chatKey: options.chatKey ?? null,
    });
    receipt = buildBodyDiffReceipt("note replace-text", cleaned, existing.body, body, changeId, {
      url: afterNote.url,
      updatedAt: now,
      revisionId: persisted.revision_id,
      sourceRef: currentSourceRef(),
    });
  }
  return { receipt };
}

/**
 * Append-only write used by promote-to-note: adds one dated (auto) line
 * under `## History`, creating the heading if it's missing. Leaves every
 * other section byte-identical.
 */
export async function appendNoteHistory(
  slug: string,
  text: string,
  expectRevisionId?: string,
  options: { skipChangeLog?: boolean; chatKey?: string | null } = {},
): Promise<{ receipt?: WriteReceipt }> {
  const cleaned = validateSlug(slug);
  if (NO_HISTORY_WRITE_SLUGS.has(cleaned)) {
    throw new Error(`note append-history refuses ${cleaned}`);
  }
  const cleanedText = text.trim();
  if (!cleanedText) {
    throw new Error("text must not be empty");
  }
  const docId = loadNotesToml()[cleaned];
  if (!docId) {
    throw new Error(`note not found: ${cleaned}`);
  }
  const existing = await getNoteRecord(cleaned, docId);
  if (existing === null) {
    throw new Error(`note not found: ${cleaned}`);
  }
  if (expectRevisionId === undefined) {
    throw new Error(
      `note ${cleaned}: re-read the note (note get) and retry with --expect-rev before append-history`,
    );
  }
  const dateStamp = new Date().toISOString().slice(0, 10);
  const line = `- ${dateStamp} (auto) ${cleanedText}`;
  const body = insertAutoHistoryLine(existing.body, line);
  const beforeSnapshot: NoteSnapshot = {
    slug: cleaned,
    title: existing.title,
    body: existing.body,
    tags: existing.tags,
    use_when: existing.use_when,
    docId,
  };
  const now = new Date().toISOString();
  const persisted = await upsertNoteDocument(
    cleaned,
    docId,
    {
      title: existing.title,
      tags: existing.tags,
      body,
      created_at: existing.created_at,
      updated_at: now,
      use_when: existing.use_when,
    },
    { expectRevisionId },
  );
  let receipt: WriteReceipt | undefined;
  if (!options.skipChangeLog) {
    const afterNote = {
      slug: cleaned,
      title: existing.title,
      body,
      tags: existing.tags,
      use_when: existing.use_when,
      created_at: existing.created_at,
      updated_at: now,
      revision_id: persisted.revision_id,
      last_source_ref: currentSourceRef(),
      url: googleDocEditUrl(docId),
    };
    const changeId = recordChange({
      action: "note append-history",
      target: cleaned,
      before: beforeSnapshot,
      after: noteSnapshot(afterNote),
      chatKey: options.chatKey ?? null,
    });
    receipt = buildBodyDiffReceipt("note append-history", cleaned, existing.body, body, changeId, {
      url: afterNote.url,
      updatedAt: now,
      revisionId: persisted.revision_id,
      sourceRef: currentSourceRef(),
    });
  }
  return { receipt };
}

export async function deleteNote(
  slug: string,
  options: { skipChangeLog?: boolean; chatKey?: string | null } = {},
): Promise<{ trashed: true; slug: string; docId: string; receipt?: WriteReceipt }> {
  const cleaned = validateSlug(slug);
  if ((PROCEDURE_NOTE_SLUGS as readonly string[]).includes(cleaned)) {
    throw new Error(`refusing to delete procedure note: ${cleaned}`);
  }
  const docId = loadNotesToml()[cleaned];
  if (!docId) {
    throw new Error(`note not found: ${cleaned}`);
  }
  const existing = await getNoteRecord(cleaned, docId);
  if (existing === null) {
    throw new Error(`note not found: ${cleaned}`);
  }
  const beforeSnapshot: NoteSnapshot = {
    slug: cleaned,
    title: existing.title,
    body: existing.body,
    tags: existing.tags,
    use_when: existing.use_when,
    docId,
  };
  await trashDriveFile(docId);
  await unpinNoteSlug(cleaned);
  let receipt: WriteReceipt | undefined;
  if (!options.skipChangeLog) {
    const changeId = recordChange({
      action: "note delete",
      target: cleaned,
      before: beforeSnapshot,
      after: null,
      chatKey: options.chatKey ?? null,
    });
    receipt = {
      receipt: true,
      action: "note delete",
      target: cleaned,
      verified: true,
      changeId,
      url: googleDocEditUrl(docId),
    };
  }
  return { trashed: true, slug: cleaned, docId, receipt };
}

/** Undo of a Note creation: trashes the Doc and drops the slug pin. */
export async function trashCreatedNote(slug: string): Promise<void> {
  const cleaned = validateSlug(slug);
  const docId = loadNotesToml()[cleaned];
  if (!docId) {
    throw new Error(`note not found: ${cleaned}`);
  }
  await trashDriveFile(docId);
  await unpinNoteSlug(cleaned);
}

export async function restoreNote(slug: string, docId?: string): Promise<Awaited<ReturnType<typeof getNote>>> {
  const cleaned = validateSlug(slug);
  const resolvedDocId = docId?.trim() || loadNotesToml()[cleaned];
  if (!resolvedDocId) {
    throw new Error(`note restore needs doc id for ${cleaned}`);
  }
  await restoreTrashedDriveFile(resolvedDocId);
  await assertDriveFileNotTrashed(resolvedDocId, `note ${cleaned}`);
  await pinNoteSlug(cleaned, resolvedDocId);
  return getNote(cleaned);
}
