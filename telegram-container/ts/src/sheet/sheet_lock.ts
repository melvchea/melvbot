import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync } from "node:fs";
import path from "node:path";

export const SHEET_LOCK_STALE_MS = 120_000;
const SHEET_LOCK_REFRESH_MS = 30_000;

function lockDir(): string {
  if (process.env.MELVBOT_CONFIG_DIR) {
    return path.join(process.env.MELVBOT_CONFIG_DIR, "sheet_locks");
  }
  const toml =
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml");
  return path.join(path.dirname(toml), "sheet_locks");
}

function lockPath(spreadsheetId: string): string {
  const safe = spreadsheetId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(lockDir(), `${safe}.lock`);
}

function openExclusive(file: string): number {
  return openSync(file, "wx");
}

function tryAcquire(spreadsheetId: string): number | null {
  const file = lockPath(spreadsheetId);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    return openExclusive(file);
  } catch {
    try {
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs > SHEET_LOCK_STALE_MS) {
        unlinkSync(file);
        const fd = openExclusive(file);
        process.stderr.write(`sheet lock stolen after ${SHEET_LOCK_STALE_MS}ms: ${spreadsheetId}\n`);
        return fd;
      }
    } catch {
      return null;
    }
    return null;
  }
}

function release(fd: number, spreadsheetId: string): void {
  closeSync(fd);
  try {
    const file = lockPath(spreadsheetId);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  } catch {
    /* lock already gone */
  }
}

/** Serializes writes to one spreadsheet; stale locks expire after SHEET_LOCK_STALE_MS. */
export async function withSheetWriteLock<T>(spreadsheetId: string, fn: () => Promise<T>): Promise<T> {
  const fd = tryAcquire(spreadsheetId);
  if (fd === null) {
    throw new Error(`sheet write busy: ${spreadsheetId}`);
  }
  const file = lockPath(spreadsheetId);
  const refresh = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      /* lock already gone */
    }
  }, SHEET_LOCK_REFRESH_MS);
  refresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    release(fd, spreadsheetId);
  }
}
