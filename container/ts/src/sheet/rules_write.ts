import { displayNames } from "../profile.js";
import type { WriteReceipt } from "../memory/change_log.js";
import { namedRows, sheetValues, writeNamed, appendNamed } from "./sheets.js";
import { loadSheetsToml } from "./toml.js";
import { RULES_TAB } from "./rules.js";
import { RULES_MONEY_RE } from "./rules_policy.js";

export type SheetKey = "owner1" | "owner2" | "ev";

export const RULE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const RULE_VALUE_MAX_CHARS = 300;
const RULES_HEADERS = ["key", "value"] as const;
const REFUSED_KEYS = new Set(["cycle", "cycle_window", "currency"]);
const HEADER_KEY = "key";

const MONEY_KEYS: Record<SheetKey, readonly string[]> = {
  owner1: ["target"],
  owner2: ["target", "limit"],
  ev: [],
};

function spreadsheetIdFor(sheet: SheetKey): string {
  const ids = loadSheetsToml();
  if (sheet === "owner1") {
    return ids.owner1SpreadsheetId;
  }
  if (sheet === "owner2") {
    return ids.owner2SpreadsheetId;
  }
  return ids.evSpreadsheetId;
}

function assertEditableKey(sheet: SheetKey, key: string): void {
  if (!RULE_KEY_RE.test(key)) {
    throw new Error(`key must match ${RULE_KEY_RE}: ${key}`);
  }
  if (key === HEADER_KEY) {
    throw new Error("the header row key can't be changed");
  }
  if (REFUSED_KEYS.has(key)) {
    throw new Error(`${key} is computed in code and changed from the host CLI only`);
  }
  void sheet;
}

type RulesRowLocation = {
  spreadsheetId: string;
  rows: { key: string; value: string }[];
  rowIndex: number | null; // 0-based index into `rows`, null if the key doesn't exist yet
};

async function locateRow(sheet: SheetKey, key: string): Promise<RulesRowLocation> {
  const spreadsheetId = spreadsheetIdFor(sheet);
  const raw = namedRows(await sheetValues(spreadsheetId, RULES_TAB));
  const rows = raw.map((row) => ({ key: row.key ?? "", value: row.value ?? "" }));
  const rowIndex = rows.findIndex((row) => row.key === key);
  return { spreadsheetId, rows, rowIndex: rowIndex === -1 ? null : rowIndex };
}

async function assertMoneyOrdering(sheet: SheetKey, key: string, value: string, rows: { key: string; value: string }[]): Promise<void> {
  if (sheet !== "owner2") {
    return;
  }
  const byKey = new Map(rows.map((row) => [row.key, row.value]));
  const target = key === "target" ? value : byKey.get("target");
  const limit = key === "limit" ? value : byKey.get("limit");
  if (target && limit && RULES_MONEY_RE.test(target) && RULES_MONEY_RE.test(limit)) {
    if (Number.parseFloat(target) >= Number.parseFloat(limit)) {
      throw new Error(`${displayNames().owner2} target must stay below limit: ${target} is not below ${limit}`);
    }
  }
}

export type RuleChange = {
  sheet: SheetKey;
  key: string;
  oldValue: string | null;
  newValue: string;
  receipt?: WriteReceipt;
};

type RuleWriteOptions = { skipChangeLog?: boolean; internalWrite?: boolean };

export async function setSheetRule(
  sheet: SheetKey,
  key: string,
  value: string,
  options: RuleWriteOptions = {},
): Promise<RuleChange> {
  assertEditableKey(sheet, key);
  if (value.length > RULE_VALUE_MAX_CHARS) {
    throw new Error(`value is over the ${RULE_VALUE_MAX_CHARS}-char cap`);
  }
  const isMoneyKey = MONEY_KEYS[sheet].includes(key);
  if (isMoneyKey && !RULES_MONEY_RE.test(value)) {
    throw new Error(`${key} must be money like 800.00: ${value}`);
  }
  const { spreadsheetId, rows, rowIndex } = await locateRow(sheet, key);
  if (isMoneyKey) {
    await assertMoneyOrdering(sheet, key, value, rows);
  }
  const oldValue = rowIndex === null ? null : rows[rowIndex].value;
  if (rowIndex === null) {
    await appendNamed(spreadsheetId, RULES_TAB, RULES_HEADERS, { key, value });
  } else {
    const sheetRow = rowIndex + 2; // +1 for the header row, +1 for 1-indexing
    await writeNamed(spreadsheetId, RULES_TAB, RULES_HEADERS, sheetRow, { key, value });
  }
  const change: RuleChange = { sheet, key, oldValue, newValue: value };
  if (!options.skipChangeLog && !options.internalWrite) {
    change.receipt = {
      receipt: true,
      action: "sheet rules set",
      target: `${sheet}:${key}`,
      verified: true,
      diff: {
        removed: oldValue === null ? [] : [`${key}: ${oldValue}`],
        added: [`${key}: ${value}`],
      },
    };
  }
  return change;
}

export async function deleteSheetRule(
  sheet: SheetKey,
  key: string,
  options: RuleWriteOptions = {},
): Promise<RuleChange> {
  assertEditableKey(sheet, key);
  if (MONEY_KEYS[sheet].includes(key)) {
    throw new Error(`${key} can be changed but not deleted`);
  }
  const { spreadsheetId, rows, rowIndex } = await locateRow(sheet, key);
  if (rowIndex === null) {
    throw new Error(`rule not found: ${sheet} ${key}`);
  }
  const oldValue = rows[rowIndex].value;
  const sheetRow = rowIndex + 2;
  await writeNamed(spreadsheetId, RULES_TAB, RULES_HEADERS, sheetRow, { key: "", value: "" });
  const change: RuleChange = { sheet, key, oldValue, newValue: "" };
  if (!options.skipChangeLog && !options.internalWrite) {
    change.receipt = {
      receipt: true,
      action: "sheet rules delete",
      target: `${sheet}:${key}`,
      verified: true,
      diff: {
        removed: [`${key}: ${oldValue}`],
        added: [],
      },
    };
  }
  return change;
}
