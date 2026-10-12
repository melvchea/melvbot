import { moneyText, normalizeSpendCard, parseMoney, spendCycle } from "./spend_cycle.js";
import { spendCardPolicy } from "./rules_policy.js";
import { spendTelegramTotals } from "./spend_telegram.js";
import { listSpendRows, type SpendEntryJson } from "./spend_rows.js";

export type { SpendEntryJson };

export type SpendSummaryJson = {
  owner: string;
  card: string;
  cycle_start: string;
  cycle_end: string;
  target: string;
  total: string;
  headroom: string;
  limit: string | null;
  owner2_threshold_exceeded: boolean;
  telegram_totals: string;
  entries: SpendEntryJson[];
  policy_source?: "fallback";
};

export async function listSpend(options: {
  owner: string;
  card: string;
  cycleDate: string;
}): Promise<SpendSummaryJson> {
  const card = normalizeSpendCard(options.owner, options.card);
  const { cycleStart, cycleEnd } = spendCycle(card, options.cycleDate);
  const [policy, rows] = await Promise.all([spendCardPolicy(card), listSpendRows(card)]);
  const entries = rows
    .filter(
      (row) =>
        row.owner === card.owner &&
        row.card === card.card &&
        row.cycle_start === cycleStart &&
        !row.voided_at,
    )
    .map((row) => {
      const amount = parseMoney(row.amount);
      return {
        id: Number(row.id),
        owner: row.owner,
        card: row.card,
        spent_on: row.spent_on,
        merchant: row.merchant,
        amount: moneyText(amount),
        cycle_start: String(row.cycle_start),
        cycle_end: String(row.cycle_end ?? cycleEnd),
        source_ref: row.source_ref,
        _amount: amount,
      };
    });
  const total = entries.reduce((sum, entry) => sum + entry._amount, 0);
  const target = parseMoney(policy.target);
  const limit = policy.limit === null ? null : parseMoney(policy.limit);
  return {
    owner: card.owner,
    card: card.card,
    cycle_start: cycleStart,
    cycle_end: cycleEnd,
    target: policy.target,
    total: moneyText(total),
    headroom: moneyText(target - total),
    limit: policy.limit,
    owner2_threshold_exceeded: limit !== null && total > limit,
    telegram_totals: spendTelegramTotals(total, target, limit),
    ...(policy.policySource === "fallback" ? { policy_source: "fallback" as const } : {}),
    entries: entries
      .sort((a, b) => (a.spent_on < b.spent_on ? -1 : a.spent_on > b.spent_on ? 1 : a.id - b.id))
      .map((entry) => ({
      id: entry.id,
      owner: entry.owner,
      card: entry.card,
      spent_on: entry.spent_on,
      merchant: entry.merchant,
      amount: entry.amount,
      cycle_start: entry.cycle_start,
      cycle_end: entry.cycle_end,
      source_ref: entry.source_ref,
    })),
  };
}

export type SpendAllJson = {
  owner: string;
  card: string;
  target: string;
  cycles: {
    cycle_start: string;
    cycle_end: string;
    total: string;
    headroom: string;
    entries: SpendEntryJson[];
  }[];
};

/** Every non-voided entry for the card across all cycles, grouped by cycle, newest first. */
export async function listSpendAll(options: { owner: string; card: string }): Promise<SpendAllJson> {
  const card = normalizeSpendCard(options.owner, options.card);
  const [policy, rows] = await Promise.all([spendCardPolicy(card), listSpendRows(card)]);
  const target = parseMoney(policy.target);
  const byCycle = new Map<string, { cycle_end: string; total: number; entries: SpendEntryJson[] }>();
  for (const row of rows) {
    if (row.owner !== card.owner || row.card !== card.card || row.voided_at || !row.cycle_start) {
      continue;
    }
    const amount = parseMoney(row.amount);
    const group = byCycle.get(row.cycle_start) ?? {
      cycle_end: String(row.cycle_end ?? spendCycle(card, row.cycle_start).cycleEnd),
      total: 0,
      entries: [],
    };
    group.total += amount;
    group.entries.push({
      id: Number(row.id),
      owner: row.owner,
      card: row.card,
      spent_on: row.spent_on,
      merchant: row.merchant,
      amount: moneyText(amount),
      cycle_start: String(row.cycle_start),
      cycle_end: group.cycle_end,
      source_ref: row.source_ref,
    });
    byCycle.set(row.cycle_start, group);
  }
  return {
    owner: card.owner,
    card: card.card,
    target: policy.target,
    cycles: [...byCycle.entries()]
      .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
      .map(([cycle_start, group]) => ({
        cycle_start,
        cycle_end: group.cycle_end,
        total: moneyText(group.total),
        headroom: moneyText(target - group.total),
        entries: group.entries,
      })),
  };
}
