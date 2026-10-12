import { googleDocEditUrl } from "../google/drive_urls.js";
import { addNote, deleteNote, getNote, listNotes, PROCEDURE_NOTE_SLUGS } from "./notes.js";
import { getNoteRecord, renameDriveFile, upsertNoteDocument } from "./notes_google.js";
import { loadNotesToml } from "../sheet/toml.js";
import { assembleLinkListLines, type LinkListMessage } from "../telegram/link_list.js";
import { buildNoteDeleteKeyboard, storeNoteCombineOffer, storeNoteDeleteOffer } from "../telegram/prose_callbacks.js";

const NOTE_LIST_RE =
  /^(?:list|show)\s+(?:my\s+)?(?:notes|docs|google\s+docs)$|^my\s+(?:notes|google\s+docs)$/i;
const NOTE_RENAME_RE =
  /^(?:rename|retitle)\s+(?:note|doc|google\s+doc)\s+(.+?)\s+to\s+(.+)$/i;
const NOTE_RENAME_THE_RE =
  /^(?:rename|retitle)\s+(?:the\s+)?(.+?)\s+(?:note|doc|google\s+doc)\s+to\s+(.+)$/i;
const NOTE_CHANGE_TITLE_RE =
  /^change\s+(?:the\s+)?(?:title|name)\s+of\s+(?:the\s+)?(.+?)\s+(?:note|doc|google\s+doc)\s+to\s+(.+)$/i;
const NOTE_DELETE_RE = /^delete\s+(?:note|doc|google\s+doc)\s+(.+)$/i;
const NOTE_DELETE_THE_RE = /^delete\s+the\s+(.+?)\s+(?:note|google\s+doc)$/i;
const NOTE_LINK_RE =
  /^(?:(?:show|get|send)\s+)?(?:google\s+)?(?:doc|document)\s+link(?:\s+(?:to|for))?\s+(.+?)(?:\s+(?:note|google\s+doc))?$/i;
const NOTE_LINK_TO_RE =
  /^link(?:\s+(?:to|for))?\s+(?:the\s+)?(.+?)\s+(?:note|google\s+doc)$/i;
const NOTE_COMBINE_RE =
  /^(?:combine|merge)\s+(?:(?:notes?|docs?|google\s+docs?)\s+)?(.+?)\s+and\s+(.+?)\s+(?:to|into)\s+(.+)$/i;
const NOTE_COMBINE_SOURCES_RE =
  /^(?:combine|merge)\s+(?:(?:notes?|docs?|google\s+docs?)\s+)?(.+?)\s+and\s+(.+?)$/i;

export type NoteCombineDirective = {
  left: string;
  right: string;
  target: string | null;
};
const NOTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseNoteListDirective(line: string): boolean {
  return NOTE_LIST_RE.test(line.trim());
}

export function parseNoteRenameDirective(line: string): { target: string; title: string } | null {
  const trimmed = line.trim();
  const matched = NOTE_RENAME_RE.exec(trimmed) ?? NOTE_RENAME_THE_RE.exec(trimmed) ?? NOTE_CHANGE_TITLE_RE.exec(trimmed);
  if (!matched?.[1]?.trim() || !matched[2]?.trim()) {
    return null;
  }
  return { target: matched[1].trim(), title: matched[2].trim() };
}

export function parseNoteDeleteDirective(line: string): string | null {
  const trimmed = line.trim();
  const matched = NOTE_DELETE_RE.exec(trimmed) ?? NOTE_DELETE_THE_RE.exec(trimmed);
  const target = matched?.[1]?.trim();
  return target || null;
}

export function parseNoteLinkDirective(line: string): string | null {
  const trimmed = line.trim();
  const matched = NOTE_LINK_RE.exec(trimmed) ?? NOTE_LINK_TO_RE.exec(trimmed);
  const target = matched?.[1]?.trim();
  return target || null;
}

export function parseNoteCombineDirective(line: string): NoteCombineDirective | null {
  const trimmed = line.trim();
  const matched = NOTE_COMBINE_RE.exec(trimmed);
  const left = matched?.[1]?.trim();
  const right = matched?.[2]?.trim();
  const target = matched?.[3]?.trim();
  if (left && right && target) {
    return { left, right, target };
  }
  const sources = NOTE_COMBINE_SOURCES_RE.exec(trimmed);
  const sourceLeft = sources?.[1]?.trim();
  const sourceRight = sources?.[2]?.trim();
  if (!sourceLeft || !sourceRight) {
    return null;
  }
  if (/\s+(?:to|into)\s+/i.test(sourceRight)) {
    return null;
  }
  return { left: sourceLeft, right: sourceRight, target: null };
}

