import { cardLabel, vehicleName } from "../profile.js";
import { EV_ADD_USAGE, SPEND_ADD_USAGE, parseEvAddArgs, parseSpendAddBatch } from "./add_args.js";
import { applySheetRename, type SheetName } from "./sheet_prose.js";
import { listSpend, listSpendAll } from "./spend_list.js";
import { readSheetRules } from "./rules.js";
import { upsertSpend, voidSpend } from "./spend_write.js";
import { listEv } from "./ev_list.js";
import { upsertEv, voidEv } from "./ev_write.js";
import { assertDriveFileNotTrashed } from "../note/notes_google.js";
import { SHEETS_TABLE, rewriteSheetTomlKey } from "./toml_rewrite.js";
import { SHEET_CREATE_USAGE, createFreeFormSheet, parseSheetCreateArgs } from "./create.js";
import { deleteSheetRule, setSheetRule, type SheetKey } from "./rules_write.js";

const SHEET_USAGE =
  "usage: melvbot sheet rules [set|delete] | spend add|list|void | ev add|list|void | pin | rename <owner1|owner2|ev> <new title...> | create <title...> [--note <slug>] [--tab <name>:<cols>]\n";
const RULES_SET_USAGE =
  "usage: melvbot sheet rules set <owner1|owner2|ev> <key> <value>  (one key, one short value)\n";
const SPEND_LIST_USAGE =
  "usage: melvbot sheet spend list --owner <owner1|owner2> --card <card1|card2> [YYYY-MM-DD | --all]\n";
const SPEND_VOID_USAGE = "usage: melvbot sheet spend void <id> [<id>...]\n";
const SHEET_KEYS = new Set<SheetKey>(["owner1", "owner2", "ev"]);

function asSheetKey(value: string | undefined): SheetKey | null {
  return value !== undefined && (SHEET_KEYS as Set<string>).has(value) ? (value as SheetKey) : null;
}

export const SHEET_PIN_KEYS: Record<string, string> = {
  owner1: "owner1_spreadsheet_id",
  owner2: "owner2_spreadsheet_id",
  ev: "ev_spreadsheet_id",
};

