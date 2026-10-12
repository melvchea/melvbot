/**
 * Prose intercepts answer without a Claude turn, so the session transcript never sees them and a follow-up
 * ("do that again", "why?") would lose context. Keep the last few exchanges per chat and hand them to the next
 * Claude turn inside its user message (the system prompt stays byte-stable).
 */
import type { TelegramApi } from "./api.js";

const MAX_PAIRS = 3;
const CLIP_CHARS = 300;

const pending = new Map<string, Array<{ user: string; reply: string }>>();

function clip(text: string): string {
  const flat = text.trim();
  return flat.length > CLIP_CHARS ? `${flat.slice(0, CLIP_CHARS)}…` : flat;
}

export function recordInterceptExchange(chatKey: string, user: string, replies: string[]): void {
  const list = pending.get(chatKey) ?? [];
  list.push({ user: clip(user), reply: clip(replies.join("\n")) });
  pending.set(chatKey, list.slice(-MAX_PAIRS));
}

/** The recorded exchanges as a block for the next Claude turn, then forgotten; "" when none. */
export function takeInterceptContext(chatKey: string | null): string {
  const list = chatKey === null ? undefined : pending.get(chatKey);
  if (chatKey === null || !list?.length) {
    return "";
  }
  pending.delete(chatKey);
  const lines = list.map((pair) => `User: ${pair.user}\nBot (instant reply): ${pair.reply}`);
  return `<instant_replies note="answered by the bot without Claude, before this message">\n${lines.join("\n\n")}\n</instant_replies>`;
}

/** An api that also copies every sendMessage text into `sink`. */
export function recordingApi(api: TelegramApi, sink: string[]): TelegramApi {
  return new Proxy(api, {
    get(target, prop, receiver) {
      if (prop === "sendMessage") {
        return (chatId: number, text: string, extra?: Record<string, unknown>) => {
          sink.push(text);
          return target.sendMessage(chatId, text, extra);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
