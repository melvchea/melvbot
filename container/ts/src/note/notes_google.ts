import {
  delay,
  GOOGLE_FETCH_TIMEOUT_MS,
  googleRetryAfterMs,
  googleRetryDelayMs,
  GoogleHttpError,
  GOOGLE_RETRY_LIMIT,
  isGoogleTimeout,
  shouldRetryGoogleStatus,
} from "../google/retry.js";
import { googleAccessToken } from "../google/token.js";
import { currentSourceRef } from "../source_ref.js";

const DOC_BODY_START_INDEX = 1;
export const NOTE_FORMAT_VERSION = 1;
/** Shared tail of every note-write error that means "read again, then retry" (conflict or timeout). */
export const NOTE_RETRY_HINT = "Re-read the note (note get) and retry with --expect-rev.";
const DRIVE_LIST_PAGE_SIZE = 100;
const DESTRUCTIVE_SHRINK_CHARS = 500;
const DESTRUCTIVE_RETAINED_NUMERATOR = 1;
const DESTRUCTIVE_RETAINED_DENOMINATOR = 2;
const PROTECTED_NOTE_SLUGS = new Set(["about-me", "house-rules"]);
const RULES_HEADING = "## Rules";

function isDestructiveShrink(beforeChars: number, newChars: number, protectedNote = false): boolean {
  const shrinkChars = beforeChars - newChars;
  const charCap = protectedNote ? 200 : DESTRUCTIVE_SHRINK_CHARS;
  if (shrinkChars <= charCap) {
    return false;
  }
  const retainedNumerator = protectedNote ? 4 : DESTRUCTIVE_RETAINED_NUMERATOR;
  const retainedDenominator = protectedNote ? 5 : DESTRUCTIVE_RETAINED_DENOMINATOR;
  return newChars * retainedDenominator < beforeChars * retainedNumerator;
}

function rulesSection(body: string): string {
  const idx = body.indexOf(RULES_HEADING);
  if (idx === -1) {
    return "";
  }
  const after = body.slice(idx + RULES_HEADING.length);
  const nextHeadingMatch = /\n##\s/.exec(after);
  const end = nextHeadingMatch ? nextHeadingMatch.index : after.length;
  return after.slice(0, end).trim();
}

function assertProtectedReplaceAllowed(slug: string, beforeText: string, newText: string): void {
  const protectedNote = PROTECTED_NOTE_SLUGS.has(slug);
  const beforeBody = parseNoteDocument(beforeText, slug).body;
  const newBody = parseNoteDocument(newText, slug).body;
  if (protectedNote || rulesSection(beforeBody)) {
    const oldRules = rulesSection(beforeBody);
    const newRules = rulesSection(newBody);
    if (oldRules && !newRules) {
      throw new Error("refusing note replace that would remove ## Rules");
    }
    if (oldRules && newRules.length < oldRules.length * 0.5) {
      throw new Error("refusing note replace that would shrink ## Rules by more than half");
    }
  }
  if (isDestructiveShrink(beforeText.length, newText.length, protectedNote)) {
    throw new Error("refusing note replace that would drop most of the document");
  }
}

type DriveFile = {
  id?: string;
  name?: string;
  createdTime?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  trashed?: boolean;
};

type DocsDocument = {
  documentId?: string;
  revisionId?: string;
  body?: { content?: Array<{ endIndex?: number; paragraph?: { elements?: Array<{ textRun?: { content?: string } }> } }> };
};

async function googleFetch(url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response | undefined;
  let body: { error?: { message?: string } } = {};
  for (let attempt = 0; attempt < GOOGLE_RETRY_LIMIT; attempt += 1) {
    const token = await googleAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    try {
      response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS) });
      const raw = await response.text();
      body = (raw ? JSON.parse(raw) : {}) as { error?: { message?: string } };
    } catch (error) {
      if (!isGoogleTimeout(error)) {
        throw error;
      }
      if (attempt === GOOGLE_RETRY_LIMIT - 1) {
        throw new Error(`Google timed out; the write may already have applied. ${NOTE_RETRY_HINT}`);
      }
      await delay(googleRetryDelayMs(attempt));
      continue;
    }
    if (!shouldRetryGoogleStatus(response.status, attempt)) {
      break;
    }
    await delay(googleRetryAfterMs(response.status, response.headers.get("retry-after")) ?? googleRetryDelayMs(attempt));
  }
  const finalResponse = response!;
  if (!finalResponse.ok) {
    throw new GoogleHttpError(finalResponse.status, body.error?.message ?? "Google API request failed");
  }
  return body;
}

async function driveFilesById(ids: string[]): Promise<Map<string, DriveFile>> {
  const found = new Map<string, DriveFile>();
  for (const id of ids.slice(0, DRIVE_LIST_PAGE_SIZE)) {
    found.set(id, await driveFile(id, "id,name,createdTime,modifiedTime,appProperties,trashed"));
  }
  return found;
}

