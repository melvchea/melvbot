import { existsSync, readFileSync } from "node:fs";

import { googleSheetEditUrl } from "../google/drive_urls.js";
import { SHEET_PIN_KEYS } from "./cli.js";
import { driveFile, renameDriveFile, trashDriveFile } from "../note/notes_google.js";
import { createSpreadsheet, type TabTemplate } from "./sheets.js";
import { parseSheetsSection, tomlFilePath } from "./toml.js";
import { displayNames, isEvName, ownerAlternation, vehicleAlternation, vehicleName } from "../profile.js";
import { SHEETS_TABLE, rewriteSheetTomlKey } from "./toml_rewrite.js";
import { assembleLinkListLines, type LinkListMessage } from "../telegram/link_list.js";
import { buildSheetActionKeyboard, storeSheetActionOffer } from "../telegram/prose_callbacks.js";

export type SheetName = "owner1" | "owner2" | "ev";

function sheetDisplayNames(): Record<SheetName, string> {
  const names = displayNames();
  return { owner1: names.owner1, owner2: names.owner2, ev: vehicleName() };
}

/** Swaps the NAME placeholder for owner ids, display names and the vehicle (built per call from the profile). */
function withSheetName(re: RegExp): RegExp {
  return new RegExp(re.source.replace("NAME", `${ownerAlternation()}|${vehicleAlternation()}`), re.flags);
}

/** Sheets that start with their tabs and header rows; the rest are created empty. */
const SHEET_TEMPLATES: Partial<Record<SheetName, TabTemplate[]>> = {};

const SHEET_LIST_RE =
  /^(?:list|show)\s+(?:my\s+)?(?:sheets|google\s+sheets)$|^my\s+(?:sheets|google\s+sheets)$/i;
const SHEET_RENAME_RE = (): RegExp =>
  withSheetName(/^rename\s+(?:sheet|google\s+sheet)\s+(NAME)\s+to\s+(.+)$/i);
const SHEET_RENAME_THE_RE = (): RegExp =>
  withSheetName(/^rename\s+the\s+(NAME)\s+(?:sheet|google\s+sheet)\s+to\s+(.+)$/i);
const SHEET_CREATE_RE = (): RegExp =>
  withSheetName(/^create(?:\s+a)?(?:\s+new)?(?:\s+(NAME))?\s+(?:sheet|google\s+sheet)$/i);
const SHEET_DELETE_RE = (): RegExp =>
  withSheetName(/^delete(?:\s+the)?(?:\s+(NAME))?\s+(?:sheet|google\s+sheet)$/i);
const SHEET_NEW_RE = /^new\s+google\s+sheet$/i;
const SHEET_DELETE_ONLY_RE = /^delete\s+google\s+sheet$/i;
const SHEET_LINK_RE = (): RegExp =>
  withSheetName(/^(?:(?:show|get|send)\s+)?(?:google\s+)?sheet\s+link(?:\s+(?:to|for))?\s+(NAME)(?:\s+(?:sheet|google\s+sheet))?$/i);
const SHEET_LINK_TO_RE = (): RegExp =>
  withSheetName(/^link(?:\s+(?:to|for))?\s+(?:the\s+)?(NAME)\s+(?:sheet|google\s+sheet)$/i);

export function parseSheetListDirective(line: string): boolean {
  return SHEET_LIST_RE.test(line.trim());
}

export function parseSheetRenameDirective(line: string): { sheet: SheetName; title: string } | null {
  const trimmed = line.trim();
  const matched = SHEET_RENAME_RE().exec(trimmed) ?? SHEET_RENAME_THE_RE().exec(trimmed);
  const sheet = sheetFromWord(matched?.[1]);
  const title = matched?.[2]?.trim();
  if (!sheet || !title) {
    return null;
  }
  return { sheet, title };
}

export function sheetLabel(sheet: SheetName): string {
  return `${sheetDisplayNames()[sheet]} Sheet`;
}

/** Maps a typed owner id, display name (any case) or the vehicle name to its sheet, or null. */
function sheetFromWord(word: string | undefined): SheetName | null {
  const lower = word?.trim().toLowerCase();
  const names = displayNames();
  if (lower === "owner1" || lower === names.owner1.toLowerCase()) {
    return "owner1";
  }
  if (lower === "owner2" || lower === names.owner2.toLowerCase()) {
    return "owner2";
  }
  return lower !== undefined && isEvName(lower) ? "ev" : null;
}

function namedSheet(token: string | undefined): SheetName | null {
  return sheetFromWord(token);
}

export function parseSheetLinkDirective(line: string): SheetName | null {
  const trimmed = line.trim();
  const matched = SHEET_LINK_RE().exec(trimmed) ?? SHEET_LINK_TO_RE().exec(trimmed);
  return namedSheet(matched?.[1]);
}

