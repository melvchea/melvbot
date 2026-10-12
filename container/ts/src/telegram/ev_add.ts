import { vehicleName } from "../profile.js";
import { previewEvAdd, type SoftConfirmPreview } from "../assistant/soft_confirm.js";
import { melvbotCli } from "../assistant/tools.js";
import type { EvAddDirective } from "../sheet/ev_prose.js";
import { withTimeout } from "./intercept_log.js";

const EV_ADD_MS = 25_000;

/** Overridable seams so tests need no sheet or CLI. */
export type EvAddDeps = {
  preview?: (argv: string[]) => Promise<SoftConfirmPreview | null>;
  /** Runs `melvbot <argv>` with the chat key (so the change log and `undo` see it); returns stdout. */
  run?: (argv: string[], chatKey: string) => Promise<string>;
};

export function evAddArgv(entry: EvAddDirective): string[] {
  const argv = ["sheet", "ev", "add", entry.chargedOn, "--energy", entry.energyKwh];
  if (entry.odometerKm !== undefined) {
    argv.push("--odometer", String(entry.odometerKm));
  }
  if (entry.cost !== undefined) {
    argv.push("--cost", entry.cost);
  }
  return argv;
}

export function evEntryText(entry: EvAddDirective): string {
  const odo = entry.odometerKm === undefined ? "" : `, odo ${entry.odometerKm} km`;
  const cost = entry.cost === undefined ? "" : `, $${entry.cost}`;
  return `${entry.chargedOn}: ${entry.energyKwh} kWh${odo}${cost}`;
}

/** Previews the charge; returns the confirm text, or null when it can be written straight away. */
export async function previewEvEntry(entry: EvAddDirective, deps: EvAddDeps): Promise<string | null> {
  const preview = deps.preview ?? previewEvAdd;
  const result = await withTimeout(preview(evAddArgv(entry)), EV_ADD_MS, "ev preview");
  if (!result?.needsConfirm) {
    return null;
  }
  const why = result.summary.split("Needs confirm because:\n")[1] ?? "";
  return `Log ${vehicleName()} charge?\n- ${evEntryText(entry)}\n\nNeeds confirm because:\n${why}`.trim();
}

/** Writes through the same `sheet ev add` CLI path the agent tool uses. */
export async function writeEvEntry(entry: EvAddDirective, chatKey: string, deps: EvAddDeps): Promise<string> {
  const run = deps.run ?? (async (argv, key) => (await melvbotCli(argv, { chatKey: key })).stdout);
  const stdout = await withTimeout(run(evAddArgv(entry), chatKey), EV_ADD_MS, "ev add");
  let inserted: boolean | undefined;
  try {
    inserted = (JSON.parse(stdout) as { inserted?: boolean }).inserted;
  } catch {
    inserted = undefined;
  }
  return `${inserted === false ? "Updated existing" : "Logged"} ${vehicleName()} charge ${evEntryText(entry)}`;
}
