import { existsSync, statSync } from "node:fs";

import { createFinalAnswerTracker, stripThinking } from "./final_answer.js";
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { PendingConfirmation } from "./confirm.js";
import {
  activeClaudeSessions,
  allMessages,
  chatsWithRecentUserPrompt,
  clear,
  clearClaudeSession,
  getClaudeSession,
  PROMPT_IDLE_MINUTES,
  saveClaudeSession,
  saveEpisode,
} from "./conversation_store.js";
import { buildMelvbotMcpServer, MCP_SERVER_NAME, MCP_TOOL_NAMES, newMcpTurnState, type McpTurnState, type TurnSource } from "./custom_tools.js";
import { DEFAULT_MODEL, type Reasoning } from "./toml.js";
import { TURN_LOCK_STALE_MS, turnLockPath } from "../session/turn_lock.js";

/** How often to drop sessions whose last user prompt is past PROMPT_IDLE_MINUTES. */
const PROMPT_IDLE_CHECK_MS = 60_000;
/** Safety cap on model round-trips inside one Telegram turn. */
const MAX_TURNS = 20;
import { THINK_BUDGET_TOKENS } from "./think_trigger.js";

/** `think:` / complex-prose turns run at this effort; the session effort comes from `reasoning`. */
const THINK_EFFORT = "medium" as const;
/** No SDK message for this long (and no tool running) means the turn is hung; the CLI streams deltas, so real work never goes this quiet. */
export const STALL_TIMEOUT_MS = 60_000;
/** Same, while a tool call is in flight (CLI tools and web fetches can legitimately be silent for a while). */
export const TOOL_STALL_TIMEOUT_MS = 240_000;
/** After an abort, how long to wait for the interrupted turn's result before killing the live process. */
const INTERRUPT_GRACE_MS = 5_000;
/** A live process is recycled after this many API round-trips so its cumulative turn count never nears MAX_TURNS. */
const LIVE_MAX_ROUND_TRIPS = 12;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The melvbot repo bind mount inside the container. The agent has no file tools, so this is only its process cwd. */
export const AGENT_CWD = existsSync("/workspace") ? "/workspace" : process.cwd();

/**
 * Auth is the Claude subscription login only (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`,
 * or `~/.claude/.credentials.json`). API-key variables are removed so the CLI can never bill the API.
 * Fast mode is disabled via CLAUDE_CODE_DISABLE_FAST_MODE.
 */
function subscriptionEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_DISABLE_FAST_MODE = "1";
  return env;
}

/** Claude cannot serve turns right now (limit, auth, overload). Callers may fall back to a degraded mode. */
export class ClaudeUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "ClaudeUnavailableError";
  }
}

const UNAVAILABLE_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "rate_limit",
  "overloaded",
  "cloud_credential_error",
]);
const UNAVAILABLE_TEXT = /usage limit|hit your limit|rate.?limit|overloaded|oauth token|please run \/login|invalid api key|credit balance|out of credits/i;
/** After an unavailable error, skip Claude (and its ~2s failing spawn) for this long, then probe again. */
export const UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
let unavailableUntil = 0;

export function claudeUnavailable(now = Date.now()): boolean {
  return now < unavailableUntil;
}

export function resetClaudeBackoff(): void {
  unavailableUntil = 0;
}

export function markClaudeUnavailable(reason: string, resetsAtSec?: number): ClaudeUnavailableError {
  const resetMs = resetsAtSec ? resetsAtSec * 1000 : Infinity;
  unavailableUntil = Math.min(Date.now() + UNAVAILABLE_BACKOFF_MS, resetMs);
  return new ClaudeUnavailableError(`claude unavailable: ${reason}`, reason);
}

let promptIdleTimer: ReturnType<typeof setInterval> | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;