/** One line per Sheet for the assistant's system-prompt recall index. */
export function sheetDescriptions(): Record<string, string> {
  return {
    owner1: `${cardLabel("owner1", "card1")} card spend`,
    owner2: `${cardLabel("owner2", "card2")} card spend`,
    ev: `${vehicleName()} M6 charges`,
  };
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function flags(args: string[], name: string): string[] {
  const values: string[] = [];
  for (const [index, part] of args.entries()) {
    if (part === name && args[index + 1] !== undefined) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function optionNames(names: string[]): Set<string> {
  return new Set(names);
}

function positionals(args: string[], names: string[]): string[] {
  const named = optionNames(names);
  return args.filter((part, index) => {
    const prev = args[index - 1];
    if (named.has(part)) {
      return false;
    }
    if (prev !== undefined && named.has(prev)) {
      return false;
    }
    return true;
  });
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(text = SHEET_USAGE): number {
  process.stderr.write(text);
  return 2;
}

export async function runSheetCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "rules" && args[1] === "set") {
      const sheet = asSheetKey(args[2]);
      const key = args[3];
      const value = args[4];
      if (!sheet || !key || value === undefined) {
        return usage(RULES_SET_USAGE);
      }
      writeJson(await setSheetRule(sheet, key, value));
      return 0;
    }
    if (args[0] === "rules" && args[1] === "delete") {
      const sheet = asSheetKey(args[2]);
      const key = args[3];
      if (!sheet || !key) {
        return usage();
      }
      writeJson(await deleteSheetRule(sheet, key));
      return 0;
    }
    if (args[0] === "rules") {
      writeJson(await readSheetRules());
      return 0;
    }
    if (args[0] === "spend" && args[1] === "add") {
      const parsed = parseSpendAddBatch(args.slice(2));
      if (!parsed.ok) {
        return usage(`error: ${parsed.reason}\n${SPEND_ADD_USAGE}`);
      }
      const { owner, card, rows, voidIds } = parsed.value;
      for (const id of voidIds) {
        await voidSpend(id);
      }
      const added = [];
      for (const row of rows) {
        added.push(await upsertSpend({ owner, card, ...row }));
      }
      writeJson(rows.length === 1 && voidIds.length === 0 ? added[0] : { voided: voidIds, added });
      return 0;
    }
    if (args[0] === "spend" && args[1] === "list") {
      const rest = args.slice(2);
      const owner = flag(rest, "--owner");
      const card = flag(rest, "--card");
      const cycleDate = rest.find((part) => /^\d{4}-\d{2}-\d{2}$/.test(part)) ?? todayIso();
      if (!owner || !card) {
        return usage(SPEND_LIST_USAGE);
      }
      if (rest.includes("--all")) {
        writeJson(await listSpendAll({ owner, card }));
        return 0;
      }
      writeJson(await listSpend({ owner, card, cycleDate }));
      return 0;
    }
    if (args[0] === "spend" && args[1] === "void") {
      // Claude sometimes writes "void --id 104"; accept it rather than fail the confirmed turn.
      const ids = (args[2] === "--id" ? args.slice(3) : args.slice(2)).map((part) => Number.parseInt(part, 10));
      if (ids.length === 0 || ids.some((id) => !Number.isFinite(id))) {
        return usage(SPEND_VOID_USAGE);
      }
      for (const id of ids) {
        await voidSpend(id);
      }
      writeJson(ids.length === 1 ? { voided: true, id: ids[0] } : { voided: true, ids });
      return 0;
    }
    if (args[0] === "ev" && args[1] === "list") {
      writeJson(await listEv());
      return 0;
    }
    if (args[0] === "ev" && args[1] === "add") {
      const rest = args.slice(2);
      const parsed = parseEvAddArgs(rest);
      if (!parsed.ok) {
        return usage(`error: ${parsed.reason}\n${EV_ADD_USAGE}`);
      }
      const { chargedOn, values, tags } = parsed.value;
      const odometerRaw = values.get("--odometer");
      const odometerKm = odometerRaw === undefined ? undefined : Number.parseInt(odometerRaw, 10);
      if (odometerRaw !== undefined && !Number.isFinite(odometerKm)) {
        throw new Error("odometer must be an integer");
      }
      writeJson(
        await upsertEv({
          chargeType: values.get("--type") ?? "full",
          chargedOn,
          odometerKm,
          energyKwh: values.get("--energy"),
          site: values.get("--site"),
          cost: values.get("--cost"),
          tags,
        }),
      );
      return 0;
    }
    if (args[0] === "ev" && args[1] === "void") {
      const entryId = Number.parseInt(String(args[2] ?? ""), 10);
      if (!Number.isFinite(entryId)) {
        return usage();
      }
      await voidEv(entryId);
      writeJson({ voided: true, id: entryId });
      return 0;
    }
    if (args[0] === "create") {
      const request = parseSheetCreateArgs(args.slice(1));
      if (!request) {
        return usage(SHEET_CREATE_USAGE);
      }
      writeJson(await createFreeFormSheet(request));
      return 0;
    }
    if (args[0] === "rename") {
      const [name, ...titleWords] = args.slice(1);
      const title = titleWords.join(" ").trim();
      if (!name || !title || !["owner1", "owner2", "ev"].includes(name)) {
        return usage();
      }
      const result = await applySheetRename(name as SheetName, title);
      if (!result.ok) {
        throw new Error(result.message);
      }
      writeJson({ renamed: true, sheet: result.sheet, title: result.title });
      return 0;
    }
    if (args[0] === "pin") {
      const rest = args.slice(1);
      const [name] = positionals(rest, ["--spreadsheet-id"]);
      const spreadsheetId = flag(rest, "--spreadsheet-id");
      const key = name ? SHEET_PIN_KEYS[name] : undefined;
      if (!name || !spreadsheetId || !key) {
        return usage();
      }
      await assertDriveFileNotTrashed(spreadsheetId, "spreadsheet");
      rewriteSheetTomlKey({ table: SHEETS_TABLE, key, value: spreadsheetId });
      writeJson({ pinned: true, name, spreadsheet_id: spreadsheetId });
      return 0;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${detail}\n`);
    return 1;
  }
  return usage();
}
