import { existsSync, readFileSync } from "node:fs";

import { googleSheetEditUrl } from "../google/drive_urls.js";
import { driveFile, renameDriveFile } from "../note/notes_google.js";
import { parseSheetsSection, tomlFilePath } from "./toml.js";
import { displayNames, vehicleName } from "../profile.js";
import { assembleLinkListLines, type LinkListMessage } from "../telegram/link_list.js";

export type SheetName = "owner1" | "owner2" | "ev";

function sheetDisplayNames(): Record<SheetName, string> {
  const names = displayNames();
  return { owner1: names.owner1, owner2: names.owner2, ev: vehicleName() };
}

const SHEET_LIST_RE =
  /^(?:list|show)\s+(?:my\s+)?(?:sheets|google\s+sheets)$|^my\s+(?:sheets|google\s+sheets)$/i;

export function parseSheetListDirective(line: string): boolean {
  return SHEET_LIST_RE.test(line.trim());
}

export function sheetLabel(sheet: SheetName): string {
  return `${sheetDisplayNames()[sheet]} Sheet`;
}

/** Maps a typed owner id, display name (any case) or the vehicle name to its sheet, or null. */
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
