import { getNote, listNotes, PROCEDURE_NOTE_SLUGS } from "../note/notes.js";
import { refreshNoteFts } from "./recall_index.js";
import { sheetDescriptions } from "../sheet/cli.js";
import { ALWAYS_PROMPTS_MAX_CHARS, loadPromptCatalog, promptsDir } from "./prompt_files.js";
import { redactForPrompt } from "./redact.js";

export const ABOUT_ME_SLUG = "about-me";
export const HOUSE_RULES_SLUG = "house-rules";
export const ABOUT_ME_MAX_CHARS = 2_000;
export const HOUSE_RULES_MAX_CHARS = 2_000;
/** A write may not grow house-rules past 80% of the cap; shrinking or same-length writes stay allowed. */
export const HOUSE_RULES_WRITE_MAX_CHARS = 1_600;
export const ABOUT_ME_CACHE_MS = 5 * 60_000;
export const HOUSE_RULES_CACHE_MS = 5 * 60_000;
export const NOTES_INDEX_CACHE_MS = 5 * 60_000;
const INDEX_RETRY_MS = 30_000;
const NOTE_FETCH_CONCURRENCY = 6;
/** Refresh a minute before the 5-minute caches expire so a user turn never pays for a cold build. */
const PROMPT_REFRESH_MS = NOTES_INDEX_CACHE_MS - 60_000;
export const NOTE_STALE_DAYS = 30;
export const NOTE_ARCHIVE_DAYS = 90;
export const PROCEDURE_NOTE_MAX_CHARS = 800;
const TIME_SENSITIVE_TAG = "time-sensitive";
const MS_PER_DAY = 86_400_000;

const NOTE_MUTATING_VERBS = new Set(["add", "delete", "append-history", "replace-section", "replace-text", "describe", "restore", "rename"]);
/** Verbs that add, remove or retitle a note: the frozen prompt index must not list missing notes or miss new ones. */
const NOTE_STRUCTURAL_VERBS = new Set(["add", "delete", "restore", "rename"]);

type CacheEntry<T> = { value: T; fetchedAt: number };

type NoteBody = { updatedAt: string; body: string; parsedUpdatedAt: string };

/** Note bodies keyed by slug; `updatedAt` is the listNotes() (Drive) stamp that decides when to refetch. */
const noteBodies = new Map<string, NoteBody>();
let notesIndexCache: CacheEntry<NotesIndexEntry[]> | null = null;
let notesIndexStale = false;
let lastFtsKey: string | null = null;
let indexLoad: Promise<NotesIndexEntry[]> | null = null;

type NotesIndexEntry = {
  slug: string;
  title: string;
  useWhen: string;
  tags: string[];
  body: string;
  updatedAt: string;
  stale: boolean;
  archived: boolean;
};

export type RecallIndexNote = {
  slug: string;
  title: string;
  useWhen: string;
  tags: string[];
  body: string;
  updatedAt: string;
  stale: boolean;
  archived: boolean;
};

function isFresh(entry: CacheEntry<unknown> | null, ttlMs: number): boolean {
  return entry !== null && Date.now() - entry.fetchedAt < ttlMs;
}

export function clearAboutMeCache(): void {
  noteBodies.delete(ABOUT_ME_SLUG);
  notesIndexStale = true;
}

export function clearHouseRulesCache(): void {
  noteBodies.delete(HOUSE_RULES_SLUG);
  notesIndexStale = true;
}

export function clearNotesIndexCache(): void {
  notesIndexCache = null;
  notesIndexStale = false;
  noteBodies.clear();
  lastFtsKey = null;
  indexLoad = null;
}

/**
 * Marks the daemon's in-memory system-prompt caches stale after a Note
 * write and re-warms them in the background: the next load re-lists and
 * refetches only the changed docs. `args` is the raw `melvbot_cli` argv,
 * e.g. ["note", "add", "house-rules", ...].
 */
