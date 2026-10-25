import { groqKey, minimaxKey } from "../media/services.js";
import type { StoredMessage } from "./conversation_store.js";

/**
 * Degraded mode for when Claude is unavailable (usage limit, expired login, overload):
 * a tool-less, read-only answer from a cheap provider so the chat is not dead.
 * Groq first (fast), MiniMax second. Nothing here can write, call tools or confirm.
 */
export const FALLBACK_NOTICE =
  "⚠️ Claude is unavailable right now (usage limit or login) — answering in read-only fallback mode. Nothing was saved or changed.";
const HISTORY_MESSAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
/** Groq normally answers in a few seconds; a short timeout means a hung Groq falls over to MiniMax fast. */
const GROQ_TIMEOUT_MS = 10_000;
const MAX_TOKENS = 700;

const DEGRADED_RULES = `<degraded-mode>
Claude is unavailable, so you are a temporary read-only assistant. You have no tools and cannot save, log, edit, delete, schedule or confirm anything.
Answer only from the notes index, house rules, about-me and memory in this prompt, and from the conversation so far. If something is not there, say you cannot look it up right now.
If the user asks for an action (log spend, write or change a note, cron, calendar, tasks), say it is paused until the main assistant is back and that nothing was done. Never claim you did an action.
Keep replies short.
</degraded-mode>`;
/** MiniMax typically times out waiting for token limits; fast fallback to Groq when it hangs. */
const MINIMAX_TIMEOUT_MS = 20_000;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type Provider = { name: string; url: string; model: string; key: () => string; extra?: Record<string, unknown>; timeoutMs?: number };

const GROQ_PROVIDER: Provider = {
  name: "groq",
  url: "https://api.groq.com/openai/v1/chat/completions",
  model: "qwen/qwen3.8-27b",
  key: groqKey,
  timeoutMs: GROQ_TIMEOUT_MS,
};

const MINIMAX_PROVIDER: Provider = {
  name: "minimax",
  url: "https://api.minimax.io/v1/chat/completions",
  model: "MiniMax-M3",
  key: minimaxKey,
  extra: { thinking: { type: "disabled" } },
  timeoutMs: MINIMAX_TIMEOUT_MS,
};

export const FALLBACK_PROVIDERS: Provider[] = [GROQ_PROVIDER, MINIMAX_PROVIDER];

export type FallbackResult = { text: string; provider: string };

function storedText(message: StoredMessage): string {
  try {
    const blocks = JSON.parse(message.contentJson) as { type?: string; text?: string }[];
    return blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
  } catch {
    return "";
  }
}

/** Recent turns as plain chat messages. `history` ends with the user message being answered, which is dropped. */
export function historyForFallback(history: readonly StoredMessage[]): ChatMessage[] {
  const prior = history.slice(0, -1).slice(-HISTORY_MESSAGES);
  const messages: ChatMessage[] = [];
  for (const message of prior) {
    const content = storedText(message);
    if (content && (message.role === "user" || message.role === "assistant")) {
      messages.push({ role: message.role, content });
    }
  }
  return messages;
}

function clean(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function askProvider(provider: Provider, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const key = provider.key();
  if (!key) {
    throw new Error(`${provider.name} key missing`);
  }
  const response = await fetch(provider.url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model, messages, max_tokens: MAX_TOKENS, ...provider.extra }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(provider.timeoutMs ?? REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    throw new Error(`${provider.name} HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const text = clean(payload.choices?.[0]?.message?.content ?? "");
  if (!text) {
    throw new Error(`${provider.name} returned no text`);
  }
  return text;
}

/** Tries the given providers in order until one answers (default FALLBACK_PROVIDERS: Groq, then MiniMax). Throws only if all fail. */
export async function completeWithProviders(
  messages: ChatMessage[],
  signal: AbortSignal,
  options: { providers?: Provider[] } = {},
): Promise<FallbackResult> {
  const failures: string[] = [];
  for (const provider of options.providers ?? FALLBACK_PROVIDERS) {
    try {
      return { text: await askProvider(provider, messages, signal), provider: provider.name };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`fallback failed: ${failures.join("; ")}`);
}

export type FallbackTurnOptions = {
  systemPrompt: string;
  history: readonly StoredMessage[];
  prompt: string;
  signal: AbortSignal;
  providers?: Provider[];
};

/** Tries each provider in order; throws only if all fail. */
export async function runFallbackTurn(options: FallbackTurnOptions): Promise<FallbackResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: `${options.systemPrompt}\n\n${DEGRADED_RULES}` },
    ...historyForFallback(options.history),
    { role: "user", content: options.prompt },
  ];
  return completeWithProviders(messages, options.signal, { providers: options.providers });
}
