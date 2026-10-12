import { TelegramApi } from "./api.js";
import { titleLine } from "./title_line.js";

/** `melvbot notify <Title> [body...]`: one code-rendered message to the owner chat; for host scripts that hold no token. */
export async function runNotifyCli(args: string[], now = new Date()): Promise<number> {
  const [title, ...body] = args;
  const chat = process.env.MELVBOT__TRANSPORTS__TELEGRAM__CHAT_ID?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || "";
  const token =
    process.env.MELVBOT_TS_ALLOW_LIVE_TOKEN === "1"
      ? process.env.MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN?.trim() ?? ""
      : process.env.MELVBOT__TRANSPORTS__TELEGRAM__TEST_BOT_TOKEN?.trim() ?? "";
  if (!title || !chat || !token) {
    console.error("usage: melvbot notify <Title> [body...] (needs chat id and bot token in env)");
    return 2;
  }
  const text = [titleLine(title, now), ...(body.length ? ["", body.join(" ")] : [])].join("\n");
  try {
    await new TelegramApi(token).sendMessage(Number(chat), text);
    return 0;
  } catch (err) {
    console.error(`notify failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
