import { cardLabel, vehicleName } from "../profile.js";
import { loadSheetsToml } from "./toml.js";
import { sheetValues } from "./sheets.js";
import { annotateSpendRules } from "./spend_telegram.js";

export const RULES_TAB = "Rules";

export async function readSheetRules(): Promise<{ tab: string; values: string[][] }> {
  const ids = loadSheetsToml();
  const [owner1Rows, owner2Rows, ev] = await Promise.all([
    sheetValues(ids.owner1SpreadsheetId, RULES_TAB),
    sheetValues(ids.owner2SpreadsheetId, RULES_TAB),
    sheetValues(ids.evSpreadsheetId, RULES_TAB),
  ]);
  const values: string[][] = [
    [cardLabel("owner1", "card1")],
    ...owner1Rows,
    [],
    [cardLabel("owner2", "card2")],
    ...owner2Rows,
    [],
    [`${vehicleName()} M6 Charging`],
    ...ev,
  ];
  return { tab: RULES_TAB, values: annotateSpendRules(values) };
}
