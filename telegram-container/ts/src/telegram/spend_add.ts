import { cardLabel } from "../profile.js";
import { previewSpendAdd, type SoftConfirmPreview } from "../assistant/soft_confirm.js";
import { melvbotCli } from "../assistant/tools.js";
import { listSpend } from "../sheet/spend_list.js";
import type { SpendRow } from "../sheet/spend_rows.js";
import type { SpendAddEntry } from "../sheet/spend_prose.js";
import type { SpendCard } from "../sheet/spend_cycle.js";
import { withTimeout } from "./intercept_log.js";

const SPEND_ADD_MS = 25_000;

/** Overridable seams so tests need no sheet or CLI. */
export type SpendAddDeps = {
  preview?: (argv: string[]) => Promise<SoftConfirmPreview | null>;
  /** Runs `melvbot <argv>` with the chat key (so the change log and `undo` see it); returns stdout. */
  run?: (argv: string[], chatKey: string) => Promise<string>;
  totals?: (card: SpendCard, cycleDate: string) => Promise<string>;
  /** Sheet rows for rename/delete matching. */
  rows?: (card: SpendCard) => Promise<SpendRow[]>;
};

export function spendLabel(card: SpendCard): string {
  return cardLabel(card.owner, card.card);
}

export function spendAddArgv(card: SpendCard, entry: SpendAddEntry): string[] {
  return ["sheet", "spend", "add", "--owner", card.owner, "--card", card.card, entry.spentOn, entry.merchant, entry.amount];
}

function dayText(iso: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${months[month - 1] ?? iso}`;
}

export function entryText(entry: SpendAddEntry): string {
  return `${entry.merchant} $${entry.amount} (${dayText(entry.spentOn)})`;
}

/** Previews every entry; returns the confirm reasons (empty when all can be written straight away). */
export async function previewSpendEntries(
  card: SpendCard,
  entries: SpendAddEntry[],
  deps: SpendAddDeps,
): Promise<string[]> {
  const preview = deps.preview ?? previewSpendAdd;
  const reasons: string[] = [];
  for (const entry of entries) {
    const result = await withTimeout(preview(spendAddArgv(card, entry)), SPEND_ADD_MS, "spend preview");
    if (result?.needsConfirm) {
      const why = result.summary.split("Needs confirm because:\n")[1] ?? "";
      reasons.push(`${entryText(entry)}\n${why}`.trim());
    }
  }
  return reasons;
}

/** Writes every entry through the same `sheet spend add` CLI path the agent tool uses, then appends card totals. */
export async function writeSpendEntries(
  card: SpendCard,
  entries: SpendAddEntry[],
  chatKey: string,
  deps: SpendAddDeps,
): Promise<string> {
  const run = deps.run ?? (async (argv, key) => (await melvbotCli(argv, { chatKey: key })).stdout);
  const lines: string[] = [];
  for (const entry of entries) {
    const stdout = await withTimeout(run(spendAddArgv(card, entry), chatKey), SPEND_ADD_MS, "spend add");
    let parsed: { inserted?: boolean; near_duplicates?: { id: number; merchant: string; spent_on: string }[] } = {};
    try {
      parsed = JSON.parse(stdout) as typeof parsed;
    } catch {
      parsed = {};
    }
    const base = `${entry.merchant} $${entry.amount} → ${spendLabel(card)} (${dayText(entry.spentOn)})`;
    let line = parsed.inserted === false ? `Already logged ${base}` : `Logged ${base}`;
    if (parsed.near_duplicates?.length) {
      line += ` (similar: ${parsed.near_duplicates.map((row) => `${row.merchant} ${row.spent_on}`).join("; ")})`;
    }
    lines.push(line);
  }
  const latest = entries.map((entry) => entry.spentOn).sort().at(-1) as string;
  const totals = deps.totals
    ? await deps.totals(card, latest)
    : (await withTimeout(listSpend({ owner: card.owner, card: card.card, cycleDate: latest }), SPEND_ADD_MS, "spend totals"))
        .telegram_totals;
  return totals ? `${lines.join("\n")}\n\n${totals}` : lines.join("\n");
}

export function spendConfirmText(card: SpendCard, entries: SpendAddEntry[], reasons: string[]): string {
  return [
    `Log to ${spendLabel(card)}?`,
    ...entries.map((entry) => `- ${entryText(entry)}`),
    "",
    "Needs confirm because:",
    ...reasons,
  ].join("\n");
}
