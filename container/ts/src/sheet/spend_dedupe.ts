const MERCHANT_SUFFIX_RE =
  /\b(pte\.?\s*ltd|pte|ltd|limited|inc|corp|co\.?|company|sg|singapore)\b/gi;

/** Collapse whitespace, lowercase, and strip common legal suffixes for dedupe. */
export function normalizeMerchant(merchant: string): string {
  return merchant
    .toLowerCase()
    .replace(MERCHANT_SUFFIX_RE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function merchantTokens(merchant: string): Set<string> {
  return new Set(
    normalizeMerchant(merchant)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

/** True when normalized merchants match or share enough tokens. */
export function merchantsAreSimilar(left: string, right: string): boolean {
  const a = normalizeMerchant(left);
  const b = normalizeMerchant(right);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.includes(b) || b.includes(a)) {
    return true;
  }
  const leftTokens = merchantTokens(left);
  const rightTokens = merchantTokens(right);
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  const minSize = Math.min(leftTokens.size, rightTokens.size);
  return minSize > 0 && overlap >= Math.min(2, minSize);
}

export type SpendNearDuplicate = {
  id: string;
  merchant: string;
  amount: string;
  spent_on: string;
};

/** Same date and amount with a similar merchant name, excluding the exact dedupe key row. */
type SpendRowLike = {
  id: string;
  merchant: string;
  amount: string;
  spent_on: string;
  dedupe_key: string;
  voided_at?: string | null;
};

export function findNearDuplicateSpend(
  rows: ReadonlyArray<SpendRowLike>,
  candidate: { spentOn: string; merchant: string; amount: string; dedupeKey: string },
): SpendNearDuplicate[] {
  const hits: SpendNearDuplicate[] = [];
  for (const row of rows) {
    if (row.dedupe_key === candidate.dedupeKey || row.voided_at) {
      continue;
    }
    if (row.spent_on !== candidate.spentOn || row.amount !== candidate.amount) {
      continue;
    }
    if (merchantsAreSimilar(row.merchant, candidate.merchant)) {
      hits.push({
        id: row.id,
        merchant: row.merchant,
        amount: row.amount,
        spent_on: row.spent_on,
      });
    }
  }
  return hits;
}
