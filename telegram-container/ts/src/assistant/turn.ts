import { runWithSourceRef } from "../source_ref.js";
import {
  allMessages,
  append,
  clear,
  clearClaudeSession,
  getClaudeSession,
  lastClaudeTurnContextTokens,
  lastUserPromptIsIdle,
  latestEpisode,
  PROMPT_IDLE_MINUTES,
  recordTurn,
  saveEpisode,
  type NewMessage,
} from "./conversation_store.js";
import { ClaudeUnavailableError, closeLiveSession, prewarmLiveSession, runClaudeTurn, type ClaudeTurnResult, type TurnProgressUpdate } from "./claude_session.js";
import { FALLBACK_NOTICE, runFallbackTurn } from "./fallback.js";
import { wrapUntrustedImageText } from "../telegram/image_caption.js";
import { sgtNowStamp } from "./now_stamp.js";
import { recallPrefix } from "./recall.js";
import { prefetchRule, ruleTriggerSearches } from "./rule_prefetch.js";
import { buildSystemPromptFrozen } from "./system_prompt.js";
import { thinkTrigger } from "./think_trigger.js";
import { loadAssistantToml, type AssistantToml } from "./toml.js";
import { formatWebSearchResults, openWebResearchQuery, webSearch } from "./tools.js";

import type { PendingConfirmation } from "./confirm.js";

/** Recall keys already injected into each chat's current Claude session (turns resume the session, so they stay in context). */
const injectedRecall = new Map<string, { sessionId: string; keys: Set<string> }>();

export type TurnSource = "telegram" | "cron";

/** A chat whose last Claude API round held more than this many context tokens starts a fresh session (recall and notes carry the memory). */
export const RESUME_CONTEXT_TOKEN_LIMIT = 40_000;

/** turn_log recall_miss: 1 when the turn ran `note get` and no recall note body was injected this turn. */
export function recallMissFlag(cliCmds: string[] | null | undefined, recallInjected: boolean): number {
  return !recallInjected && (cliCmds ?? []).includes("note get") ? 1 : 0;
}

function auditMessage(text: string): NewMessage["contentJson"] {
  return JSON.stringify([{ type: "text", text }]);
}

function logAssistantTurn(fields: {
  chat: string | null;
  source: TurnSource;
  route: string;
  prompt: string;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  status: string;
  ttftMs?: number | null;
  spawnMs?: number | null;
  roundTrips?: number | null;
  contextTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  thinking?: boolean | null;
  thinkRule?: string | null;
  preMs?: number | null;
  toolMs?: number | null;
  toolCalls?: number | null;
  cliCmds?: string[] | null;
  recallMiss?: number | null;
  dbPath?: string;
}): void {
  try {
    recordTurn(
      {
        chatKey: fields.chat,
        source: fields.source,
        route: fields.route,
        tools: fields.tools,
        inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens,
        ms: fields.ms,
        status: fields.status,
        prompt: fields.prompt,
        ttftMs: fields.ttftMs,
        spawnMs: fields.spawnMs,
        roundTrips: fields.roundTrips,
        contextTokens: fields.contextTokens,
        cacheReadTokens: fields.cacheReadTokens,
        cacheWriteTokens: fields.cacheWriteTokens,
        thinking: fields.thinking,
        thinkRule: fields.thinkRule,
        preMs: fields.preMs,
        toolMs: fields.toolMs,
        toolCalls: fields.toolCalls,
        cliCmds: fields.cliCmds,
        recallMiss: fields.recallMiss,
      },
      fields.dbPath,
    );
  } catch (error) {
    console.error("turn_log write failed", error);
  }
  console.log(
    `assistant_turn ${JSON.stringify({
      chat: fields.chat,
      source: fields.source,
      route: fields.route,
      tools: fields.tools,
      input_tokens: fields.inputTokens,
      output_tokens: fields.outputTokens,
      ms: fields.ms,
      status: fields.status,
      ttft_ms: fields.ttftMs ?? null,
      spawn_ms: fields.spawnMs ?? null,
      round_trips: fields.roundTrips ?? null,
      context_tokens: fields.contextTokens ?? null,
      cache_read_tokens: fields.cacheReadTokens ?? null,
      cache_write_tokens: fields.cacheWriteTokens ?? null,
      pre_ms: fields.preMs ?? null,
      tool_ms: fields.toolMs ?? null,
      tool_calls: fields.toolCalls ?? null,
    })}`,
  );
}

