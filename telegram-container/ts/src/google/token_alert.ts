import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TelegramApi } from "../telegram/api.js";
import { titleLine } from "../telegram/title_line.js";
import { googleHome } from "./token.js";

/** One Telegram alert per window when the Google refresh token stops working, not one per failed turn. */
export const TOKEN_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const TOKEN_ALERT_FILE = "token_alert.json";

function stateFile(): string {
  return path.join(googleHome(), TOKEN_ALERT_FILE);
}

function lastSentAt(): number {
  const file = stateFile();
  if (!existsSync(file)) {
    return 0;
  }
  try {
    const at = Number((JSON.parse(readFileSync(file, "utf8")) as { sentAt?: number }).sentAt);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/**
 * Sends one Telegram alert when the Google OAuth refresh fails, then stays quiet for
 * TOKEN_ALERT_COOLDOWN_MS. Never throws: the caller is already reporting the refresh failure.
 */
export async function alertGoogleTokenRefreshFailed(now = Date.now()): Promise<boolean> {
  if (now - lastSentAt() < TOKEN_ALERT_COOLDOWN_MS) {
    return false;
  }
  const chat = process.env.MELVBOT__TRANSPORTS__TELEGRAM__CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || "";
  const token =
    process.env.MELVBOT_TS_ALLOW_LIVE_TOKEN === "1"
      ? process.env.MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN?.trim() ?? ""
      : process.env.MELVBOT__TRANSPORTS__TELEGRAM__TEST_BOT_TOKEN?.trim() ?? "";
  if (!chat || !token) {
    return false;
  }
  try {
    await new TelegramApi(token).sendMessage(
      Number(chat),
      `${titleLine("Google Token Alert", new Date(now))}\n\nGoogle sign-in expired: Calendar, Tasks, Notes and Sheets are failing. Re-run the Google login on the host.`,
    );
  } catch {
    return false;
  }
  mkdirSync(path.dirname(stateFile()), { recursive: true });
  writeFileSync(stateFile(), `${JSON.stringify({ sentAt: now })}\n`);
  return true;
}