export async function driveFile(fileId: string, fields: string): Promise<DriveFile> {
  const query = new URLSearchParams({ fields });
  return (await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${query}`,
  )) as DriveFile;
}

export async function assertDriveFileNotTrashed(fileId: string, label: string): Promise<void> {
  const item = await driveFile(fileId, "trashed");
  if (item.trashed) {
    throw new Error(`${label} is in Drive trash`);
  }
}

export async function deleteDriveFile(fileId: string): Promise<void> {
  const token = await googleAccessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 204) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? "Drive delete failed");
  }
}

export async function trashDriveFile(fileId: string): Promise<void> {
  await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: true }),
  });
}

export async function restoreTrashedDriveFile(fileId: string): Promise<void> {
  await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    body: JSON.stringify({ trashed: false }),
  });
}

export async function renameDriveFile(fileId: string, name: string): Promise<void> {
  await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function encodeNoteDocument(parts: {
  title: string;
  tags: string[];
  body: string;
  createdAt: string;
  updatedAt: string;
  useWhen?: string;
}): string {
  const header = [
    `format: ${NOTE_FORMAT_VERSION}`,
    `title: ${parts.title}`,
    `tags: ${JSON.stringify(parts.tags)}`,
    `created_at: ${parts.createdAt}`,
    `updated_at: ${parts.updatedAt}`,
    ...(parts.useWhen ? [`use_when: ${parts.useWhen}`] : []),
  ].join("\n");
  return `${header}\n\n${parts.body}`;
}

export function parseNoteDocument(text: string, slug: string): {
  slug: string;
  title: string;
  tags: string[];
  tags_raw: string;
  body: string;
  created_at: string;
  updated_at: string;
  use_when: string;
} {
  const [headerBlob, rest] = text.includes("\n\n") ? [text.slice(0, text.indexOf("\n\n")), text.slice(text.indexOf("\n\n") + 2)] : [text, ""];
  const fields: Record<string, string> = {};
  for (const line of headerBlob.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) {
      continue;
    }
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  const tagsRaw = fields.tags ?? "[]";
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(tagsRaw) as unknown;
    if (Array.isArray(parsed)) {
      tags = parsed.map((item) => String(item));
    }
  } catch {
    tags = [];
  }
  let body = rest.trim() ? rest.trim() : text.trim();
  if (!headerBlob.includes("title:")) {
    body = text.trim();
  }
  return {
    slug,
    title: fields.title || slug,
    tags,
    tags_raw: "tags" in fields ? tagsRaw : JSON.stringify(tags),
    body,
    created_at: fields.created_at ?? "",
    updated_at: fields.updated_at ?? "",
    use_when: fields.use_when ?? "",
  };
}

function extractDocText(doc: DocsDocument): string {
  const parts: string[] = [];
  for (const element of doc.body?.content ?? []) {
    for (const piece of element.paragraph?.elements ?? []) {
      const content = piece.textRun?.content;
      if (content) {
        parts.push(content);
      }
    }
  }
  return parts.join("");
}

export async function readDocumentRevision(documentId: string): Promise<{ revisionId: string; text: string }> {
  const doc = (await googleFetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
  )) as DocsDocument;
  if (!doc.revisionId) {
    throw new Error(`document ${documentId} has no revisionId`);
  }
  return { revisionId: doc.revisionId, text: extractDocText(doc) };
}

async function replaceDocText(
  documentId: string,
  text: string,
  options: { slug?: string; expectRevisionId?: string } = {},
): Promise<string> {
  const doc = (await googleFetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
  )) as DocsDocument;
  const beforeText = extractDocText(doc);
  if (options.expectRevisionId && doc.revisionId && options.expectRevisionId !== doc.revisionId) {
    throw new Error(
      `note revision mismatch: expected ${options.expectRevisionId}, current ${doc.revisionId}. ${NOTE_RETRY_HINT}`,
    );
  }
  if (options.slug) {
    assertProtectedReplaceAllowed(options.slug, beforeText, text);
  } else if (isDestructiveShrink(beforeText.length, text.length)) {
    throw new Error("refusing note replace that would drop most of the document");
  }
  const content = doc.body?.content ?? [];
  const endIndex = content.length > 0 ? Number(content[content.length - 1]?.endIndex ?? DOC_BODY_START_INDEX) : DOC_BODY_START_INDEX;
  const requests: object[] = [];
  const deleteEnd = endIndex - 1;
  if (deleteEnd > DOC_BODY_START_INDEX) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: DOC_BODY_START_INDEX, endIndex: deleteEnd },
      },
    });
  }
  requests.push({
    insertText: { location: { index: DOC_BODY_START_INDEX }, text },
  });
  const payload: { requests: object[]; writeControl?: { requiredRevisionId: string } } = { requests };
  if (doc.revisionId) {
    payload.writeControl = { requiredRevisionId: doc.revisionId };
  }
  try {
    await googleFetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const conflict =
      error instanceof GoogleHttpError &&
      (error.status === 412 || (error.status === 400 && /revision/i.test(error.message)));
    if (!conflict) {
      throw error;
    }
    const revisions = await revisionSummary(documentId);
    throw new Error(`note changed since it was read (${revisions}). ${NOTE_RETRY_HINT}`);
  }
  const after = await readDocumentRevision(documentId);
  return after.revisionId;
}

async function revisionSummary(fileId: string): Promise<string> {
  const listed = (await googleFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/revisions?fields=revisions(id,modifiedTime)&pageSize=5`,
  )) as { revisions?: Array<{ id?: string; modifiedTime?: string }> };
  const rows = listed.revisions ?? [];
  if (rows.length === 0) {
    return "no Drive revisions";
  }
  return rows.map((row) => `${row.id ?? "unknown"}@${row.modifiedTime ?? "unknown"}`).join(", ");
}

