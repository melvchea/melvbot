import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type SheetsToml = {
  owner1SpreadsheetId: string;
  owner2SpreadsheetId: string;
  evSpreadsheetId: string;
};

export function tomlFilePath(): string {
  return (
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml")
  );
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSheetsSection(text: string): SheetsToml | null {
  const lines = text.split("\n");
  let inSheets = false;
  let owner1SpreadsheetId = "";
  let owner2SpreadsheetId = "";
  let evSpreadsheetId = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inSheets = line === "[sheets]";
      continue;
    }
    if (!inSheets || !line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = unquote(line.slice(0, eq).trim());
    const value = unquote(line.slice(eq + 1).trim());
    if (key === "owner1_spreadsheet_id") {
      owner1SpreadsheetId = value;
    } else if (key === "owner2_spreadsheet_id") {
      owner2SpreadsheetId = value;
    } else if (key === "ev_spreadsheet_id") {
      evSpreadsheetId = value;
    }
    // llm_spreadsheet_id is ignored for backward compatibility
  }
  if (!owner1SpreadsheetId || !owner2SpreadsheetId || !evSpreadsheetId) {
    return null;
  }
  return { owner1SpreadsheetId, owner2SpreadsheetId, evSpreadsheetId };
}

export function parseNotesSection(text: string): Record<string, string> {
  const notes: Record<string, string> = {};
  let inNotes = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inNotes = line === "[notes]";
      continue;
    }
    if (!inNotes || !line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = unquote(line.slice(0, eq).trim());
    const value = unquote(line.slice(eq + 1).trim());
    if (key && value) {
      notes[key] = value;
    }
  }
  return notes;
}

export function loadNotesToml(filePath = tomlFilePath()): Record<string, string> {
  if (!existsSync(filePath)) {
    throw new Error("missing [notes] in melvbot.toml");
  }
  return parseNotesSection(readFileSync(filePath, "utf8"));
}

export function loadSheetsToml(filePath = tomlFilePath()): SheetsToml {
  if (!existsSync(filePath)) {
    throw new Error("missing [sheets] in melvbot.toml");
  }
  const parsed = parseSheetsSection(readFileSync(filePath, "utf8"));
  if (parsed === null) {
    throw new Error("missing [sheets] spreadsheet ids in melvbot.toml");
  }
  return parsed;
}
