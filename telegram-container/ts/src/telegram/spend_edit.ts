import { melvbotCli } from "../assistant/tools.js";
import { listSpendRows, type SpendRow } from "../sheet/spend_rows.js";
import type { SpendCard } from "../sheet/spend_cycle.js";
import { withTimeout } from "./intercept_log.js";
import { spendLabel, type SpendAddDeps } from "./spend_add.js";

const EDIT_MS = 25_000;
const AMOUNT_G = /S?\$\s?\d[\d,]*(?:\.\d+)?/gi;
const MERCHANT_AMOUNT_RE = /^(?<merchant>.*?)\s*S?\$\s?(?<amount>\d[\d,]*(?:\.\d+)?)$/i;

export type SpendEdit = { kind: "rename"; from: string; to: string } | { kind: "delete"; target: string };

const norm = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();
const num = (value: string): number => Number.parseFloat(value.replace(/[^\d.]/g, ""));

/** Live rows whose merchant is the target text, "merchant $amount", or the target with amounts stripped. */
export function matchSpendRows(rows: SpendRow[], target: string): SpendRow[] {
  const live = rows.filter((row) => !row.voided_at);
  const wanted = norm(target);
  const exact = live.filter((row) => norm(row.merchant) === wanted);
  if (exact.length > 0) {
    return exact;
  }
  const withAmount = MERCHANT_AMOUNT_RE.exec(target.trim());
  if (withAmount?.groups) {
    const merchant = norm(withAmount.groups.merchant);
    const amount = num(withAmount.groups.amount);
    const hit = live.filter((row) => norm(row.merchant) === merchant && num(row.amount) === amount);
    if (hit.length > 0) {
      return hit;
    }
  }
  const stripped = norm(target.replace(AMOUNT_G, ""));
  return stripped ? live.filter((row) => norm(row.merchant.replace(AMOUNT_G, "")) === stripped) : [];
}

export type SpendEditPlan = { text: string; argvs: string[][] };

/** Rows to change plus the CLI calls and confirm text; null when no row matches. */
export async function planSpendEdit(card: SpendCard, edit: SpendEdit, deps: SpendAddDeps): Promise<SpendEditPlan | null> {
  const rows = matchSpendRows(await withTimeout((deps.rows ?? listSpendRows)(card), EDIT_MS, "spend rows"), edit.kind === "rename" ? edit.from : edit.target);
  if (rows.length === 0) {
    return null;
  }
  const lines = rows.map((row) => `- ${row.merchant} $${row.amount} (${row.spent_on})`);
  const owner = ["--owner", card.owner, "--card", card.card];
  if (edit.kind === "rename") {
    return {
      text: [`Rename ${rows.length} row(s) in ${spendLabel(card)} to "${edit.to}"?`, ...lines].join("\n"),
      argvs: rows.map((row) => ["sheet", "spend", "add", ...owner, "--void", row.id, row.spent_on, edit.to, row.amount]),
    };
  }
  return {
    text: [`Delete ${rows.length} row(s) from ${spendLabel(card)}?`, ...lines].join("\n"),
    argvs: [["sheet", "spend", "void", ...rows.map((row) => row.id)]],
  };
}

export async function runSpendEdit(argvs: string[][], chatKey: string, deps: SpendAddDeps): Promise<string> {
  const run = deps.run ?? (async (argv, key) => (await melvbotCli(argv, { chatKey: key })).stdout);
  for (const argv of argvs) {
    await withTimeout(run(argv, chatKey), EDIT_MS, "spend edit");
  }
  const verb = argvs[0]?.[2] === "void" ? "Deleted" : "Renamed";
  const count = argvs[0]?.[2] === "void" ? argvs[0].length - 3 : argvs.length;
  return `${verb} ${count} row(s).`;
}
