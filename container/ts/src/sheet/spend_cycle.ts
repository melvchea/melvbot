import { cardLabel, displayNames } from "../profile.js";
import { createHash } from "node:crypto";

import { normalizeMerchant } from "./spend_dedupe.js";

export const OWNER1_CARD1_TARGET_FALLBACK = "625.00";
export const OWNER2_CARD2_TARGET_FALLBACK = "800.00";
export const OWNER2_CARD2_LIMIT_FALLBACK = "1333.00";
export const OWNER2_ID_BASE = 1_000_000;
export const TRANSACTIONS_TAB = "Transactions";
export const OWNER1_TX_HEADERS = [
  "id",
  "owner",
  "card",
  "spent_on",
  "merchant",
  "amount",
  "cycle_start",
  "cycle_end",
  "source_ref",
] as const;
export const OWNER2_TX_HEADERS = [
  "billing_cycle",
  "cycle_start",
  "cycle_end",
  "spent_on",
  "merchant",
  "amount",
] as const;

export type SpendCard = { owner: "owner1" | "owner2"; card: "card1" | "card2" };

/** Accepts ids, profile display names or the full label, since prompts render display names. */
export function normalizeSpendCard(owner: string, card: string): SpendCard {
  const names = displayNames();
  const ownerKey = owner.trim().toLowerCase();
  const cardKey = card.trim().toLowerCase();
  for (const id of ["owner1", "owner2"] as const) {
    const cardId = id === "owner1" ? "card1" : "card2";
    const ownerOk = ownerKey === id || ownerKey === names[id].toLowerCase();
    const cardOk = [cardId, names[cardId], cardLabel(id, cardId)].some((k) => k.toLowerCase() === cardKey);
    if (ownerOk && cardOk) {
      return { owner: id, card: cardId };
    }
  }
  throw new Error(`unsupported owner/card pair: ${owner}/${card}`);
}

function ymd(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function parseIsoDate(value: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("date must use YYYY-MM-DD");
  }
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

export function spendCycle(
  card: SpendCard,
  spentOn: string,
): { cycleStart: string; cycleEnd: string } {
  const { y, m, d } = parseIsoDate(spentOn);
  if (card.owner === "owner1" && card.card === "card1") {
    const start = ymd(y, m, 1);
    const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    const endDate = new Date(Date.UTC(next.y, next.m - 1, 1));
    endDate.setUTCDate(0);
    return { cycleStart: start, cycleEnd: ymd(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate()) };
  }
  if (d >= 27) {
    const start = ymd(y, m, 27);
    const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    return { cycleStart: start, cycleEnd: ymd(next.y, next.m, 26) };
  }
  const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return { cycleStart: ymd(prev.y, prev.m, 27), cycleEnd: ymd(y, m, 26) };
}

export function moneyText(value: number): string {
  return value.toFixed(2);
}

export function spendDedupeKey(parts: {
  owner: string;
  card: string;
  spentOn: string;
  merchant: string;
  amount: string;
}): string {
  const canonical = [
    "spend",
    parts.owner,
    parts.card,
    parts.spentOn,
    normalizeMerchant(parts.merchant),
    parts.amount,
  ]
    .map((part) => part.trim())
    .join("\x1f");
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseMoney(value: string): number {
  const cleaned = value.replaceAll(/[$,]/g, "").trim();
  const amount = Number.parseFloat(cleaned);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`invalid monetary amount: ${value}`);
  }
  return Math.round(amount * 100) / 100;
}

export function formatMoney(amount: number): string {
  const cents = Math.round(amount * 100);
  if (cents % 100 === 0) {
    return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