export type RunTurnOptions = {
  chatKey: string | null;
  prompt: string;
  /** OCR text of an attached image: appended as <untrusted>, and kept out of the write guard's user message. */
  untrustedImageText?: string;
  onText?: (text: string) => void;
  onStatus?: (update: TurnProgressUpdate) => void;
  signal: AbortSignal;
  source: TurnSource;
  /** Refuse web tools this turn (prefetched cron jobs). */
  blockWeb?: boolean;
};

export type RunTurnDeps = {
  /** Test seam: replaces the real Claude Agent SDK call with a fake. */
  claudeTurn?: typeof runClaudeTurn;
  /** Test seam: replaces the degraded-mode provider call. */
  fallbackTurn?: typeof runFallbackTurn;
  assistantToml?: AssistantToml;
  systemPrompt?: string;
  dbPath?: string;
};

const EMPTY_REPLY_NOTICE = "I couldn't produce an answer — please try again.";

export type RunTurnResult = {
  text: string;
  toolNames: string[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  status: "ok" | "pending_confirmation" | "fallback" | "empty";
  pendingConfirmation?: PendingConfirmation;
};

/**
 * Runs one assistant turn: prefetches open-web research when the prompt asks
 * for it, extends (or creates) the chat's Claude agent session, persists an
 * audit-only record of the user prompt and the assistant's reply, and logs
 * one `assistant_turn` line. `chatKey: null` (cron) never persists and never
 * reuses a session — each cron turn gets a disposable one-shot agent.
 */
export async function runTurn(rawOptions: RunTurnOptions, deps: RunTurnDeps = {}): Promise<RunTurnResult> {
  const startedAt = Date.now();
  // Intercepts and media never reach here, so the trigger only sees text that becomes a Claude turn.
  const trigger = rawOptions.chatKey !== null && rawOptions.source === "telegram" ? thinkTrigger(rawOptions.prompt) : { think: false, rule: null, text: rawOptions.prompt };
  const options = trigger.text === rawOptions.prompt ? rawOptions : { ...rawOptions, prompt: trigger.text };
  const assistantToml = deps.assistantToml ?? loadAssistantToml();
  const claudeTurn = deps.claudeTurn ?? runClaudeTurn;
  const fallbackTurn = deps.fallbackTurn ?? runFallbackTurn;
  const dbPath = deps.dbPath;

  const useRecall = deps.systemPrompt === undefined && options.chatKey !== null;
  const preStarted = Date.now();
  const rulePrefetchPromise = useRecall ? prefetchRule(options.prompt) : Promise.resolve(null); // rule body + its data, so the model skips read_rule
  // A rule whose data already includes a web search replaces the generic open-research prefetch (no duplicate searches).
  const searchQuery = useRecall && ruleTriggerSearches(options.prompt) ? null : openWebResearchQuery(options.prompt);
  const systemPromise = deps.systemPrompt !== undefined ? Promise.resolve(deps.systemPrompt) : buildSystemPromptFrozen().then((built) => built.text);
  // Web prefetch, note recall, system prompt and rule prefetch are independent; run them together.
  const webPrefetchPromise = searchQuery
    ? webSearch(searchQuery, options.chatKey !== null ? "interactive" : "background").then(formatWebSearchResults, () => null) // best-effort; the model may still call web_search itself
    : Promise.resolve(null);
  // The system prompt is quick (cached); as soon as it is known the chat's SDK process can spawn while the slower pre-steps run.
  const systemEarly = await systemPromise;
  if (options.chatKey !== null && deps.claudeTurn === undefined) {
    prewarmLiveSession({
      chatKey: options.chatKey,
      model: assistantToml.model,
      reasoning: assistantToml.reasoning,
      systemPrompt: systemEarly,
      idleResetHours: assistantToml.idleResetHours,
      source: options.source,
      dbPath,
    });
  }
  const [prefetch, recall, system, rulePrefetch] = await Promise.all([
    webPrefetchPromise,
    useRecall ? recallPrefix(options.prompt, dbPath) : Promise.resolve({ text: "", key: null }),
    systemPromise,
    rulePrefetchPromise,
  ]);
  const preMs = Date.now() - preStarted;

  let userText = options.prompt;
  let untrustedPrefetchApplied = false;
  if (prefetch !== null) {
    userText = `${options.prompt}\n\n<untrusted source="web_search">\n${prefetch}\n</untrusted>`;
    untrustedPrefetchApplied = true;
  }
  if (options.untrustedImageText) {
    userText = `${userText}\n\n${wrapUntrustedImageText(options.untrustedImageText)}`;
    untrustedPrefetchApplied = true;
  }
  if (rulePrefetch !== null) {
    userText = `${userText}\n\n${rulePrefetch.block}`;
    untrustedPrefetchApplied = untrustedPrefetchApplied || rulePrefetch.block.includes("<untrusted");
  }

  if (options.chatKey !== null) {
    const session = getClaudeSession(options.chatKey, assistantToml.idleResetHours, dbPath);
    if (session && lastUserPromptIsIdle(options.chatKey, PROMPT_IDLE_MINUTES, dbPath)) {
      console.log("session.prompt_idle_reset", JSON.stringify({ chat: options.chatKey, idleMinutes: PROMPT_IDLE_MINUTES }));
      await promoteAndClear(options.chatKey, { dbPath });
    } else if (session && lastClaudeTurnContextTokens(options.chatKey, dbPath) > RESUME_CONTEXT_TOKEN_LIMIT) {
      console.log("session.token_reset", JSON.stringify({ chat: options.chatKey, limit: RESUME_CONTEXT_TOKEN_LIMIT }));
      await promoteAndClear(options.chatKey, { dbPath });
    }
  }

  let sourceRef = "cron";
  if (options.chatKey !== null) {
    const stored = append(options.chatKey, { role: "user", contentJson: auditMessage(userText) }, dbPath);
    sourceRef = `tg:${options.chatKey}:${stored.seq}`;
  }

  const priorKeys = new Set<string>();
  let priorSessionId: string | null = null;
  let injectedKey: string | null = null;
  let recallInjected = false;
  if (useRecall && options.chatKey !== null) {
    const session = getClaudeSession(options.chatKey, assistantToml.idleResetHours, dbPath);
    const known = session ? injectedRecall.get(options.chatKey) : undefined;
    if (session && known?.sessionId === session.sessionId) {
      priorSessionId = session.sessionId;
      known.keys.forEach((key) => priorKeys.add(key));
    }
    if (recall.text && !(recall.key !== null && priorKeys.has(recall.key))) {
      userText = `${recall.text}\n\n${userText}`;
      injectedKey = recall.key;
      recallInjected = true;
    }
    if (!session) {
      const episode = latestEpisode(options.chatKey, dbPath);
      if (episode) {
        userText = `<memory tier="episodic" saved="${episode.createdAt.slice(0, 10)}">\n${episode.body}\n</memory>\n\n${userText}`;
      }
    }
  }

  userText = `${sgtNowStamp(new Date())}\n${userText}`;

  let outcome: ClaudeTurnResult;
  let status: RunTurnResult["status"] = "ok";
  let route = "claude";

  const turnOptions = {
    chatKey: options.chatKey,
    model: assistantToml.model,
    reasoning: assistantToml.reasoning,
    systemPrompt: system,
    prompt: userText,
    source: options.source,
    onText: options.onText,
    onStatus: options.onStatus,
    signal: options.signal,
    idleResetHours: assistantToml.idleResetHours,
    untrustedPrefetchApplied,
    userMessage: options.prompt,
    blockWeb: options.blockWeb,
    think: trigger.think,
    dbPath,
  };
  try {
    try {
      outcome = await runWithSourceRef(sourceRef, () => claudeTurn(turnOptions));
    } catch (error) {
      // Cron turns (chatKey null) fail loudly; only live chats degrade to a read-only answer.
      if (!(error instanceof ClaudeUnavailableError) || options.chatKey === null || options.signal.aborted) {
        throw error;
      }
      console.log("assistant_turn.fallback", JSON.stringify({ chat: options.chatKey, reason: error.reason }));
      const reply = await fallbackTurn({
        systemPrompt: system,
        history: allMessages(options.chatKey, dbPath),
        prompt: userText,
        signal: options.signal,
      }).catch(() => {
        throw error;
      });
      const text = `${FALLBACK_NOTICE}\n\n${reply.text}`;
      options.onText?.(text);
      outcome = { text, toolNames: [`fallback:${reply.provider}`], inputTokens: 0, outputTokens: 0 };
      status = "fallback";
      route = `fallback:${reply.provider}`;
    }
    if (outcome.pendingConfirmation) {
      status = "pending_confirmation";
    } else if (route === "claude" && !outcome.text.trim()) {
      // Reply was empty (e.g. only a stripped pseudo <thinking> block): never send nothing.
      outcome = { ...outcome, text: EMPTY_REPLY_NOTICE };
      options.onText?.(EMPTY_REPLY_NOTICE);
      status = "empty";
    }
  } catch (error) {
    logAssistantTurn({
      chat: options.chatKey,
      source: options.source,
      route,
      prompt: options.prompt,
      dbPath,
      tools: [],
      inputTokens: 0,
      outputTokens: 0,
      ms: Date.now() - startedAt,
      status: options.signal.aborted ? "aborted" : "error",
      thinking: false,
      thinkRule: trigger.rule,
    });
    throw error;
  }

  if (useRecall && options.chatKey !== null && route === "claude") {
    rememberInjectedRecall(options.chatKey, priorSessionId, priorKeys, injectedKey, assistantToml.idleResetHours, dbPath);
  }

  if (options.chatKey !== null && outcome.text) {
    append(
      options.chatKey,
      { role: "assistant", contentJson: auditMessage(outcome.text) },
      dbPath,
    );
  }

  logAssistantTurn({
    chat: options.chatKey,
    source: options.source,
    route,
    prompt: options.prompt,
    dbPath,
    tools: [...(untrustedPrefetchApplied ? ["web_search:prefetch"] : []), ...outcome.toolNames],
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    ms: Date.now() - startedAt,
    status,
    ttftMs: outcome.ttftMs,
    spawnMs: outcome.spawnMs,
    roundTrips: outcome.roundTrips,
    contextTokens: outcome.contextTokens,
    cacheReadTokens: outcome.cacheReadTokens,
    cacheWriteTokens: outcome.cacheWriteTokens,
    thinking: outcome.thinkingRan ?? false,
    thinkRule: trigger.rule,
    preMs,
    toolMs: outcome.toolMs,
    toolCalls: outcome.toolCalls,
    cliCmds: outcome.cliCmds,
    recallMiss: recallMissFlag(outcome.cliCmds, recallInjected),
  });

  return {
    text: outcome.text,
    toolNames: outcome.toolNames,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    ms: Date.now() - startedAt,
    status,
    pendingConfirmation: outcome.pendingConfirmation,
  };
}

function rememberInjectedRecall(
  chatKey: string,
  priorSessionId: string | null,
  priorKeys: Set<string>,
  injectedKey: string | null,
  idleResetHours: number,
  dbPath: string | undefined,
): void {
  const session = getClaudeSession(chatKey, idleResetHours, dbPath);
  if (!session) {
    injectedRecall.delete(chatKey);
    return;
  }
  const keys = session.sessionId === priorSessionId ? priorKeys : new Set<string>();
  if (injectedKey !== null) {
    keys.add(injectedKey);
  }
  injectedRecall.set(chatKey, { sessionId: session.sessionId, keys });
}

/**
 * Starts a chat fresh. Saves an episodic snapshot of the audit log, then drops
 * the Claude session binding and clears that log. Used by `,new`. The idle_reset
 * cron job saves the same snapshot via endPromptIdleSessions before it clears.
 */
export async function promoteAndClear(chatKey: string, deps: Pick<RunTurnDeps, "dbPath"> = {}): Promise<void> {
  closeLiveSession(chatKey);
  saveEpisode(chatKey, allMessages(chatKey, deps.dbPath), deps.dbPath);
  clearClaudeSession(chatKey, deps.dbPath);
  clear(chatKey, deps.dbPath);
}
