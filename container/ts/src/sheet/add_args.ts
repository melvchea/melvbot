// Shared argv parsing for `sheet spend add` / `sheet ev add` (CLI and Telegram confirm preview).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const SPEND_ADD_USAGE =
  "usage: melvbot sheet spend add --owner <owner1|owner2> --card <card1|card2> <YYYY-MM-DD> <merchant> <amount>\n" +
  "   or: melvbot sheet spend add --owner <owner1|owner2> --card <card1|card2> --spent-on <YYYY-MM-DD> --merchant <merchant> --amount <amount>  (--date = --spent-on; flags and positionals may be mixed)\n" +
  "   or: melvbot sheet spend add --owner <owner1|owner2> --card <card1|card2> [--void <id>]... <YYYY-MM-DD> <merchant> <amount> [<YYYY-MM-DD> <merchant> <amount>]...  (several rows in one call; --void retires amended rows, needs Confirm)\n";
export const EV_ADD_USAGE =
  "usage: melvbot sheet ev add <YYYY-MM-DD> [--type full|partial] [--odometer <km>] [--energy <kWh>] [--site <site>] [--cost <amount>] [--tag <tag>]  (or --charged-on / --date <YYYY-MM-DD> instead of the positional)\n";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

type Split = { values: Map<string, string>; positionals: string[]; unknown: string | null; missing: string | null };

function split(rest: string[], valueFlags: string[]): Split {
  const known = new Set(valueFlags);
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let unknown: string | null = null;
  let missing: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i];
    if (known.has(part)) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        missing ??= part;
      } else {
        if (!values.has(part) || part === "--tag") {
          values.set(part, next);
        }
        i += 1;
      }
    } else if (part.startsWith("--")) {
      unknown ??= part;
    } else {
      positionals.push(part);
    }
  }
  return { values, positionals, unknown, missing };
}

function problem(parts: Split): string | null {
  if (parts.unknown) {
    return `unknown option ${parts.unknown}`;
  }
  if (parts.missing) {
    return `option ${parts.missing} needs a value`;
  }
  return null;
}

export type SpendAddArgs = { owner: string; card: string; spentOn: string; merchant: string; amount: string };

/** `rest` = argv after `spend add`. Flags win; missing date/merchant/amount fill from positionals in order. */
export function parseSpendAddArgs(rest: string[]): ParseResult<SpendAddArgs> {
  const parts = split(rest, ["--owner", "--card", "--spent-on", "--date", "--merchant", "--amount"]);
  const bad = problem(parts);
  if (bad) {
    return { ok: false, reason: bad };
  }
  const queue = [...parts.positionals];
  const spentOnFlag = parts.values.get("--spent-on") ?? parts.values.get("--date");
  const merchantFlag = parts.values.get("--merchant");
  const amountFlag = parts.values.get("--amount");
  const spentOn = spentOnFlag ?? queue.shift();
  const merchant = merchantFlag ?? queue.shift();
  const amount = amountFlag ?? queue.shift();
  const owner = parts.values.get("--owner");
  const card = parts.values.get("--card");
  if (!owner || !card || !spentOn || !merchant || !amount) {
    return { ok: false, reason: "missing required argument" };
  }
  if (queue.length > 0) {
    return { ok: false, reason: `unexpected extra argument: ${queue[0]}` };
  }
  if (!ISO_DATE.test(spentOn)) {
    return { ok: false, reason: `date must use YYYY-MM-DD, got "${spentOn}" (check argument order)` };
  }
  return { ok: true, value: { owner, card, spentOn, merchant, amount } };
}

export type SpendBatchArgs = {
  owner: string;
  card: string;
  rows: { spentOn: string; merchant: string; amount: string }[];
  voidIds: number[];
};

/** `rest` = argv after `spend add`. One call may carry several `<date> <merchant> <amount>` triples
 * and `--void <id>` (repeatable) to retire the rows being amended; a single row keeps the flag form. */
export function parseSpendAddBatch(rest: string[]): ParseResult<SpendBatchArgs> {
  const voidIds: number[] = [];
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--void") {
      const id = Number.parseInt(rest[i + 1] ?? "", 10);
      if (!Number.isFinite(id)) {
        return { ok: false, reason: "option --void needs a numeric id" };
      }
      voidIds.push(id);
      i += 1;
    } else {
      kept.push(rest[i]);
    }
  }
  const single = parseSpendAddArgs(kept);
  if (single.ok) {
    const { owner, card, ...row } = single.value;
    return { ok: true, value: { owner, card, rows: [row], voidIds } };
  }
  const parts = split(kept, ["--owner", "--card"]);
  const bad = problem(parts);
  const owner = parts.values.get("--owner");
  const card = parts.values.get("--card");
  const flat = parts.positionals;
  if (bad || !owner || !card || flat.length < 3 || flat.length % 3 !== 0) {
    return single;
  }
  const rows: SpendBatchArgs["rows"] = [];
  for (let i = 0; i < flat.length; i += 3) {
    const [spentOn, merchant, amount] = flat.slice(i, i + 3);
    if (!ISO_DATE.test(spentOn)) {
      return { ok: false, reason: `date must use YYYY-MM-DD, got "${spentOn}" (rows are <date> <merchant> <amount> triples)` };
    }
    rows.push({ spentOn, merchant, amount });
  }
  return { ok: true, value: { owner, card, rows, voidIds } };
}

const EV_VALUE_FLAGS =["--type", "--odometer", "--energy", "--site", "--cost", "--tag", "--charged-on", "--date"];

export type EvAddArgs = { chargedOn: string; values: Map<string, string>; tags: string[] };

/** `rest` = argv after `ev add`. */
export function parseEvAddArgs(rest: string[]): ParseResult<EvAddArgs> {
  const parts = split(rest, EV_VALUE_FLAGS);
  const bad = problem(parts);
  if (bad) {
    return { ok: false, reason: bad };
  }
  const chargedOn = parts.values.get("--charged-on") ?? parts.values.get("--date") ?? parts.positionals.shift();
  if (!chargedOn || !ISO_DATE.test(chargedOn)) {
    return { ok: false, reason: `date must use YYYY-MM-DD${chargedOn ? `, got "${chargedOn}"` : ""}` };
  }
  if (parts.positionals.length > 0) {
    return { ok: false, reason: `unexpected extra argument: ${parts.positionals[0]}` };
  }
  const tags: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--tag" && rest[i + 1] !== undefined) {
      tags.push(rest[i + 1]);
    }
  }
  return { ok: true, value: { chargedOn, values: parts.values, tags } };
}
