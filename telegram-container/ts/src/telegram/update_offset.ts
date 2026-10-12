import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Keeps the last handled Telegram `update_id` across restarts, so
 * `getUpdates` resumes after it instead of re-delivering already-answered
 * messages after `docker restart melvbot`.
 */
export function updateOffsetPath(): string {
  const dir = process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config";
  return path.join(dir, "state", "telegram_update_offset.json");
}

export function readLastUpdateId(filePath = updateOffsetPath()): number | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { last_update_id?: unknown };
    return typeof parsed.last_update_id === "number" ? parsed.last_update_id : null;
  } catch {
    return null;
  }
}

export function writeLastUpdateId(updateId: number, filePath = updateOffsetPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ last_update_id: updateId })}\n`);
  renameSync(tmp, filePath);
}

/** The `offset` to pass to the next `getUpdates` call: one past the last handled update_id, or undefined for a fresh start. */
export function nextGetUpdatesOffset(filePath = updateOffsetPath()): number | undefined {
  const lastUpdateId = readLastUpdateId(filePath);
  return lastUpdateId === null ? undefined : lastUpdateId + 1;
}