export async function createNoteDocument(title: string): Promise<string> {
  const created = (await googleFetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    body: JSON.stringify({ title }),
  })) as DocsDocument;
  const documentId = created.documentId;
  if (!documentId) {
    throw new Error("Docs create returned no documentId");
  }
  return documentId;
}

async function updateDriveProps(fileId: string, props: Record<string, string>): Promise<void> {
  await googleFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({ appProperties: props }),
  });
}

export async function getNoteRecord(
  slug: string,
  docId: string,
): Promise<{
  slug: string;
  title: string;
  tags: string[];
  body: string;
  created_at: string;
  updated_at: string;
  use_when: string;
  revision_id: string;
  last_source_ref: string;
} | null> {
  const item = await driveFile(docId, "id,name,createdTime,modifiedTime,appProperties,trashed");
  if (item.trashed) {
    return null;
  }
  const doc = (await googleFetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
  )) as DocsDocument;
  const parsed = parseNoteDocument(extractDocText(doc), slug);
  return {
    slug,
    title: item.name || parsed.title || slug,
    tags: parsed.tags,
    body: parsed.body,
    created_at: parsed.created_at || item.createdTime || "",
    updated_at: parsed.updated_at || item.modifiedTime || "",
    use_when: parsed.use_when || item.appProperties?.use_when || "",
    revision_id: doc.revisionId ?? "",
    last_source_ref: item.appProperties?.last_source_ref ?? "",
  };
}

export async function listNoteIndexes(
  notes: Record<string, string>,
  tag: string | null,
): Promise<
  Array<{ slug: string; title: string; tags: string[]; created_at: string; updated_at: string; use_when: string }>
> {
  const indexes: Array<{
    slug: string;
    title: string;
    tags: string[];
    created_at: string;
    updated_at: string;
    use_when: string;
  }> = [];
  const byId = await driveFilesById(Object.values(notes));
  for (const [slug, docId] of Object.entries(notes)) {
    const item = byId.get(docId);
    if (!item || item.trashed) {
      continue;
    }
    const props = item.appProperties ?? {};
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(props.tags || "[]") as unknown;
      if (Array.isArray(parsed)) {
        tags = parsed.map((entry) => String(entry));
      }
    } catch {
      tags = [];
    }
    if (tag !== null && !tags.includes(tag)) {
      continue;
    }
    indexes.push({
      slug,
      title: item.name || props.title || slug,
      tags,
      created_at: props.created_at || item.createdTime || "",
      updated_at: item.modifiedTime || "",
      use_when: props.use_when || "",
    });
  }
  indexes.sort((left, right) => left.slug.localeCompare(right.slug));
  indexes.sort((left, right) => (left.updated_at < right.updated_at ? 1 : left.updated_at > right.updated_at ? -1 : 0));
  return indexes;
}

export async function upsertNoteDocument(
  slug: string,
  docId: string | undefined,
  record: { title: string; tags: string[]; body: string; created_at: string; updated_at: string; use_when?: string },
  options: { expectRevisionId?: string } = {},
): Promise<{ inserted: boolean; docId: string; revision_id: string }> {
  const text = encodeNoteDocument({
    title: record.title,
    tags: record.tags,
    body: record.body,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    useWhen: record.use_when,
  });
  const props: Record<string, string> = {
    title: record.title,
    tags: JSON.stringify(record.tags),
    created_at: record.created_at,
    ...(record.use_when ? { use_when: record.use_when } : {}),
    last_source_ref: currentSourceRef(),
  };
  if (docId === undefined) {
    const createdId = await createNoteDocument(record.title);
    await updateDriveProps(createdId, props);
    const revisionId = await replaceDocText(createdId, text, { slug });
    return { inserted: true, docId: createdId, revision_id: revisionId };
  }
  await assertDriveFileNotTrashed(docId, `note ${slug}`);
  await updateDriveProps(docId, props);
  const revisionId = await replaceDocText(docId, text, { slug, expectRevisionId: options.expectRevisionId });
  return { inserted: false, docId, revision_id: revisionId };
}
