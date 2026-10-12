import { extractSection } from "../assistant/confirm.js";
import { getNote, replaceNoteSection, replaceNoteText } from "../note/notes.js";
import { createSpreadsheet, type TabTemplate } from "./sheets.js";

export const SHEET_CREATE_USAGE =
  "usage: melvbot sheet create <title...> [--note <slug>] [--tab <name>:<col1>,<col2>,...]  (--tab repeatable)\n";

export type SheetCreateRequest = { title: string; tabs: TabTemplate[]; noteSlug?: string };
export type SheetCreateResult = {
  title: string;
  url: string;
  spreadsheetId: string;
  note?: { slug: string; linked: boolean; error?: string };
};

export type SheetCreateDeps = {
  createSpreadsheet: typeof createSpreadsheet;
  getNote: (slug: string) => Promise<{ body: string; revision_id: string }>;
  replaceNoteText: typeof replaceNoteText;
  replaceNoteSection: typeof replaceNoteSection;
};

const REAL_DEPS: SheetCreateDeps = { createSpreadsheet, getNote, replaceNoteText, replaceNoteSection };

const OPTION_NAMES = new Set(["--note", "--tab"]);

/** Parses `sheet create` args (after "create"); null when the title is missing or a tab is malformed. */
export function parseSheetCreateArgs(args: readonly string[]): SheetCreateRequest | null {
  const titleWords: string[] = [];
  const tabs: TabTemplate[] = [];
  let noteSlug: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const part = args[index];
    if (!OPTION_NAMES.has(part)) {
      titleWords.push(part);
      continue;
    }
    const value = args[index + 1];
    index += 1;
    if (value === undefined) {
      return null;
    }
    if (part === "--note") {
      noteSlug = value.trim();
      continue;
    }
    const split = value.indexOf(":");
    const name = (split === -1 ? value : value.slice(0, split)).trim();
    const headers = split === -1 ? [] : value.slice(split + 1).split(",").map((col) => col.trim()).filter(Boolean);
    if (!name || headers.length === 0) {
      return null;
    }
    tabs.push({ name, headers });
  }
  const title = titleWords.join(" ").trim();
  if (!title || noteSlug === "") {
    return null;
  }
  return { title, tabs, noteSlug };
}

/** Confirm preview text: title, tabs and target note. */
export function sheetCreateSummary(request: SheetCreateRequest): string {
  const tabs = request.tabs.length > 0 ? request.tabs.map((tab) => `${tab.name} (${tab.headers.join(", ")})`).join("; ") : "default tab";
  return `Confirm: create Sheet "${request.title}"\nTabs: ${tabs}\nLink in Note: ${request.noteSlug ?? "none"}?`;
}

/** A line that reads like an unfilled Sheet-link slot, e.g. `Sheet: [Title](https://docs.google.com/spreadsheets/d/[sheet-id]/edit)`. */
export function findSheetPlaceholderLine(body: string): string | null {
  const unfilled = /\[sheet[-_ ]?id\]|spreadsheets\/d\/\[|placeholder|\bpaste\b|\btbd\b|to be added|\[link\]|\(link\)/i;
  return body.split("\n").find((line) => /sheet/i.test(line) && unfilled.test(line)) ?? null;
}

async function linkNote(
  slug: string,
  line: string,
  deps: SheetCreateDeps,
): Promise<{ slug: string; linked: boolean; error?: string }> {
  try {
    const note = await deps.getNote(slug);
    const placeholder = findSheetPlaceholderLine(note.body);
    if (placeholder !== null) {
      await deps.replaceNoteText(slug, placeholder, line, note.revision_id);
    } else {
      const existing = extractSection(note.body, "## Links").trim();
      const content = existing ? `${existing}\n${line}` : line;
      await deps.replaceNoteSection(slug, "## Links", content, note.revision_id, { position: "bottom" });
    }
    return { slug, linked: true };
  } catch (error) {
    return { slug, linked: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Creates a free-form Sheet (not pinned) and optionally links it from a Note; a note failure keeps the Sheet. */
export async function createFreeFormSheet(
  request: SheetCreateRequest,
  deps: SheetCreateDeps = REAL_DEPS,
): Promise<SheetCreateResult> {
  const spreadsheetId = await deps.createSpreadsheet(request.title, request.tabs);
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  const result: SheetCreateResult = { title: request.title, url, spreadsheetId };
  if (request.noteSlug) {
    result.note = await linkNote(request.noteSlug, `Sheet: ${request.title} ${url}`, deps);
  }
  return result;
}