function turnInProgress(): boolean {
  const file = turnLockPath();
  if (!existsSync(file)) {
    return false;
  }
  try {
    return Date.now() - statSync(file).mtimeMs <= TURN_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Drops session bindings whose last user prompt is at least PROMPT_IDLE_MINUTES ago,
 * saving an episodic snapshot first. Skips the sweep while a turn holds the lock.
 */
export async function endPromptIdleSessions(): Promise<number> {
  if (turnInProgress()) {
    return 0;
  }
  const recent = new Set(chatsWithRecentUserPrompt(PROMPT_IDLE_MINUTES));
  const stale = activeClaudeSessions(Number.POSITIVE_INFINITY)
    .map((session) => session.chatKey)
    .filter((chatKey) => !recent.has(chatKey));
  for (const chatKey of stale) {
    saveEpisode(chatKey, allMessages(chatKey));
    closeLiveSession(chatKey);
    clearClaudeSession(chatKey);
    clear(chatKey);
  }
  if (stale.length > 0) {
    console.log("session.prompt_idle_end", JSON.stringify({ ended: stale.length, idleMinutes: PROMPT_IDLE_MINUTES }));
  }
  return stale.length;
}

/** Starts the idle-session sweep. Safe to call once at daemon startup. */
export function startSessionIdleSweep(): void {
  if (promptIdleTimer) {
    return;
  }
  void endPromptIdleSessions();
  promptIdleTimer = setInterval(() => {
    void endPromptIdleSessions();
  }, PROMPT_IDLE_CHECK_MS);
  promptIdleTimer.unref();
}

export function stopSessionIdleSweep(): void {
  closeAllLiveSessions();
  if (promptIdleTimer) {
    clearInterval(promptIdleTimer);
    promptIdleTimer = undefined;
  }
}

export type ClaudeTurnOptions = {
  chatKey: string | null;
  /** Claude model id, e.g. `claude-haiku-4-5`. */
  model: string;
  reasoning: Reasoning;
  systemPrompt: string;
  prompt: string;
  source: TurnSource;
  /** Called with the growing text of the current model round (replace, not append); a new round restarts it. */
  onText?: (text: string) => void;
  onStatus?: (update: TurnProgressUpdate) => void;
  signal: AbortSignal;
  idleResetHours: number;
  untrustedPrefetchApplied: boolean;
  blockWeb?: boolean;
  /** The user's own words, for the write guard; defaults to `prompt` (which may carry prefetched blocks). */
  userMessage?: string;
  /** Medium thinking (4096 tokens) for this turn only; the live process is switched back to disabled afterwards. */
  think?: boolean;
  dbPath?: string;
};

export type TurnProgressUpdate =
  | { kind: "thinking" }
  | { kind: "tool_running"; name: string; args?: unknown }
  | { kind: "tool_completed"; name: string; args?: unknown };

export type ClaudeTurnResult = {
  text: string;
  toolNames: string[];
  inputTokens: number;
  outputTokens: number;
  pendingConfirmation?: PendingConfirmation;
  /** A thinking block was streamed this turn. */
  thinkingRan?: boolean;
  /** Prompt sent to first streamed text delta. */
  ttftMs?: number;
  /** Query start to first SDK message; 0 when a live process was reused. */
  spawnMs?: number;
  /** Assistant API messages in the turn. */
  roundTrips?: number;
  /** Context size of the turn's last API round (input + cache read + cache creation tokens). */
  contextTokens?: number;
  /** Turn totals of cache-read and cache-creation input tokens (subset of inputTokens). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Summed MCP tool handler wall time and call count for the turn. */
  toolMs?: number;
  toolCalls?: number;
  /** melvbot_cli subcommands called in the turn, in order. */
  cliCmds?: string[];
};

type BlockLike = { type: string; [key: string]: unknown };

function shortToolName(name: string): string {
  const prefix = `mcp__${MCP_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Test seam: replaces the SDK `query()`. */
let queryImpl: typeof query = query;
export function setQueryImplForTests(fn: typeof query | null): void {
  queryImpl = fn ?? query;
}

/** Minimal push-based async iterable feeding the SDK's streaming input mode. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  private done = false;

  push(message: SDKUserMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
    } else {
      this.items.push(message);
    }
  }

  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * One long-lived SDK process per chat (streaming input mode). Consecutive turns push a user message
 * into the same `query()` instead of spawning a CLI + MCP server + session resume each time.
 * The in-process MCP server reads `turnState` through a getter, so each turn swaps in its own.
 */
type LiveSession = {
  chatKey: string;
  /** Model, reasoning and system prompt are fixed at spawn; any change respawns (with resume). */
  configKey: string;
  q: Query;
  iterator: AsyncIterator<SDKMessage>;
  input: InputQueue;
  turnState: McpTurnState;
  sessionId: string | undefined;
  roundTrips: number;
  busy: boolean;
};

const liveSessions = new Map<string, LiveSession>();

function disposeLive(live: LiveSession): void {
  if (liveSessions.get(live.chatKey) === live) {
    liveSessions.delete(live.chatKey);
  }
  live.input.end();
  try {
    live.q.close();
  } catch {
    /* already gone */
  }
}

/** Closes a chat's live SDK process (session end, `,new`, idle sweep). No-op when there is none. */
export function closeLiveSession(chatKey: string): void {
  const live = liveSessions.get(chatKey);
  if (live) {
    disposeLive(live);
  }
}

export function closeAllLiveSessions(): void {
  for (const live of [...liveSessions.values()]) {
    disposeLive(live);
  }
}

/** Number of chats with a live SDK process (tests, diagnostics). */
export function liveSessionCount(): number {
  return liveSessions.size;
}

class StallError extends Error {
  constructor(ms: number) {
    super(`claude stalled: no output for ${Math.round(ms / 1000)}s`);
    this.name = "StallError";
  }
}

function userMessage(prompt: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
}

type LaunchInputs = Pick<ClaudeTurnOptions, "chatKey" | "model" | "reasoning" | "systemPrompt" | "idleResetHours" | "dbPath">;

/** Everything that decides which SDK process a turn needs (stored session, model, system prompt); known before any pre-step finishes. */
function launchInputs(options: LaunchInputs) {
  const stored =
    options.chatKey !== null ? getClaudeSession(options.chatKey, options.idleResetHours, options.dbPath) : null;
  const resumeId = stored && SESSION_ID.test(stored.sessionId) ? stored.sessionId : undefined;
  const persist = options.chatKey !== null;
  // A leftover non-Claude id (e.g. `composer-2.5`) in melvbot.toml falls back to the default.
  const model = options.model.startsWith("claude-") ? options.model : DEFAULT_MODEL;
  const configKey = JSON.stringify([model, options.reasoning, options.systemPrompt]);
  const baseOptions: Options = {
    model,
    systemPrompt: options.systemPrompt,
    cwd: AGENT_CWD,
    tools: [],
    allowedTools: MCP_TOOL_NAMES,
    permissionMode: "dontAsk",
    settingSources: [],
    maxTurns: MAX_TURNS,
    thinking:
      options.reasoning === "off"
        ? { type: "disabled" }
        : { type: "adaptive" },
    ...(options.reasoning === "off" ? {} : { effort: options.reasoning }),
    persistSession: persist,
    includePartialMessages: true,
    env: subscriptionEnv(),
  };
  return { resumeId, persist, configKey, baseOptions };
}

/** The chat's reusable live process, or a freshly spawned one (a stale or mismatched one is disposed). */
function acquireLive(
  chatKey: string,
  configKey: string,
  resumeId: string | undefined,
  baseOptions: Options,
  turnState: McpTurnState,
): { live: LiveSession; reused: boolean } {
  const existing = liveSessions.get(chatKey);
  if (existing && !existing.busy) {
    if (existing.configKey === configKey && existing.sessionId === resumeId && existing.roundTrips < LIVE_MAX_ROUND_TRIPS) {
      return { live: existing, reused: true };
    }
    disposeLive(existing);
  }
  const input = new InputQueue();
  const created: LiveSession = {
    chatKey,
    configKey,
    q: undefined as unknown as Query,
    iterator: undefined as unknown as AsyncIterator<SDKMessage>,
    input,
    turnState,
    sessionId: resumeId,
    roundTrips: 0,
    busy: false,
  };
  created.q = queryImpl({
    prompt: input,
    options: {
      ...baseOptions,
      mcpServers: { [MCP_SERVER_NAME]: buildMelvbotMcpServer(() => created.turnState) },
      abortController: new AbortController(),
      ...(resumeId ? { resume: resumeId } : {}),
    },
  });
  created.iterator = created.q[Symbol.asyncIterator]();
  liveSessions.set(chatKey, created);
  return { live: created, reused: false };
}

/**
 * Spawns (or confirms) the chat's live SDK process before the turn's slower pre-steps finish, so a cold
 * spawn overlaps web prefetch / recall. Best-effort: the turn re-validates and respawns on any mismatch.
 */
export function prewarmLiveSession(options: LaunchInputs & { source: TurnSource }): void {
  if (options.chatKey === null || claudeUnavailable()) {
    return;
  }
  try {
    if (liveSessions.get(options.chatKey)?.busy) {
      return;
    }
    const { resumeId, configKey, baseOptions } = launchInputs(options);
    acquireLive(options.chatKey, configKey, resumeId, baseOptions, newMcpTurnState(options.source, options.chatKey, "", false));
  } catch (error) {
    console.log("claude_session.prewarm_failed", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs one turn as a Claude Agent SDK `query()`. A chat's session is continued
 * with `resume: <session id>` (the transcript lives under `~/.claude`, which is
 * on the container's persistent HOME volume), so the session transcript *is*
 * the conversation window. A chat's SDK process is kept alive between turns
 * (see LiveSession); if it dies the turn is retried once on a fresh process
 * with resume. `chatKey: null` (cron) never persists, resumes or stays alive.
 *
 * The built-in toolset is empty and only the in-process melvbot MCP tools are
 * allowed, so the model has no shell, file, or native web access.
 *
 * Throws on any run failure or cancellation; callers distinguish
 * `options.signal.aborted` from a genuine failure.
 */
export async function runClaudeTurn(options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  if (claudeUnavailable()) {
    throw new ClaudeUnavailableError("claude unavailable: backing off after a recent limit/auth error", "backoff");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runClaudeTurnOnce(options);
    } catch (error) {
      const retriable = error instanceof RetryableTurnError && attempt === 0 && !options.signal.aborted;
      if (!retriable) {
        throw error instanceof RetryableTurnError ? error.cause : error;
      }
      console.log("claude_session.retry_fresh", JSON.stringify({ reason: error.message }));
    }
  }
}

/** A failure before any output that a fresh process (with resume) may not repeat: dead live process, stall. */
class RetryableTurnError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

async function runClaudeTurnOnce(options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  if (options.signal.aborted) {
    throw new Error("claude agent run was cancelled");
  }
  const turnState = newMcpTurnState(options.source, options.chatKey, options.userMessage ?? options.prompt, options.untrustedPrefetchApplied, options.blockWeb);
  const { resumeId, persist, configKey, baseOptions } = launchInputs(options);

  // Pick the process: reuse the chat's live one, spawn a new live one, or (cron / chat busy) a one-shot.
  let live: LiveSession | undefined;
  let thinkingSwitched: LiveSession | undefined;
  let thinkingRan = false;
  let reused = false;
  let oneShot: Query | undefined;
  let iterator: AsyncIterator<SDKMessage>;
  let interrupt: () => void;
  let kill: () => void;
  const spawnStart = Date.now();
  const existing = options.chatKey !== null ? liveSessions.get(options.chatKey) : undefined;
  const abortController = new AbortController();
  if (options.chatKey !== null && !existing?.busy) {
    const acquired = acquireLive(options.chatKey, configKey, resumeId, baseOptions, turnState);
    live = acquired.live;
    reused = acquired.reused;
    live.turnState = turnState;
    live.busy = true;
    if (options.think) {
      // Raise effort for this turn (or, with reasoning off, enable a thinking budget); the finally restores the session setting.
      if (options.reasoning === "off") {
        await live.q.setMaxThinkingTokens(THINK_BUDGET_TOKENS);
      } else {
        await live.q.applyFlagSettings({ effortLevel: THINK_EFFORT });
      }
      thinkingSwitched = live;
    }
    live.input.push(userMessage(options.prompt));
    iterator = live.iterator;
    const handle = live;
    interrupt = () => void handle.q.interrupt().catch(() => undefined);
    kill = () => disposeLive(handle);
  } else {
    oneShot = queryImpl({
      prompt: options.prompt,
      options: {
        ...baseOptions,
        ...(options.think
          ? options.reasoning === "off"
            ? { thinking: { type: "enabled" as const, budgetTokens: THINK_BUDGET_TOKENS } }
            : { effort: THINK_EFFORT }
          : {}),
        mcpServers: { [MCP_SERVER_NAME]: buildMelvbotMcpServer(turnState) },
        abortController,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });
    iterator = oneShot[Symbol.asyncIterator]();
    interrupt = () => abortController.abort();
    kill = () => {
      abortController.abort();
      try {
        oneShot?.close();
      } catch {
        /* already gone */
      }
    };
  }
  const sentAt = Date.now();

  let text = "";
  const finalAnswer = createFinalAnswerTracker();
  let roundText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = resumeId;
  let roundTrips = 0;
  let contextTokens: number | undefined;
  let ttftMs: number | undefined;
  let spawnMs: number | undefined;
  const toolNames = new Set<string>();
  const toolsInFlight = new Map<string, { name: string; args: unknown }>();
  let assistantError: string | undefined;
  let rejectedResetsAt: number | undefined;
  let limitRejected = false;
  let gotResult = false;

  // Abort: a live process is interrupted (and stays reusable); a one-shot is killed.
  let abortHandled = false;
  let onAbortWake: () => void = () => undefined;
  const abortSignalled = new Promise<"abort">((resolve) => {
    onAbortWake = () => resolve("abort");
  });
  options.signal.addEventListener("abort", onAbortWake);
  if (options.signal.aborted) {
    onAbortWake();
  }

  let pending: Promise<IteratorResult<SDKMessage>> | null = null;
  const pull = async (): Promise<IteratorResult<SDKMessage>> => {
    for (;;) {
      pending ??= iterator.next();
      const limitMs = abortHandled ? INTERRUPT_GRACE_MS : toolsInFlight.size > 0 ? TOOL_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
      let timer: NodeJS.Timeout | undefined;
      const stalled = new Promise<"stall">((resolve) => {
        timer = setTimeout(() => resolve("stall"), limitMs);
      });
      const raced = await Promise.race([
        pending.then((result) => ({ result })),
        stalled,
        ...(abortHandled ? [] : [abortSignalled]),
      ]).finally(() => clearTimeout(timer));
      if (typeof raced === "object") {
        pending = null;
        return raced.result;
      }
      if (raced === "abort") {
        abortHandled = true;
        interrupt();
        continue;
      }
      kill();
      pending.catch(() => undefined);
      if (options.signal.aborted) {
        throw new Error("claude agent run was cancelled");
      }
      throw new StallError(limitMs);
    }
  };

  try {
    for (;;) {
      const next = await pull();
      if (next.done) {
        break;
      }
      const message = next.value;
      spawnMs ??= reused ? 0 : Date.now() - spawnStart;
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (message.type === "stream_event") {
        if (message.parent_tool_use_id === null) {
          const event = message.event as { type: string; delta?: { type?: string; text?: string } };
          if (event.type === "message_start") {
            roundText = "";
          } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            ttftMs ??= Date.now() - sentAt;
            roundText += event.delta.text;
            options.onText?.(stripThinking(roundText));
          }
        }
      } else if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
        limitRejected = true;
        rejectedResetsAt = message.rate_limit_info.resetsAt;
      } else if (message.type === "assistant") {
        assistantError ??= message.error;
        roundTrips += 1;
        const roundUsage = (message.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
        if (roundUsage) {
          contextTokens = (roundUsage.input_tokens ?? 0) + (roundUsage.cache_read_input_tokens ?? 0) + (roundUsage.cache_creation_input_tokens ?? 0);
        }
        let blockText = "";
        let messageHasTool = false;
        for (const block of message.message.content as unknown as BlockLike[]) {
          if (block.type === "text" && typeof block.text === "string") {
            text += block.text;
            blockText += block.text;
          } else if (block.type === "thinking") {
            thinkingRan = true;
            options.onStatus?.({ kind: "thinking" });
          } else if (block.type === "tool_use" && typeof block.id === "string") {
            const name = shortToolName(String(block.name));
            toolNames.add(name);
            messageHasTool = true;
            toolsInFlight.set(block.id, { name, args: block.input });
            options.onStatus?.({ kind: "tool_running", name, args: block.input });
          }
        }
        finalAnswer.add(blockText, messageHasTool);
        // Without partial events the complete round text is the first the caller sees of it.
        if (blockText && roundText === "") {
          ttftMs ??= Date.now() - sentAt;
          options.onText?.(stripThinking(blockText));
        }
        roundText = "";
      } else if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const block of message.message.content as unknown as BlockLike[]) {
          const running = block.type === "tool_result" ? toolsInFlight.get(String(block.tool_use_id)) : undefined;
          if (running) {
            toolsInFlight.delete(String(block.tool_use_id));
            options.onStatus?.({ kind: "tool_completed", name: running.name, args: running.args });
          }
        }
      } else if (message.type === "result") {
        gotResult = true;
        const usage = message.usage;
        inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        outputTokens = usage.output_tokens;
        cacheReadTokens = usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
        if (options.signal.aborted) {
          throw new Error("claude agent run was cancelled");
        }
        if (message.subtype !== "success" || message.is_error) {
          const detail = message.subtype === "success" ? message.result : message.errors.join("; ");
          if (limitRejected || (assistantError && UNAVAILABLE_ERRORS.has(assistantError)) || UNAVAILABLE_TEXT.test(detail)) {
            throw markClaudeUnavailable(limitRejected ? "rate_limit" : (assistantError ?? "error_text"), rejectedResetsAt);
          }
          throw new Error(detail || `claude agent run failed (${message.subtype})`);
        }
        if (live) {
          break; // streaming input never ends by itself; the result closes the turn
        }
      }
    }
    if (options.signal.aborted) {
      throw new Error("claude agent run was cancelled");
    }
    if (live && !gotResult) {
      throw new Error("claude process ended before returning a result");
    }
  } catch (error) {
    // Any non-abort failure leaves the live process in an unknown state; the next turn spawns fresh.
    if (live && !(options.signal.aborted && gotResult)) {
      disposeLive(live);
    }
    const silent = text === "" && toolNames.size === 0;
    // A reused process that died, or a stalled turn, retries once on a fresh process (with resume).
    if (silent && !options.signal.aborted && !(error instanceof ClaudeUnavailableError) && (error instanceof StallError || (reused && !gotResult))) {
      throw new RetryableTurnError(error);
    }
    // A resume that can't find its transcript (pruned, or a pre-migration id) must not wedge the chat.
    if (resumeId && options.chatKey !== null && !options.signal.aborted && silent) {
      clearClaudeSession(options.chatKey, options.dbPath);
    }
    if (!(error instanceof ClaudeUnavailableError) && !options.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      if (UNAVAILABLE_TEXT.test(message)) {
        throw markClaudeUnavailable("error_text");
      }
    }
    throw error;
  } finally {
    options.signal.removeEventListener("abort", onAbortWake);
    if (thinkingSwitched) {
      const q = thinkingSwitched.q;
      await (options.reasoning === "off" ? q.setMaxThinkingTokens(0) : q.applyFlagSettings({ effortLevel: options.reasoning })).catch(() => undefined);
    }
    if (live) {
      live.busy = false;
    }
  }

  if (live) {
    live.sessionId = sessionId;
    live.roundTrips += roundTrips;
  }
  if (persist && sessionId) {
    saveClaudeSession(options.chatKey!, sessionId, options.dbPath);
  }

  return {
    text: finalAnswer.result(),
    toolNames: [...toolNames],
    inputTokens,
    outputTokens,
    pendingConfirmation: turnState.pendingConfirmation ?? undefined,
    thinkingRan,
    ttftMs,
    spawnMs,
    roundTrips,
    contextTokens,
    cacheReadTokens,
    cacheWriteTokens,
    toolMs: turnState.toolMs,
    toolCalls: turnState.toolCalls,
    cliCmds: turnState.cliCmds,
  };
}
