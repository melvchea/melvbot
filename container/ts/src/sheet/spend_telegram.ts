import { formatMoney } from "./spend_cycle.js";

export const TELEGRAM_TOTALS_RULE_INSTRUCTION =
  "Spend recap totals line: copy telegram_totals from this turn's spend list JSON verbatim; do not compose Headroom from total / target / limit / headroom.";

function isHeadroomFooterCell(cell: string): boolean {
  return cell.includes("Headroom") && (cell.includes("Spent") || cell.includes("Target"));
}

export function annotateSpendRules(values: string[][]): string[][] {
  const annotated: string[][] = [];
  for (const row of values) {
    const filtered = row.filter((cell) => !isHeadroomFooterCell(cell));
    if (filtered.length > 0) {
      annotated.push(filtered);
    }
  }
  const flat = annotated.flat();
  if (!flat.some((cell) => cell.includes("telegram_totals"))) {
    annotated.push([TELEGRAM_TOTALS_RULE_INSTRUCTION]);
  }
  return annotated;
}

export function spendTelegramTotals(total: number, target: number, limit: number | null): string {
  if (limit !== null) {
    return owner2Totals(total, target, limit);
  }
  return owner1Totals(total, target);
}

function owner2Totals(total: number, target: number, limit: number): string {
  const belowLimit = limit - total;
  const limitText = formatMoney(limit);
  const targetText = formatMoney(target);
  if (total < target) {
    return `${formatMoney(target - total)} to Target ${targetText} · Spent ${formatMoney(belowLimit)} below Limit ${limitText}`;
  }
  if (total > limit) {
    return `Met Target ${targetText} · Spent ${formatMoney(total - limit)} over Limit ${limitText}`;
  }
  return `Met Target ${targetText} · Spent ${formatMoney(belowLimit)} below Limit ${limitText}`;
}

function owner1Totals(total: number, target: number): string {
  const targetText = formatMoney(target);
  if (total < target) {
    return `${formatMoney(target - total)} to Target ${targetText}`;
  }
  if (total > target) {
    return `Met Target ${targetText} · Spent ${formatMoney(Math.abs(total - target))} above Target`;
  }
  return `Met Target ${targetText}`;
}
