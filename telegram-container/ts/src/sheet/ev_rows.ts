import { namedRows, sheetValues } from "./sheets.js";
import { loadSheetsToml } from "./toml.js";
import { EV_TAB, isChargeType, type EvCharge, type ChargeType } from "./ev.js";

export async function listEvSheetRows(): Promise<Record<string, string | null>[]> {
  const ids = loadSheetsToml();
  return namedRows(await sheetValues(ids.evSpreadsheetId, EV_TAB));
}

export function evChargeFromRow(row: Record<string, string | null>): EvCharge {
  const chargeType = String(row.charge_type ?? "");
  if (!isChargeType(chargeType)) {
    throw new Error(`unsupported charge type: ${chargeType}`);
  }
  const odometer = row.odometer_km;
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags_json || "[]") as unknown;
    if (Array.isArray(parsed)) {
      tags = parsed.map((item) => String(item));
    }
  } catch {
    tags = [];
  }
  return {
    id: Number(row.id ?? "0"),
    charge_type: chargeType,
    charged_on: String(row.charged_on),
    odometer_km: odometer == null || odometer === "" ? null : Number.parseInt(odometer, 10),
    energy_kwh: row.energy_kwh,
    site: row.site,
    cost: row.cost,
    tags,
    dedupe_key: String(row.dedupe_key ?? ""),
    source_ref: row.source_ref,
  };
}

export function liveEvCharges(rows: Record<string, string | null>[]): EvCharge[] {
  return rows.filter((row) => row.charged_on && !row.voided_at).map(evChargeFromRow);
}

export function asChargeType(value: string): ChargeType {
  if (!isChargeType(value)) {
    throw new Error(`unsupported charge type: ${value}`);
  }
  return value;
}
