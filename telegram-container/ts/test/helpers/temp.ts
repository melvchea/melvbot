import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Module-scope fixtures are removed when the test process exits (one handler, however many dirs).
const moduleDirs: string[] = [];
let exitHookSet = false;

/** Temp dir for module-scope fixtures; removed at process exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  moduleDirs.push(dir);
  if (!exitHookSet) {
    exitHookSet = true;
    process.once("exit", () => {
      for (const d of moduleDirs) rmSync(d, { recursive: true, force: true });
    });
  }
  return dir;
}

/** Runs `fn` with a fresh temp dir, removed afterwards even when `fn` throws. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `fn` with a fresh `c.sqlite3` path in a temp dir, removed afterwards. */
export function withTempDb<T>(prefix: string, fn: (dbPath: string) => T | Promise<T>): Promise<T> {
  return withTempDir(prefix, (dir) => fn(path.join(dir, "c.sqlite3")));
}

/** A DB path in a fresh temp dir plus its cleanup, for tests that wrap the DB in try/finally. */
export function tempDbFile(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dbPath: path.join(dir, "c.sqlite3"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A DB path in a temp dir, removed at process exit; for synchronous fixtures. */
export function tempDbPath(file = "c.sqlite3"): string {
  return path.join(tempDir("melvbot-test-"), file);
}
