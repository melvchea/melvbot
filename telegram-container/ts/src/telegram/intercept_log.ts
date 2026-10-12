import { recordTurn } from "../assistant/conversation_store.js";

/**
 * One structured log line plus one `turn_log` row (route `intercept:<name>`, message text as prompt) per
 * handled non-LLM intercept or comma command, so `melvbot turns` / `dturns` show which phrasings hit.
 */
export function logIntercept(name: string, prompt = "", ms = 0): void {
  console.log("intercept", name);
  if (process.env.NODE_TEST_CONTEXT) {
    return; // never write test traffic into the real turn log
  }
  try {
    recordTurn({ chatKey: null, source: "intercept", route: `intercept:${name}`, tools: [], inputTokens: 0, outputTokens: 0, ms, status: "ok", prompt });
  } catch (error) {
    console.error("intercept log failed", error);
  }
}

/** Rejects after `ms` so a hung Google/weather/MiniMax call becomes a short user-visible error. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
