import {
  OWNER2_ID_BASE,
  OWNER2_TX_HEADERS,
  OWNER1_TX_HEADERS,
  TRANSACTIONS_TAB,
  moneyText,
  normalizeSpendCard,
  parseMoney,
  spendCycle,
  spendDedupeKey,
} from "./spend_cycle.js";
import { appendNamed, namedRows, sheetValues, writeNamed } from "./sheets.js";
import { listSpendRows, type SpendEntryJson, type SpendRow } from "./spend_rows.js";
import { loadSheetsToml } from "./toml.js";
import { recordChange, type WriteReceipt } from "../memory/change_log.js";
import { findNearDuplicateSpend, type SpendNearDuplicate } from "./spend_dedupe.js";
import { currentSourceRef } from "../source_ref.js";

export const SPEND_ADD_ACTION = "spend add";

export function spendLogTarget(card: { owner: string; card: string }): string {
  return `${card.owner}/${card.card}`;
}

function entryJson(row: SpendRow): SpendEntryJson {
  return {
    id: Number(row.id),
    owner: row.owner,
    card: row.card,
    spent_on: row.spent_on,
    merchant: row.merchant,
    amount: moneyText(parseMoney(row.amount)),
    cycle_start: String(row.cycle_start ?? ""),
    cycle_end: String(row.cycle_end ?? ""),
    source_ref: row.source_ref,
  };
}