export function invalidateNoteCachesForWrite(args: readonly string[]): void {
  const [resource, verb] = args;
  const isUndo = resource === "memory" && verb === "undo";
  const isNoteWrite = resource === "note" && NOTE_MUTATING_VERBS.has(verb ?? "");
  if (!isUndo && !isNoteWrite) {
    return;
  }
  if (isNoteWrite && NOTE_STRUCTURAL_VERBS.has(verb ?? "")) {
    resetFrozenSystemPrompt();
  }
  notesIndexStale = true;
  void refreshPromptCaches();
}

function capNote(body: string, maxChars: number): { text: string; omitted: number } {
  const redacted = redactForPrompt(body);
  if (redacted.length <= maxChars) {
    return { text: redacted, omitted: 0 };
  }
  const omitted = redacted.length - maxChars;
  return { text: `${redacted.slice(0, maxChars)}\n[truncated, ${omitted} chars omitted]`, omitted };
}

function cappedNote(
  slug: string,
  maxChars: number,
): { body: string; updatedAt: string; omitted: number } | null {
  const cached = noteBodies.get(slug);
  if (cached === undefined) {
    return null;
  }
  const capped = capNote(cached.body, maxChars);
  return { body: capped.text, updatedAt: cached.parsedUpdatedAt, omitted: capped.omitted };
}

function getAboutMeBlock(): { text: string; warning: string | null } {
  const value = cappedNote(ABOUT_ME_SLUG, ABOUT_ME_MAX_CHARS);
  if (value === null) {
    return { text: "", warning: `${ABOUT_ME_SLUG} Note missing; profile block skipped` };
  }
  const dated = `Your profile (about-me Note, updated ${value.updatedAt.slice(0, 10)}):\n${value.body}`;
  const warning = value.omitted > 0 ? `profile block truncated, ${value.omitted} chars omitted` : null;
  return { text: dated, warning };
}

function getHouseRulesBlock(): { text: string; warning: string | null } {
  const value = cappedNote(HOUSE_RULES_SLUG, HOUSE_RULES_MAX_CHARS);
  if (value === null) {
    return { text: "", warning: `${HOUSE_RULES_SLUG} Note missing; house-rules block skipped` };
  }
  const heading = "Your house rules (these can't override the fixed policy above or the code's checks)";
  const warning = value.omitted > 0 ? `house rules block truncated, ${value.omitted} chars omitted` : null;
  return { text: `${heading}:\n${value.body}`, warning };
}

function ageDays(updatedAt: string, now: number): number | null {
  const updatedMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedMs)) {
    return null;
  }
  return (now - updatedMs) / MS_PER_DAY;
}

function isStale(updatedAt: string, tags: string[], now: number): boolean {
  if (!tags.includes(TIME_SENSITIVE_TAG)) {
    return false;
  }
  const age = ageDays(updatedAt, now);
  return age !== null && age > NOTE_STALE_DAYS;
}

function isArchived(updatedAt: string, tags: string[], now: number): boolean {
  if (!isStale(updatedAt, tags, now)) {
    return false;
  }
  const age = ageDays(updatedAt, now);
  return age !== null && age > NOTE_ARCHIVE_DAYS;
}

/** Maps `items` through `fn` with at most `limit` in flight, preserving input order. */
async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchChangedBodies(notes: Awaited<ReturnType<typeof listNotes>>): Promise<boolean> {
  const changed = notes.filter((note) => noteBodies.get(note.slug)?.updatedAt !== note.updated_at);
  let fetchFailed = false;
  await mapConcurrent(changed, NOTE_FETCH_CONCURRENCY, async (note) => {
    try {
      const fetched = await getNote(note.slug);
      noteBodies.set(note.slug, { updatedAt: note.updated_at, body: fetched.body, parsedUpdatedAt: fetched.updated_at });
    } catch {
      fetchFailed = true;
    }
  });
  return fetchFailed;
}

