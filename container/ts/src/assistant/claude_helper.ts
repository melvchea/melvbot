import { query } from "@anthropic-ai/claude-agent-sdk";

import { AGENT_CWD, subscriptionEnv } from "./claude_session.js";
import { completeWithProviders, HELPER_PROVIDERS, helperUsage, type ChatMessage, type FallbackResult } from "./fallback.js";
import { DEFAULT_MODEL } from "./toml.js";

const HELPER_TIMEOUT_MS = 90_000;

/** One tool-less Haiku turn on the subscription login; system messages become the system prompt. */
async function askClaude(messages: ChatMessage[]): Promise<string> {
  const joined = (role: (r: string) => boolean) => messages.filter((m) => role(m.role)).map((m) => m.content).join("\n\n");
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), HELPER_TIMEOUT_MS);
  try {
    const options = { model: DEFAULT_MODEL, systemPrompt: joined((r) => r === "system"), cwd: AGENT_CWD, tools: [], settingSources: [], maxTurns: 1, persistSession: false, env: subscriptionEnv(), abortController };
    for await (const message of query({ prompt: joined((r) => r !== "system"), options })) {
      if (message.type === "result") {
        if (message.subtype !== "success" || !message.result.trim()) {
          throw new Error(`claude helper ${message.subtype}`);
        }
        helperUsage.input += message.usage.input_tokens ?? 0;
        helperUsage.output += message.usage.output_tokens ?? 0;
        return message.result.trim();
      }
    }
    throw new Error("claude helper returned no result");
  } finally {
    clearTimeout(timer);
  }
}

/** Web helpers (`melvbot web`): Haiku 5.5 first, MiniMax/Groq only if Claude is unavailable. */
export async function completeWebHelper(messages: ChatMessage[], maxTokens: number): Promise<FallbackResult> {
  try {
    return { text: await askClaude(messages), provider: "claude" };
  } catch (error) {
    console.error(`web helper: claude failed (${error instanceof Error ? error.message : String(error)}), using fallback`);
    return completeWithProviders(messages, new AbortController().signal, { providers: HELPER_PROVIDERS, maxTokens });
  }
}
