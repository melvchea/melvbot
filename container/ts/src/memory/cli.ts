import { backupRestoreReport } from "../cron/backup.js";
import { undoLastChange } from "./undo.js";

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const MEMORY_USAGE = "usage: melvbot memory undo | backup-diff YYYY-MM-DD\n";

export async function runMemoryCli(args: string[]): Promise<number> {
  try {
    if (args[0] === "undo") {
      writeJson(await undoLastChange());
      return 0;
    }
    if (args[0] === "backup-diff" && args[1] !== undefined) {
      writeJson(await backupRestoreReport(args[1]));
      return 0;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${detail}\n`);
    return 1;
  }
  process.stderr.write(MEMORY_USAGE);
  return 2;
}