function nextNumericId(rows: SpendRow[]): number {
  const ids = rows
    .map((row) => Number.parseInt(row.id, 10))
    .filter((id) => Number.isFinite(id));
  return (ids.length === 0 ? 0 : Math.max(...ids)) + 1;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function putOwner1(row: SpendRow, existing: SpendRow | undefined): Promise<SpendRow> {
  const ids = loadSheetsToml();
  const outgoing: Record<string, string | null> = {
    id: row.id,
    owner: "owner1",
    card: "card1",
    spent_on: row.spent_on,
    merchant: row.merchant,
    amount: row.amount,
    cycle_start: row.cycle_start,
    cycle_end: row.cycle_end,
    source_ref: row.source_ref,
  };
  if (existing === undefined) {
    outgoing.id = String(nextNumericId(await listSpendRows({ owner: "owner1", card: "card1" })));
    await appendNamed(ids.owner1SpreadsheetId, TRANSACTIONS_TAB, OWNER1_TX_HEADERS, outgoing);
    return { ...row, id: outgoing.id };
  }
  const values = namedRows(await sheetValues(ids.owner1SpreadsheetId, TRANSACTIONS_TAB));
  let sheetRow: number | undefined;
  for (const [index, raw] of values.entries()) {
    if (String(raw.id ?? "") === existing.id) {
      sheetRow = index + 2;
      break;
    }
  }
  if (sheetRow === undefined) {
    throw new Error(`spend id not found: ${existing.id}`);
  }
  outgoing.id = existing.id;
  await writeNamed(ids.owner1SpreadsheetId, TRANSACTIONS_TAB, OWNER1_TX_HEADERS, sheetRow, outgoing);
  return { ...row, id: existing.id };
}

async function putOwner2(row: SpendRow, existing: SpendRow | undefined): Promise<SpendRow> {
  const ids = loadSheetsToml();
  const outgoing: Record<string, string | null> = {
    billing_cycle: row.cycle_start,
    cycle_start: row.cycle_start,
    cycle_end: row.cycle_end,
    spent_on: row.spent_on,
    merchant: row.merchant,
    amount: row.amount,
  };
  if (existing === undefined) {
    await appendNamed(ids.owner2SpreadsheetId, TRANSACTIONS_TAB, OWNER2_TX_HEADERS, outgoing);
    const listed = (await listSpendRows({ owner: "owner2", card: "card2" })).find(
      (candidate) => candidate.dedupe_key === row.dedupe_key,
    );
    return listed ?? row;
  }
  const sheetIndex = Number(existing.id) - OWNER2_ID_BASE;
  await writeNamed(ids.owner2SpreadsheetId, TRANSACTIONS_TAB, OWNER2_TX_HEADERS, sheetIndex + 1, outgoing);
  return { ...row, id: existing.id };
}

export async function upsertSpend(
  options: {
    owner: string;
    card: string;
    spentOn: string;
    merchant: string;
    amount: string;
  },
  writeOptions: { skipChangeLog?: boolean; internalWrite?: boolean; chatKey?: string | null } = {},
): Promise<{ inserted: boolean; entry: SpendEntryJson; near_duplicates: SpendNearDuplicate[]; receipt?: WriteReceipt }> {
  const merchant = options.merchant.trim();
  if (!merchant) {
    throw new Error("merchant must not be empty");
  }
  const card = normalizeSpendCard(options.owner, options.card);
  const amount = moneyText(parseMoney(options.amount));
  const { cycleStart, cycleEnd } = spendCycle(card, options.spentOn);
  const dedupe_key = spendDedupeKey({
    owner: card.owner,
    card: card.card,
    spentOn: options.spentOn,
    merchant,
    amount,
  });
  const rows = await listSpendRows(card);
  const existing = rows.find((row) => row.dedupe_key === dedupe_key);
  const nearDuplicates = findNearDuplicateSpend(rows, {
    spentOn: options.spentOn,
    merchant,
    amount,
    dedupeKey: dedupe_key,
  });
  const beforeEntry = existing ? entryJson(existing) : null;
  const pending: SpendRow = {
    id: existing?.id ?? "",
    owner: card.owner,
    card: card.card,
    cycle_start: cycleStart,
    cycle_end: cycleEnd,
    spent_on: options.spentOn,
    merchant,
    amount,
    source_ref: existing?.source_ref ?? currentSourceRef(),
    voided_at: existing?.voided_at ?? null,
    dedupe_key,
  };
  const persisted =
    card.owner === "owner1" ? await putOwner1(pending, existing) : await putOwner2(pending, existing);
  const entry = entryJson(persisted);
  if (existing === undefined) {
    // History only: lets the Morning Update spend-gap nudge see backfills dated in past cycles.
    try {
      recordChange({ action: SPEND_ADD_ACTION, target: spendLogTarget(card), before: null, after: entry });
    } catch (error) {
      console.error("spend add: change_log write failed", error);
    }
  }
  let receipt: WriteReceipt | undefined;
  if (!writeOptions.skipChangeLog && !writeOptions.internalWrite) {
    receipt = {
      receipt: true,
      action: "sheet spend add",
      target: String(entry.id),
      verified: true,
      sourceRef: entry.source_ref ?? undefined,
    };
  }
  return { inserted: existing === undefined, entry, near_duplicates: nearDuplicates, receipt };
}

export async function voidSpend(entryId: number): Promise<void> {
  const now = nowIso();
  if (entryId >= OWNER2_ID_BASE) {
    const card = { owner: "owner2" as const, card: "card2" as const };
    const match = (await listSpendRows(card)).find((row) => Number(row.id) === entryId);
    if (match === undefined) {
      throw new Error(`spend id not found: ${entryId}`);
    }
    if (match.voided_at) {
      return;
    }
    const ids = loadSheetsToml();
    const sheetIndex = entryId - OWNER2_ID_BASE;
    const headers = [...OWNER2_TX_HEADERS, "voided_at"];
    await writeNamed(ids.owner2SpreadsheetId, TRANSACTIONS_TAB, headers, sheetIndex + 1, {
      billing_cycle: match.cycle_start,
      cycle_start: match.cycle_start,
      cycle_end: match.cycle_end,
      spent_on: match.spent_on,
      merchant: match.merchant,
      amount: match.amount,
      voided_at: now,
    });
    return;
  }
  const ids = loadSheetsToml();
  const sheet = await sheetValues(ids.owner1SpreadsheetId, TRANSACTIONS_TAB);
  // Bug: without a voided_at header the stamp landed in an unnamed column and the list never saw it.
  if (!(sheet[0] ?? []).includes("voided_at")) {
    const header = [...OWNER1_TX_HEADERS, "voided_at"];
    await writeNamed(ids.owner1SpreadsheetId, TRANSACTIONS_TAB, header, 1, Object.fromEntries(header.map((h) => [h, h])));
  }
  const values = namedRows(sheet);
  for (const [index, raw] of values.entries()) {
    if (String(raw.id ?? "") !== String(entryId)) {
      continue;
    }
    if (raw.voided_at) {
      return;
    }
    const outgoing: Record<string, string | null> = {};
    for (const header of OWNER1_TX_HEADERS) {
      outgoing[header] = raw[header];
    }
    outgoing.voided_at = now;
    await writeNamed(
      ids.owner1SpreadsheetId,
      TRANSACTIONS_TAB,
      [...OWNER1_TX_HEADERS, "voided_at"],
      index + 2,
      outgoing,
    );
    return;
  }
  throw new Error(`spend id not found: ${entryId}`);
}
