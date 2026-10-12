import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tomlFilePath } from "./toml.js";

export const SHEETS_TABLE = "sheets";
export const NOTES_TABLE = "notes";

const SHEET_KEYS = new Set(["owner1_spreadsheet_id", "owner2_spreadsheet_id", "ev_spreadsheet_id"]);
const NOTE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function splitKeepEnds(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/(?<=\n)/);
}

function tableBodySpan(lines: string[], table: string): { start: number; end: number } {
  const header = `[${table}]`;
  let start: number | undefined;
  for (const [index, line] of lines.entries()) {
    const stripped = line.trim();
    if (start === undefined) {
      if (stripped === header) {
        start = index + 1;
      }
      continue;
    }
    if (stripped.startsWith("[") && stripped.endsWith("]")) {
      return { start, end: index };
    }
  }
  if (start === undefined) {
    throw new Error(`missing [${table}] table`);
  }
  return { start, end: lines.length };
}

function assignmentLine(table: string, key: string, value: string): string {
  const quoted = `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  if (table === NOTES_TABLE) {
    return `"${key}" = ${quoted}\n`;
  }
  return `${key} = ${quoted}\n`;
}

function matchesKey(table: string, key: string, line: string): boolean {
  const left = table === NOTES_TABLE ? `"${key}"` : key;
  const escaped = left.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*=`).test(line);
}

export function rewriteSheetTomlText(
  text: string,
  table: string,
  key: string,
  value: string | null,
): string {
  const lines = splitKeepEnds(text);
  const { start, end } = tableBodySpan(lines, table);
  let matchIndex: number | undefined;
  for (let index = start; index < end; index += 1) {
    const stripped = lines[index]?.trimStart() ?? "";
    if (stripped.startsWith("#")) {
      continue;
    }
    if (matchesKey(table, key, lines[index] ?? "")) {
      matchIndex = index;
      break;
    }
  }
  if (value === null) {
    if (matchIndex === undefined) {
      return text;
    }
    lines.splice(matchIndex, 1);
    return lines.join("");
  }
  const assignment = assignmentLine(table, key, value);
  if (matchIndex !== undefined) {
    const current = lines[matchIndex] ?? "";
    const indent = current.match(/^(\s*)/)?.[1] ?? "";
    const suffix = current.endsWith("\n") ? "\n" : "";
    lines[matchIndex] = `${indent}${assignment.replace(/\n$/, "")}${suffix}`;
    return lines.join("");
  }
  let insertAt = start;
  for (let index = start; index < end; index += 1) {
    if (lines[index]?.trim()) {
      insertAt = index + 1;
    }
  }
  lines.splice(insertAt, 0, assignment);
  return lines.join("");
}

export function rewriteSheetTomlKey(options: {
  table: string;
  key: string;
  value: string | null;
  filePath?: string;
}): void {
  if (options.table === NOTES_TABLE) {
    if (!NOTE_SLUG_RE.test(options.key)) {
      throw new Error(`notes keys must be lowercase hyphenated slugs; got ${options.key}`);
    }
  } else if (options.table === SHEETS_TABLE) {
    if (!SHEET_KEYS.has(options.key)) {
      throw new Error(`unsupported sheets key: ${options.key}`);
    }
  } else {
    throw new Error(`unsupported melvbot toml table: ${options.table}`);
  }
  if (options.value !== null && !options.value.trim()) {
    throw new Error("melvbot toml value must not be empty");
  }
  const filePath = options.filePath ?? tomlFilePath();
  if (!existsSync(filePath)) {
    throw new Error("missing melvbot.toml");
  }
  const original = readFileSync(filePath, "utf8");
  const updated = rewriteSheetTomlText(original, options.table, options.key, options.value);
  if (updated === original) {
    return;
  }
  const tmpPath = path.join(path.dirname(filePath), `.sheet-toml-${path.basename(filePath)}.tmp`);
  writeFileSync(tmpPath, updated, { encoding: "utf8" });
  renameSync(tmpPath, filePath);
}