export function noteCombineMissingTargetReply(left: string, right: string): string {
  return `Name the new Note slug: combine Notes ${left} and ${right} to <new-slug>`;
}

function resolveTargetSlug(target: string): string {
  const cleaned = normalizeLookup(target).replace(/\s+/g, "-");
  if (!NOTE_SLUG_RE.test(cleaned)) {
    throw new Error(`target slug must be lowercase hyphenated words (example: melvbot-llm-stack); got ${target}`);
  }
  return cleaned;
}

export function mergeNoteBodies(
  sources: Array<{ slug: string; title: string; body: string; tags: string[] }>,
): { title: string; body: string; tags: string[] } {
  const tags = [...new Set(sources.flatMap((source) => source.tags))];
  const title = sources.map((source) => source.title).join(" + ");
  const body = sources
    .map((source) => `# ${source.title} (${source.slug})\n\n${source.body.trim()}`)
    .join("\n\n---\n\n");
  return { title, body, tags };
}

function normalizeLookup(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function slugAsWords(slug: string): string {
  return normalizeLookup(slug.replace(/-/g, " "));
}

function needleAsSlug(needle: string): string {
  return needle.trim().replace(/\s+/g, "-").toLowerCase();
}

function singularizeLastWord(phrase: string): string {
  const words = phrase.split(" ");
  const last = words[words.length - 1] ?? "";
  if (last.endsWith("s") && last.length > 2 && !last.endsWith("ss")) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(" ");
}

function titlePrefixMatches(title: string, needle: string): boolean {
  const titleWords = normalizeLookup(title).split(" ");
  const needleWords = needle.split(" ");
  if (needleWords.length > titleWords.length) {
    return false;
  }
  return needleWords.every((word, index) => titleWords[index] === word);
}

type NoteIndexRow = Awaited<ReturnType<typeof listNotes>>[number];

function resolveUniqueSlugHits(
  notes: NoteIndexRow[],
  match: (row: NoteIndexRow) => boolean,
): { slug: string } | { ambiguous: string[] } | null {
  const hits = notes.filter(match);
  if (hits.length === 1) {
    return { slug: hits[0].slug };
  }
  if (hits.length > 1) {
    return { ambiguous: [...new Set(hits.map((row) => row.slug))] };
  }
  return null;
}

export async function resolveNoteSlug(target: string): Promise<
  { slug: string } | { ambiguous: string[] } | null
> {
  const needle = normalizeLookup(target);
  const notes = await listNotes();
  const singularNeedle = singularizeLastWord(needle);
  const strategies: Array<{ id: string; match: (row: NoteIndexRow) => boolean }> = [
    { id: "exact-slug", match: (row) => normalizeLookup(row.slug) === needle },
    { id: "exact-title", match: (row) => normalizeLookup(row.title) === needle },
    { id: "hyphenated-slug", match: (row) => row.slug === needleAsSlug(needle) },
    { id: "slug-as-words", match: (row) => slugAsWords(row.slug) === needle },
    {
      id: "slug-as-words-singular",
      match: (row) => slugAsWords(row.slug) === singularNeedle,
    },
    { id: "title-prefix", match: (row) => titlePrefixMatches(row.title, needle) },
  ];
  for (const strategy of strategies) {
    const result = resolveUniqueSlugHits(notes, strategy.match);
    if (result !== null) {
      return result;
    }
  }
  return null;
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

export async function noteLinkReply(target: string): Promise<string> {
  const resolved = await resolveNoteSlug(target);
  if (resolved === null) {
    return "No matching Note.";
  }
  if ("ambiguous" in resolved) {
    return `Ambiguous Note name (${resolved.ambiguous.join(", ")}).`;
  }
  const docId = loadNotesToml()[resolved.slug];
  if (!docId) {
    return `Note not found: ${resolved.slug}.`;
  }
  return googleDocEditUrl(docId);
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

export function isProcedureNoteSlug(slug: string): boolean {
  return (PROCEDURE_NOTE_SLUGS as readonly string[]).includes(slug);
}

export type NoteDeleteIntercept =
  | { kind: "refuse"; slug: string }
  | { kind: "confirm"; slug: string; nonce: string; message: string }
  | { kind: "ambiguous"; slugs: string[] }
  | { kind: "not_found" };

export async function planNoteDelete(target: string, senderId: number): Promise<NoteDeleteIntercept> {
  const resolved = await resolveNoteSlug(target);
  if (resolved === null) {
    return { kind: "not_found" };
  }
  if ("ambiguous" in resolved) {
    return { kind: "ambiguous", slugs: resolved.ambiguous };
  }
  if (isProcedureNoteSlug(resolved.slug)) {
    return { kind: "refuse", slug: resolved.slug };
  }
  const nonce = storeNoteDeleteOffer({ slug: resolved.slug, senderId });
  return {
    kind: "confirm",
    slug: resolved.slug,
    nonce,
    message: `Delete Note ${resolved.slug}?`,
  };
}

export function noteDeleteCard(
  slug: string,
  senderId: number,
): { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const nonce = storeNoteDeleteOffer({ slug, senderId });
  return {
    text: `Delete Note ${slug}?`,
    reply_markup: buildNoteDeleteKeyboard(nonce),
  };
}

export type NoteCombineIntercept =
  | { kind: "invalid_target"; message: string }
  | { kind: "source_missing" }
  | { kind: "ambiguous"; slugs: string[] }
  | { kind: "confirm"; targetSlug: string; sourceSlugs: string[]; replace: boolean; nonce: string; message: string };

export async function planNoteCombine(
  left: string,
  right: string,
  target: string,
  senderId: number,
): Promise<NoteCombineIntercept> {
  let targetSlug: string;
  try {
    targetSlug = resolveTargetSlug(target);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { kind: "invalid_target", message: detail };
  }
  const targetExists = Boolean(loadNotesToml()[targetSlug]);
  const leftResolved = await resolveNoteSlug(left);
  const rightResolved = await resolveNoteSlug(right);
  if (leftResolved === null || rightResolved === null) {
    return { kind: "source_missing" };
  }
  if ("ambiguous" in leftResolved) {
    return { kind: "ambiguous", slugs: leftResolved.ambiguous };
  }
  if ("ambiguous" in rightResolved) {
    return { kind: "ambiguous", slugs: rightResolved.ambiguous };
  }
  if (leftResolved.slug === rightResolved.slug) {
    return { kind: "source_missing" };
  }
  const leftNote = await getNote(leftResolved.slug);
  const rightNote = await getNote(rightResolved.slug);
  const merged = mergeNoteBodies([
    { slug: leftNote.slug, title: leftNote.title, body: leftNote.body, tags: leftNote.tags },
    { slug: rightNote.slug, title: rightNote.title, body: rightNote.body, tags: rightNote.tags },
  ]);
  const sourceSlugs = [leftNote.slug, rightNote.slug];
  const message = targetExists
    ? `Replace Note ${targetSlug} with ${sourceSlugs.join(" + ")}?`
    : `Create Note ${targetSlug} from ${sourceSlugs.join(" + ")}?`;
  const nonce = storeNoteCombineOffer({
    targetSlug,
    title: merged.title,
    body: merged.body,
    tags: merged.tags,
    senderId,
  });
  return { kind: "confirm", targetSlug, sourceSlugs, replace: targetExists, nonce, message };
}

export async function executeNoteCombine(offer: {
  targetSlug: string;
  title: string;
  body: string;
  tags: string[];
}): Promise<{ slug: string; url: string }> {
  const targetExists = Boolean(loadNotesToml()[offer.targetSlug]);
  const expectRevisionId = targetExists ? (await getNote(offer.targetSlug)).revision_id : undefined;
  await addNote({
    slug: offer.targetSlug,
    title: offer.title,
    body: offer.body,
    tags: offer.tags,
    expectRevisionId,
  });
  return { slug: offer.targetSlug, url: googleDocEditUrl(loadNotesToml()[offer.targetSlug]) };
}

export async function executeNoteDelete(slug: string): Promise<void> {
  await deleteNote(slug);
}
