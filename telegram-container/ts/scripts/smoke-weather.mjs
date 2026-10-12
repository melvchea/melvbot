import { TelegramApi } from "/opt/melvbot-ts/dist/telegram/api.js";
import { handleIncoming, resolveBotToken } from "/opt/melvbot-ts/dist/daemon.js";

const token = resolveBotToken();
const me = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const body = await me.json();
if (!body.ok) {
  console.error("getMe_failed");
  process.exit(1);
}
console.log("getMe_ok username_set", Boolean(body.result?.username));

const chat = Number(
  process.env.MELVBOT__TRANSPORTS__TELEGRAM__CHAT_ID || process.env.TELEGRAM_CHAT_ID || "",
);
if (!Number.isFinite(chat) || chat === 0) {
  console.error("chat_id_missing");
  process.exit(2);
}

const api = new TelegramApi(token);
try {
  await handleIncoming(api, {
    message_id: 1,
    chat: { id: chat },
    from: { id: chat },
    text: ",weather",
  });
  console.log("weather_command_ok");
} catch (err) {
  console.error("weather_command_failed", err instanceof Error ? err.message : "error");
  process.exit(3);
} finally {
  await api.close();
}