export function parseSheetActionDirective(line: string): SheetName | "ask" | null {
  const trimmed = line.trim();
  const create = SHEET_CREATE_RE().exec(trimmed);
  const createSheet = namedSheet(create?.[1]);
  if (createSheet) {
    return createSheet;
  }
  const del = SHEET_DELETE_RE().exec(trimmed);
  const deleteSheet = namedSheet(del?.[1]);
  if (deleteSheet) {
    return deleteSheet;
  }
  if (
    SHEET_CREATE_RE().test(trimmed) ||
    SHEET_DELETE_RE().test(trimmed) ||
    SHEET_NEW_RE.test(trimmed) ||
    SHEET_DELETE_ONLY_RE.test(trimmed)
  ) {
    return "ask";
  }
  return null;
}

function readSheetIds(): Partial<Record<SheetName, string>> {
  const filePath = tomlFilePath();
  if (!existsSync(filePath)) {
    return {};
  }
  const parsed = parseSheetsSection(readFileSync(filePath, "utf8"));
  if (!parsed) {
    return {};
  }
  return {
    owner1: parsed.owner1SpreadsheetId || undefined,
    owner2: parsed.owner2SpreadsheetId || undefined,
    ev: parsed.evSpreadsheetId || undefined,
  };
}

export async function sheetLinkReply(sheet: SheetName): Promise<string> {
  const spreadsheetId = readSheetIds()[sheet];
  if (!spreadsheetId) {
    return `${sheetLabel(sheet)} is not yet created.`;
  }
  try {
    const item = await driveFile(spreadsheetId, "name,trashed");
    if (item.trashed) {
      return `${sheetLabel(sheet)} is not yet created.`;
    }
  } catch {
    return `${sheetLabel(sheet)} is not yet created.`;
  }
  return googleSheetEditUrl(spreadsheetId);
}

export async function sheetListReply(): Promise<LinkListMessage> {
  const ids = readSheetIds();
  const lines: Array<{ label: string; url?: string }> = [];
  for (const sheet of ["owner1", "owner2", "ev"] as SheetName[]) {
    const spreadsheetId = ids[sheet];
    if (!spreadsheetId) {
      lines.push({ label: `${sheetDisplayNames()[sheet]} — not yet created` });
      continue;
    }
    try {
      const item = await driveFile(spreadsheetId, "name,trashed");
      if (item.trashed) {
        lines.push({ label: `${sheetDisplayNames()[sheet]} — not yet created` });
        continue;
      }
      lines.push({
        label: `${sheetDisplayNames()[sheet]} — ${item.name ?? sheetDisplayNames()[sheet]}`,
        url: googleSheetEditUrl(spreadsheetId),
      });
    } catch {
      lines.push({ label: `${sheetDisplayNames()[sheet]} — not yet created` });
    }
  }
  return assembleLinkListLines(lines, "");
}

export async function applySheetRename(
  sheet: SheetName,
  title: string,
): Promise<{ ok: true; sheet: SheetName; title: string } | { ok: false; message: string }> {
  const cleanedTitle = title.trim();
  if (!cleanedTitle) {
    return { ok: false, message: "Title must not be empty." };
  }
  const spreadsheetId = readSheetIds()[sheet];
  if (!spreadsheetId) {
    return { ok: false, message: `${sheetLabel(sheet)} is not yet created.` };
  }
  await renameDriveFile(spreadsheetId, cleanedTitle);
  return { ok: true, sheet, title: cleanedTitle };
}

export function sheetActionCard(
  sheet: SheetName,
  senderId: number,
): { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const nonce = storeSheetActionOffer({ sheet, senderId });
  return {
    text: `${sheetLabel(sheet)} — create a new spreadsheet or delete the existing pin?`,
    reply_markup: buildSheetActionKeyboard(nonce),
  };
}

export async function createAndPinSheet(
  sheet: SheetName,
  title?: string,
): Promise<{ ok: true; title: string } | { ok: false; message: string }> {
  const driveTitle = title?.trim() || sheetLabel(sheet);
  let spreadsheetId: string | undefined;
  try {
    spreadsheetId = await createSpreadsheet(driveTitle, SHEET_TEMPLATES[sheet]);
    const key = SHEET_PIN_KEYS[sheet];
    rewriteSheetTomlKey({ table: SHEETS_TABLE, key, value: spreadsheetId });
    return { ok: true, title: driveTitle };
  } catch (error) {
    if (spreadsheetId) {
      try {
        await trashDriveFile(spreadsheetId);
      } catch {
        /* best effort */
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not create ${sheetLabel(sheet)}: ${detail}` };
  }
}

export function sheetDeleteExistingRefusal(sheet: SheetName): string {
  return `${sheetLabel(sheet)} pins cannot be empty. Use Create new to replace the pinned spreadsheet.`;
}
