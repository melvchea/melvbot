import {
  OWNER2_CARD2_LIMIT_FALLBACK,
  OWNER2_CARD2_TARGET_FALLBACK,
  OWNER1_CARD1_TARGET_FALLBACK,
  type SpendCard,
} from "./spend_cycle.js";
import { loadSheetsToml } from "./toml.js";
import { assertSheetHeaders, namedRows, sheetValues } from "./sheets.js";
import { RULES_TAB } from "./rules.js";

export const RULES_MONEY_RE = /^\d{1,6}\.\d{2}$/;

export type SpendPolicy = {
  target: string;
  limit: string | null;
  policySource: "sheet" | "fallback";
};

function spreadsheetIdFor(owner: SpendCard["owner"], ids: ReturnType<typeof loadSheetsToml>): string {
  return owner === "owner1" ? ids.owner1SpreadsheetId : ids.owner2SpreadsheetId;
}

async function readRulesByKey(spreadsheetId: string): Promise<Map<string, string>> {
  const values = await sheetValues(spreadsheetId, RULES_TAB);
  assertSheetHeaders(values, ["key", "value"], RULES_TAB);
  const rows = namedRows(values);
  const byKey = new Map<string, string>();
  for (const row of rows) {
    if (row.key) {
      byKey.set(row.key, row.value ?? "");
    }
  }
  return byKey;
}

/**
 * Reads the owner1 or owner2 Rules tab for the money keys that drive the spend
 * math, replacing spendCardPolicy's constants. Falls back to the fixed
 * *_FALLBACK constants (and reports policySource: "fallback") when a money
 * key is missing or fails RULES_MONEY_RE.
 */
export async function spendCardPolicy(card: SpendCard): Promise<SpendPolicy> {
  const ids = loadSheetsToml();
  const spreadsheetId = spreadsheetIdFor(card.owner, ids);
  const byKey = await readRulesByKey(spreadsheetId);
  if (card.owner === "owner1" && card.card === "card1") {
    const target = byKey.get("target");
    if (target && RULES_MONEY_RE.test(target)) {
      return { target, limit: null, policySource: "sheet" };
    }
    return { target: OWNER1_CARD1_TARGET_FALLBACK, limit: null, policySource: "fallback" };
  }
  const target = byKey.get("target");
  const limit = byKey.get("limit");
  if (target && limit && RULES_MONEY_RE.test(target) && RULES_MONEY_RE.test(limit)) {
    return { target, limit, policySource: "sheet" };
  }
  return {
    target: OWNER2_CARD2_TARGET_FALLBACK,
    limit: OWNER2_CARD2_LIMIT_FALLBACK,
    policySource: "fallback",
  };
}