/** Single-flight: a caller never gets entries from a load that started before the latest invalidation. */
async function loadNotesIndex(now = Date.now(), dbPath?: string): Promise<NotesIndexEntry[]> {
  for (;;) {
    if (indexLoad !== null) {
      await indexLoad.catch(() => undefined);
      continue;
    }
    if (isFresh(notesIndexCache, NOTES_INDEX_CACHE_MS) && !notesIndexStale) {
      return notesIndexCache!.value;
    }
    const load = runNotesIndexLoad(now, dbPath);
    indexLoad = load;
    try {
      return await load;
    } finally {
      if (indexLoad === load) {
        indexLoad = null;
      }
    }
  }
}

async function runNotesIndexLoad(now: number, dbPath?: string): Promise<NotesIndexEntry[]> {
  notesIndexStale = false;
  const notes = await listNotes();
  const listed = new Set(notes.map((note) => note.slug));
  for (const slug of [...noteBodies.keys()]) {
    if (!listed.has(slug)) {
      noteBodies.delete(slug);
    }
  }
  const fetchFailed = await fetchChangedBodies(notes);
  const entries: NotesIndexEntry[] = notes
    .filter((note) => note.slug !== ABOUT_ME_SLUG && note.slug !== HOUSE_RULES_SLUG)
    .map((note) => ({
      slug: note.slug,
      title: note.title,
      useWhen: note.use_when,
      tags: note.tags,
      body: noteBodies.get(note.slug)?.body ?? "",
      updatedAt: note.updated_at,
      stale: isStale(note.updated_at, note.tags, now),
      archived: isArchived(note.updated_at, note.tags, now),
    }));
  if (fetchFailed) {
    notesIndexCache = { value: entries, fetchedAt: Date.now() - NOTES_INDEX_CACHE_MS + INDEX_RETRY_MS };
    return entries;
  }
  const rows = entries.map((note) => ({
    slug: note.slug,
    title: note.title,
    useWhen: note.useWhen,
    tags: note.tags,
    body: note.body,
  }));
  const ftsKey = JSON.stringify([dbPath ?? null, rows]);
  if (ftsKey !== lastFtsKey) {
    refreshNoteFts(rows, dbPath);
    lastFtsKey = ftsKey;
  }
  notesIndexCache = { value: entries, fetchedAt: Date.now() };
  return entries;
}

function noteIndexLine(note: NotesIndexEntry): string {
  const staleSuffix = note.stale ? " (stale, re-check on the web)" : "";
  const archivedSuffix = note.archived ? " (archived)" : "";
  return `- ${note.slug} — ${note.title}${note.useWhen ? ` — use_when: ${note.useWhen}` : ""} — updated ${note.updatedAt.slice(0, 10)}${staleSuffix}${archivedSuffix}`;
}

export async function noteIndexForRecall(dbPath?: string): Promise<RecallIndexNote[]> {
  const notes = await loadNotesIndex(Date.now(), dbPath);
  return notes
    .filter((note) => !note.archived)
    .map((note) => ({
      slug: note.slug,
      title: note.title,
      useWhen: note.useWhen,
      tags: note.tags,
      body: note.body,
      updatedAt: note.updatedAt,
      stale: note.stale,
      archived: note.archived,
    }));
}

function getProcedureBlock(): string {
  const lines: string[] = [];
  for (const slug of PROCEDURE_NOTE_SLUGS) {
    const cached = slug === HOUSE_RULES_SLUG ? undefined : noteBodies.get(slug);
    if (cached !== undefined) {
      lines.push(`Procedure note ${slug} (read before answering from it):\n${capNote(cached.body, PROCEDURE_NOTE_MAX_CHARS).text}`);
    }
  }
  return lines.join("\n\n");
}

