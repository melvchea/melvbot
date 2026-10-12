import {
  OWNER2_ID_BASE,
  TRANSACTIONS_TAB,
  spendDedupeKey,
  type SpendCard,
} from "./spend_cycle.js";
import { loadSheetsToml } from "./toml.js";
import { namedRows, sheetValues } from "./sheets.js";

export type SpendRow = {
  id: string;
  owner: string;
  card: string;
  cycle_start: string | null;
  cycle_end: string | null;
  spent_on: string;
  merchant: string;
  amount: string;
  source_ref: string | null;
  voided_at: string | null;
  dedupe_key: string;
};

function mapped(
  owner: SpendCard["owner"],
  card: SpendCard["card"],
  spentOn: string,
  merchant: string,
  amount: string,
  extra: Omit<SpendRow, "owner" | "card" | "spent_on" | "merchant" | "amount" | "dedupe_key">,
): SpendRow {
  return {
    owner,
    card,
    spent_on: spentOn,
    merchant,
    amount,
    dedupe_key: spendDedupeKey({ owner, card, spentOn, merchant, amount }),
    ...extra,
  };
}

function mapOwner1(rows: Record<string, string | null>[]): SpendRow[] {
  return rows
    .filter((raw) => raw.spent_on && raw.amount != null)
    .map((raw) => {
      const merchant = raw.merchant ?? "";
      const amount = String(raw.amount);
      const spentOn = String(raw.spent_on);
      return mapped("owner1", "card1", spentOn, merchant, amount, {
        id: String(raw.id ?? ""),
        cycle_start: raw.cycle_start,
        cycle_end: raw.cycle_end,
        source_ref: raw.source_ref,
        voided_at: raw.voided_at,
      });
    });
}

function mapOwner2(rows: Record<string, string | null>[]): SpendRow[] {
  return rows
    .filter((raw) => raw.spent_on && raw.amount != null)
    .map((raw, index) => {
      const merchant = raw.merchant ?? "";
      const amount = String(raw.amount);
      const spentOn = String(raw.spent_on);
      return mapped("owner2", "card2", spentOn, merchant, amount, {
        id: String(OWNER2_ID_BASE + index + 1),
        cycle_start: raw.cycle_start,
        cycle_end: raw.cycle_end,
        source_ref: null,
        voided_at: raw.voided_at,
      });
    });
}

export type SpendEntryJson = {
  id: number;
  owner: string;
  card: string;
  spent_on: string;
  merchant: string;
  amount: string;
  cycle_start: string;
  cycle_end: string;
  source_ref: string | null;
};

export async function listSpendRows(card: SpendCard): Promise<SpendRow[]> {
  const ids = loadSheetsToml();
  if (card.owner === "owner1") {
    return mapOwner1(namedRows(await sheetValues(ids.owner1SpreadsheetId, TRANSACTIONS_TAB)));
  }
  return mapOwner2(namedRows(await sheetValues(ids.owner2SpreadsheetId, TRANSACTIONS_TAB)));
}
