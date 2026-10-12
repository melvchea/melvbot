import { appendNamed, namedRows, sheetValues, writeNamed } from "./sheets.js";
import { loadSheetsToml } from "./toml.js";
import { moneyText, parseMoney } from "./spend_cycle.js";
import {
  EV_HEADERS,
  EV_TAB,
  evDedupeKey,
  legacyNonpublicEvDedupeKey,
  type ChargeType,
} from "./ev.js";
import { asChargeType, evChargeFromRow, listEvSheetRows } from "./ev_rows.js";
import type { WriteReceipt } from "../memory/change_log.js";
import { currentSourceRef } from "../source_ref.js";

function nowIso(): string {
  return new Date().toISOString();
}

function nextNumericId(rows: Record<string, string | null>[]): number {
  const ids = rows
    .map((row) => Number.parseInt(String(row.id ?? ""), 10))
    .filter((id) => Number.isFinite(id));
  return (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
}

function parsePositiveDecimal(value: string): string {
  const amount = Number.parseFloat(value.replaceAll(/[$,]/g, "").trim());
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invalid decimal: ${value}`);
  }
  return value.trim();
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const cleaned = tag.trim();
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

async function putEv(row: Record<string, string | null>): Promise<Record<string, string | null>> {
  const ids = loadSheetsToml();
  const rows = await listEvSheetRows();
  const existing = rows.find((candidate) => candidate.dedupe_key === row.dedupe_key);
  const outgoing: Record<string, string | null> = {};
  for (const header of EV_HEADERS) {
    outgoing[header] = row[header] ?? null;
  }
  if (existing === undefined) {
    outgoing.id = String(nextNumericId(rows));
    await appendNamed(ids.evSpreadsheetId, EV_TAB, EV_HEADERS, outgoing);
    return { ...row, id: outgoing.id };
  }
  let sheetRow: number | undefined;
  for (const [index, raw] of rows.entries()) {
    if (String(raw.id ?? "") === String(existing.id)) {
      sheetRow = index + 2;
      break;
    }
  }
  if (sheetRow === undefined) {
    throw new Error(`ev id not found: ${existing.id}`);
  }
  outgoing.id = existing.id;
  await writeNamed(ids.evSpreadsheetId, EV_TAB, EV_HEADERS, sheetRow, outgoing);
  return { ...row, id: existing.id };
}

async function adoptEvDedupe(entryId: number, newKey: string): Promise<void> {
  const ids = loadSheetsToml();
  const values = namedRows(await sheetValues(ids.evSpreadsheetId, EV_TAB));
  for (const [index, raw] of values.entries()) {
    if (String(raw.id ?? "") !== String(entryId)) {
      continue;
    }
    const outgoing: Record<string, string | null> = {};
    for (const header of EV_HEADERS) {
      outgoing[header] = raw[header];
    }
    outgoing.dedupe_key = newKey;
    await writeNamed(ids.evSpreadsheetId, EV_TAB, EV_HEADERS, index + 2, outgoing);
    return;
  }
  throw new Error(`ev id not found: ${entryId}`);
}

export async function upsertEv(
  options: {
    chargeType: string;
    chargedOn: string;
    odometerKm?: number;
    energyKwh?: string;
    site?: string;
    cost?: string;
    tags: string[];
  },
  writeOptions: { skipChangeLog?: boolean; internalWrite?: boolean; chatKey?: string | null } = {},
): Promise<{ inserted: boolean; entry: ReturnType<typeof evChargeFromRow>; receipt?: WriteReceipt }> {
  const chargeType: ChargeType = asChargeType(options.chargeType);
  if (options.odometerKm !== undefined && options.odometerKm < 0) {
    throw new Error("odometer must not be negative");
  }
  const energy = options.energyKwh === undefined ? null : parsePositiveDecimal(options.energyKwh);
  const cost = options.cost === undefined ? null : moneyText(parseMoney(options.cost));
  const site = options.site?.trim() ? options.site.trim() : null;
  const tags = uniqueTags(options.tags);
  if (chargeType === "public" && !site) {
    throw new Error("public charges require a site");
  }
  if (chargeType !== "partial" && energy === null) {
    throw new Error(`${chargeType} charges require energy`);
  }
  const odometerKm = options.odometerKm ?? null;
  const key = evDedupeKey({
    chargeType,
    chargedOn: options.chargedOn,
    odometerKm,
    energyKwh: energy,
    site,
  });
  const rows = await listEvSheetRows();
  let existing = rows.find((row) => row.dedupe_key === key);
  if (existing === undefined && chargeType !== "public") {
    const legacy = legacyNonpublicEvDedupeKey({
      chargedOn: options.chargedOn,
      odometerKm,
      energyKwh: energy,
    });
    if (legacy !== key) {
      const legacyRow = rows.find((row) => row.dedupe_key === legacy);
      if (legacyRow !== undefined && legacyRow.charge_type === chargeType) {
        await adoptEvDedupe(Number(legacyRow.id ?? "0"), key);
        existing = { ...legacyRow, dedupe_key: key };
      }
    }
  }
  const now = nowIso();
  const tagsJson =
    existing !== undefined && tags.length === 0 ? existing.tags_json || "[]" : JSON.stringify(tags);
  const beforeEntry = existing ? evChargeFromRow(existing) : null;
  const persisted = await putEv({
    dedupe_key: key,
    charge_type: chargeType,
    charged_on: options.chargedOn,
    odometer_km: odometerKm === null ? null : String(odometerKm),
    energy_kwh: energy,
    site,
    cost,
    tags_json: tagsJson,
    source_ref: existing === undefined ? currentSourceRef() : existing.source_ref,
    created_at: now,
    updated_at: now,
    voided_at: existing === undefined ? null : existing.voided_at,
    id: existing?.id ?? null,
  });
  const entry = evChargeFromRow(persisted);
  let receipt: WriteReceipt | undefined;
  if (!writeOptions.skipChangeLog && !writeOptions.internalWrite) {
    receipt = {
      receipt: true,
      action: "sheet ev add",
      target: String(entry.id),
      verified: true,
      sourceRef: entry.source_ref ?? undefined,
    };
  }
  return { inserted: existing === undefined, entry, receipt };
}

export async function voidEv(entryId: number): Promise<void> {
  const ids = loadSheetsToml();
  const values = namedRows(await sheetValues(ids.evSpreadsheetId, EV_TAB));
  for (const [index, raw] of values.entries()) {
    if (String(raw.id ?? "") !== String(entryId)) {
      continue;
    }
    if (raw.voided_at) {
      return;
    }
    const outgoing: Record<string, string | null> = {};
    for (const header of EV_HEADERS) {
      outgoing[header] = raw[header];
    }
    outgoing.voided_at = nowIso();
    await writeNamed(ids.evSpreadsheetId, EV_TAB, EV_HEADERS, index + 2, outgoing);
    return;
  }
  throw new Error(`ev id not found: ${entryId}`);
}
