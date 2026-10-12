import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export const TURN_LOCK_FILENAME = "agent_turn.lock";
export const TURN_LOCK_STALE_MS = 600_000;

export function turnLockPath(): string {
  const dir = process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config";
  return path.join(dir, TURN_LOCK_FILENAME);
}

function openExclusive(file: string): number {
  return openSync(file, "wx");
}

export function tryAcquireTurnLock(): number | null {
  const file = turnLockPath();
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    return openExclusive(file);
  } catch {
    try {
      if (existsSync(file) && Date.now() - statSync(file).mtimeMs > TURN_LOCK_STALE_MS) {
        unlinkSync(file);
        return openExclusive(file);
      }
    } catch {
      return null;
    }
    return null;
  }
}

export function releaseOrphanTurnLock(): boolean {
  const file = turnLockPath();
  if (!existsSync(file)) {
    return false;
  }
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function releaseTurnLock(fd: number): void {
  closeSync(fd);
  try {
    if (existsSync(turnLockPath())) {
      unlinkSync(turnLockPath());
    }
  } catch {
    /* lock already gone */
  }
}

export async function withTurnLockExclusive<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; skipped: "turn_busy" }> {
  const fd = tryAcquireTurnLock();
  if (fd === null) {
    return { ok: false, skipped: "turn_busy" };
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseTurnLock(fd);
  }
}
