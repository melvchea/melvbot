import { cardLabel, vehicleName } from "../profile.js";
import { parseEvAddArgs, parseSpendAddBatch } from "../sheet/add_args.js";
import { asChargeType, listEvSheetRows } from "../sheet/ev_rows.js";
import { evDedupeKey, type ChargeType } from "../sheet/ev.js";
import { findNearDuplicateSpend } from "../sheet/spend_dedupe.js";
import { listSpendRows } from "../sheet/spend_rows.js";
import { moneyText, normalizeSpendCard, parseMoney, spendCycle, spendDedupeKey } from "../sheet/spend_cycle.js";

export const SPEND_SOFT_CONFIRM_AMOUNT = 500;
export const EV_SOFT_CONFIRM_COST = 100;

function parseEvAdd(argv: string[]): {
  chargeType: ChargeType;
  chargedOn: string;
  odometerKm?: number;
  energyKwh?: string;
  site?: string;
  cost?: string;
} | null {
  const parsed = parseEvAddArgs(argv.slice(2));
  if (!parsed.ok) {
    return null;
  }
  const { chargedOn, values } = parsed.value;
  const odometerRaw = values.get("--odometer");
  const odometerKm = odometerRaw === undefined ? undefined : Number.parseInt(odometerRaw, 10);
  if (odometerRaw !== undefined && !Number.isFinite(odometerKm)) {
    return null;
  }
  return {
    chargeType: asChargeType(values.get("--type") ?? "full"),
    chargedOn,
    odometerKm,
    energyKwh: values.get("--energy"),
    site: values.get("--site"),
    cost: values.get("--cost"),
  };
}

export type SoftConfirmPreview = { needsConfirm: boolean; summary: string };

export async function previewSpendAdd(argv: string[]): Promise<SoftConfirmPreview | null> {
  const parsedArgs = parseSpendAddBatch(argv.slice(2));
  if (!parsedArgs.ok) {
    return null;
  }
  const { rows: newRows, voidIds } = parsedArgs.value;
  const card = normalizeSpendCard(parsedArgs.value.owner, parsedArgs.value.card);
  const rows = await listSpendRows(card);
  const many = newRows.length > 1;
  const reasons: string[] = [];
  const lines: string[] = [];
  if (voidIds.length > 0) {
    const shown = voidIds.map((id) => {
      const row = rows.find((r) => Number(r.id) === id);
      return row ? `id ${id} (${row.merchant}, ${row.amount})` : `id ${id}`;
    });
    reasons.push(`voids spend ${shown.join("; ")}`);
  }
  for (const parsed of newRows) {
    const amount = moneyText(parseMoney(parsed.amount));
    const dedupeKey = spendDedupeKey({ owner: card.owner, card: card.card, spentOn: parsed.spentOn, merchant: parsed.merchant, amount });
    const existing = rows.find((row) => row.dedupe_key === dedupeKey);
    const nearDuplicates = findNearDuplicateSpend(rows, { spentOn: parsed.spentOn, merchant: parsed.merchant, amount, dedupeKey });
    const tag = many ? `${parsed.merchant} ${amount}: ` : "";
    lines.push(`${parsed.spentOn} ${parsed.merchant} ${amount}`);
    if (parseMoney(parsed.amount) >= SPEND_SOFT_CONFIRM_AMOUNT) {
      reasons.push(`${tag}amount ${amount} is at or above $${SPEND_SOFT_CONFIRM_AMOUNT}`);
    }
    if (existing !== undefined) {
      reasons.push(`${tag}updates existing spend id ${existing.id} (${existing.merchant}, ${existing.amount})`);
    }
    if (nearDuplicates.length > 0) {
      const near = nearDuplicates.map((row) => `id ${row.id}: ${row.merchant} on ${row.spent_on}`).join("; ");
      reasons.push(`${tag}near-duplicate rows: ${near}`);
    }
  }
  if (reasons.length === 0) {
    return { needsConfirm: false, summary: "" };
  }
  const first = newRows[0];
  const { cycleStart, cycleEnd } = spendCycle(card, first.spentOn);
  return {
    needsConfirm: true,
    summary: [
      many ? `Log ${newRows.length} spend rows?` : `Log spend ${moneyText(parseMoney(first.amount))} at ${first.merchant}?`,
      `Owner/card: ${cardLabel(card.owner, card.card)}`,
      many ? lines.map((line) => `- ${line}`).join("\n") : `Date: ${first.spentOn} (cycle ${cycleStart} → ${cycleEnd})`,
      "",
      "Needs confirm because:",
      ...reasons.map((reason) => `- ${reason}`),
    ].join("\n"),
  };
}

export async function previewEvAdd(argv: string[]): Promise<SoftConfirmPreview | null> {
  const parsed = parseEvAdd(argv);
  if (!parsed) {
    return null;
  }
  const energy = parsed.energyKwh?.trim() ? parsed.energyKwh.trim() : null;
  const cost = parsed.cost?.trim() ? moneyText(parseMoney(parsed.cost)) : null;
  const site = parsed.site?.trim() ? parsed.site.trim() : null;
  const key = evDedupeKey({
    chargeType: parsed.chargeType,
    chargedOn: parsed.chargedOn,
    odometerKm: parsed.odometerKm ?? null,
    energyKwh: energy,
    site,
  });
  const rows = await listEvSheetRows();
  const existing = rows.find((row) => row.dedupe_key === key);
  const reasons: string[] = [];
  if (cost !== null && parseMoney(cost) >= EV_SOFT_CONFIRM_COST) {
    reasons.push(`cost ${cost} is at or above $${EV_SOFT_CONFIRM_COST}`);
  }
  if (parsed.chargeType === "partial" && energy === null) {
    reasons.push("partial charge without --energy");
  }
  if (existing !== undefined) {
    reasons.push(`updates existing ev id ${existing.id} (${existing.charge_type} on ${existing.charged_on})`);
  }
  if (reasons.length === 0) {
    return { needsConfirm: false, summary: "" };
  }
  return {
    needsConfirm: true,
    summary: [
      `Log ${vehicleName()} ${parsed.chargeType} charge on ${parsed.chargedOn}?`,
      energy ? `Energy: ${energy} kWh` : null,
      cost ? `Cost: ${cost}` : null,
      site ? `Site: ${site}` : null,
      "",
      "Needs confirm because:",
      ...reasons.map((reason) => `- ${reason}`),
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  };
}