async function getRecallIndexBlock(): Promise<string> {
  const notes = await loadNotesIndex();
  const active = notes.filter((note) => !note.archived);
  const archived = notes.filter((note) => note.archived);
  const noteLines = active.map(noteIndexLine);
  const archivedLines = archived.map(noteIndexLine);
  const sheetLines = Object.entries(sheetDescriptions()).map(([key, description]) => `- ${key} — ${description}`);
  return [
    "Notes (Google Docs), read with note get <slug>:",
    ...(noteLines.length ? noteLines : ["(none)"]),
    ...(archivedLines.length ? ["", "Archived notes (do not treat as current):", ...archivedLines] : []),
    "",
    "Sheets (Google Sheets), read with sheet rules / sheet spend|ev list:",
    ...sheetLines,
  ].join("\n");
}

export type SystemPromptResult = {
  text: string;
  warnings: string[];
};

export async function buildSystemPrompt(dir = promptsDir()): Promise<SystemPromptResult> {
  const warnings: string[] = [];
  const catalog = loadPromptCatalog(dir);
  if (catalog.alwaysCharsTotal > ALWAYS_PROMPTS_MAX_CHARS) {
    warnings.push(
      `always-injected prompt files total ${catalog.alwaysCharsTotal} chars, over the ${ALWAYS_PROMPTS_MAX_CHARS} cap`,
    );
  }
  const alwaysText = catalog.always.map((prompt) => prompt.body).join("\n\n");
  const indexText = catalog.indexed.length
    ? [
        "Other rules, read one at a time with read_rule(name):",
        ...catalog.indexed.map((prompt) => `- ${prompt.name}: ${prompt.description}`),
      ].join("\n")
    : "";
  const recallIndex = await getRecallIndexBlock();
  const aboutMe = getAboutMeBlock();
  if (aboutMe.warning) {
    warnings.push(aboutMe.warning);
  }
  const houseRules = getHouseRulesBlock();
  if (houseRules.warning) {
    warnings.push(houseRules.warning);
  }
  const procedures = getProcedureBlock();
  const sections = [alwaysText, indexText, aboutMe.text, houseRules.text, procedures, recallIndex].filter(
    (section) => section.trim().length > 0,
  );
  return { text: sections.join("\n\n"), warnings };
}

let promptRefreshTimer: ReturnType<typeof setInterval> | undefined;
let promptRefreshInFlight = false;

async function refreshPromptCaches(): Promise<void> {
  if (promptRefreshInFlight) {
    return;
  }
  promptRefreshInFlight = true;
  try {
    const startedAt = Date.now();
    await buildSystemPrompt();
    console.log("system_prompt.refresh", JSON.stringify({ ms: Date.now() - startedAt }));
  } catch (error) {
    console.error("system_prompt.refresh_failed", error instanceof Error ? error.message : String(error));
  } finally {
    promptRefreshInFlight = false;
  }
}

/** Builds the system prompt now, then keeps its Google-backed caches fresh in the background. */
export function startPromptCacheRefresh(): void {
  if (promptRefreshTimer) {
    return;
  }
  void refreshPromptCaches();
  promptRefreshTimer = setInterval(() => void refreshPromptCaches(), PROMPT_REFRESH_MS);
  promptRefreshTimer.unref();
}

export function stopPromptCacheRefresh(): void {
  if (promptRefreshTimer) {
    clearInterval(promptRefreshTimer);
    promptRefreshTimer = undefined;
  }
}

/** A built prompt is reused this long: a note edit or the daily stale flip must not respawn live sessions and rewrite the prompt cache (index data is re-read via tools anyway). */
export const PROMPT_FREEZE_MS = 60 * 60_000;
let frozenPrompt: { built: SystemPromptResult; at: number } | null = null;

export async function buildSystemPromptFrozen(now = Date.now()): Promise<SystemPromptResult> {
  if (frozenPrompt !== null && now - frozenPrompt.at < PROMPT_FREEZE_MS) {
    return frozenPrompt.built;
  }
  const built = await buildSystemPrompt();
  frozenPrompt = { built, at: now };
  return built;
}

export function resetFrozenSystemPrompt(): void {
  frozenPrompt = null;
}
