import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChatRole = "user" | "assistant" | "tool";

export type StoredMessage = {
  chatKey: string;
  seq: number;
  createdAt: string;
  role: ChatRole;
  contentJson: string;
  nativeProvider: string | null;
  /** Cache-read / cache-creation input tokens for the turn; null when not measured. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  nativeJson: string | null;
};

export type NewMessage = {
  role: ChatRole;
  contentJson: string;
  nativeProvider?: string | null;
  nativeJson?: string | null;
  createdAt?: string;
};

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
/** End a Claude session this long after the last user prompt. Keep-warm ticks do not extend it. */
export const PROMPT_IDLE_MINUTES = 15;
/** Audit-log rows kept per chat; oldest seqs are pruned on append. */
export const MAX_MESSAGES_PER_CHAT = 500;
/** Episodic snapshot kept when a chat is cleared. */
export const EPISODE_MAX_CHARS = 2_000;
/** A dismissed offer_save is not offered again until this elapses. */
export const OFFER_DISMISS_MS = 24 * 60 * 60_000;
function tomlDir(): string {
  const toml =
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml");
  return path.dirname(toml);
}

export function conversationDbPath(): string {
  return (
    process.env.MELVBOT_ASSISTANT_CONVERSATION_DB ??
    path.join(tomlDir(), "assistant_conversation.sqlite3")
  );
}

function openDb(dbPath = conversationDbPath()): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      chat_key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      role TEXT NOT NULL,
      content_json TEXT NOT NULL,
      native_provider TEXT,
      native_json TEXT,
      PRIMARY KEY (chat_key, seq)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_sessions (
      chat_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS brave_usage (
      month TEXT PRIMARY KEY,
      calls INTEGER NOT NULL,
      remaining INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_cache (
      key TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      url TEXT NOT NULL,
      content_type TEXT NOT NULL,
      text TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_quota (
      month TEXT NOT NULL,
      provider TEXT NOT NULL,
      calls INTEGER NOT NULL,
      exhausted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (month, provider)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS offer_dismissals (
      slug TEXT NOT NULL,
      section TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL
    )
  `);
  db.exec("DROP TABLE IF EXISTS recall_events");
  db.exec("DROP TABLE IF EXISTS note_reads");
  db.exec(`
    CREATE TABLE IF NOT EXISTS save_events (
      accepted INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS confirmations (
      code TEXT PRIMARY KEY,
      chat_key TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      chat_key TEXT,
      source TEXT NOT NULL,
      route TEXT NOT NULL,
      tools TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL
    )
  `);
  // Latency columns added after the table first shipped; nullable so old rows stay valid.
  const turnLogColumns = new Set((db.prepare("PRAGMA table_info(turn_log)").all() as { name: string }[]).map((column) => column.name));
  for (const column of ["ttft_ms", "spawn_ms", "round_trips", "context_tokens", "pre_ms", "tool_ms", "tool_calls", "cache_read_tokens", "cache_write_tokens"]) {
    if (!turnLogColumns.has(column)) {
      db.exec(`ALTER TABLE turn_log ADD COLUMN ${column} INTEGER`);
    }
  }
  if (!turnLogColumns.has("thinking")) {
    db.exec("ALTER TABLE turn_log ADD COLUMN thinking INTEGER");
  }
  if (!turnLogColumns.has("cli_cmds")) {
    db.exec("ALTER TABLE turn_log ADD COLUMN cli_cmds TEXT");
  }
  if (!turnLogColumns.has("think_rule")) {
    db.exec("ALTER TABLE turn_log ADD COLUMN think_rule TEXT");
  }
  if (!turnLogColumns.has("recall_miss")) {
    db.exec("ALTER TABLE turn_log ADD COLUMN recall_miss INTEGER");
  }
  chmodSync(dbPath, 0o600);
  return db;
}

function messageText(contentJson: string): string {
  try {
    const parts = JSON.parse(contentJson) as Array<{ text?: string }>;
    return parts.map((part) => part.text ?? "").join(" ").trim();
  } catch {
    return "";
  }
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    chatKey: String(row.chat_key),
    seq: Number(row.seq),
    createdAt: String(row.created_at),
    role: String(row.role) as ChatRole,
    contentJson: String(row.content_json),
    nativeProvider: row.native_provider == null ? null : String(row.native_provider),
    nativeJson: row.native_json == null ? null : String(row.native_json),
  };
}

export function allMessages(chatKey: string, dbPath = conversationDbPath()): StoredMessage[] {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT * FROM messages WHERE chat_key = ? ORDER BY seq ASC")
      .all(chatKey) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  } finally {
    db.close();
  }
}

export function append(
  chatKey: string,
  message: NewMessage,
  dbPath = conversationDbPath(),
): StoredMessage {
  const db = openDb(dbPath);
  try {
    const next = db
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE chat_key = ?")
      .get(chatKey) as { next_seq: number };
    const seq = Number(next.next_seq);
    const createdAt = message.createdAt ?? new Date().toISOString();
    db.prepare(
      `INSERT INTO messages (chat_key, seq, created_at, role, content_json, native_provider, native_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      chatKey,
      seq,
      createdAt,
      message.role,
      message.contentJson,
      message.nativeProvider ?? null,
      message.nativeJson ?? null,
    );
    db.prepare(
      `DELETE FROM messages
       WHERE chat_key = ?
         AND seq NOT IN (
           SELECT seq FROM messages WHERE chat_key = ? ORDER BY seq DESC LIMIT ?
         )`,
    ).run(chatKey, chatKey, MAX_MESSAGES_PER_CHAT);
    return {
      chatKey,
      seq,
      createdAt,
      role: message.role,
      contentJson: message.contentJson,
      nativeProvider: message.nativeProvider ?? null,
      nativeJson: message.nativeJson ?? null,
    };
  } finally {
    db.close();
  }
}

export function clear(chatKey: string, dbPath = conversationDbPath()): number {
  const db = openDb(dbPath);
  try {
    const result = db.prepare("DELETE FROM messages WHERE chat_key = ?").run(chatKey);
    return Number(result.changes);
  } finally {
    db.close();
  }
}

function sessionIsFresh(lastUsedAt: string, idleResetHours: number, now: Date): boolean {
  return now.getTime() - new Date(lastUsedAt).getTime() <= idleResetHours * MS_PER_HOUR;
}

export function idleChats(idleResetHours: number, dbPath = conversationDbPath(), now = new Date()): string[] {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT chat_key, MAX(created_at) AS newest FROM messages GROUP BY chat_key")
      .all() as { chat_key: string; newest: string }[];
    const cutoff = now.getTime() - idleResetHours * MS_PER_HOUR;
    return rows.filter((row) => new Date(row.newest).getTime() < cutoff).map((row) => row.chat_key);
  } finally {
    db.close();
  }
}

/** Chat keys whose newest user prompt is still inside `idleMinutes`. Assistant rows do not count. */
export function chatsWithRecentUserPrompt(
  idleMinutes: number,
  dbPath = conversationDbPath(),
  now = new Date(),
): string[] {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT chat_key, MAX(created_at) AS newest FROM messages WHERE role = 'user' GROUP BY chat_key",
      )
      .all() as { chat_key: string; newest: string }[];
    const cutoff = now.getTime() - idleMinutes * MS_PER_MINUTE;
    return rows.filter((row) => new Date(row.newest).getTime() >= cutoff).map((row) => row.chat_key);
  } finally {
    db.close();
  }
}

/** True when the chat's newest user prompt is at least `idleMinutes` old; false when it has none. */
export function lastUserPromptIsIdle(
  chatKey: string,
  idleMinutes: number,
  dbPath = conversationDbPath(),
  now = new Date(),
): boolean {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT MAX(created_at) AS newest FROM messages WHERE chat_key = ? AND role = 'user'")
      .get(chatKey) as { newest: string | null };
    return row.newest !== null && now.getTime() - new Date(row.newest).getTime() >= idleMinutes * MS_PER_MINUTE;
  } finally {
    db.close();
  }
}

/** Claude session bindings still inside the idle window. Keep-warm resumes these without a model call. */
export function activeClaudeSessions(
  idleResetHours: number,
  dbPath = conversationDbPath(),
  now = new Date(),
): ClaudeSession[] {
  const db = openDb(dbPath);
  try {
    const rows = db.prepare("SELECT chat_key, session_id, last_used_at FROM claude_sessions").all() as {
      chat_key: string;
      session_id: string;
      last_used_at: string;
    }[];
    return rows
      .filter((row) => sessionIsFresh(row.last_used_at, idleResetHours, now))
      .map((row) => ({ chatKey: row.chat_key, sessionId: row.session_id, lastUsedAt: row.last_used_at }));
  } finally {
    db.close();
  }
}

export type ClaudeSession = { chatKey: string; sessionId: string; lastUsedAt: string };

/**
 * The Claude Agent SDK session bound to a chat, or null if none exists yet or it
 * went idle past `idleResetHours` — the source of conversational continuity,
 * since turns `resume` the session instead of replaying a stored message window.
 */
export function getClaudeSession(
  chatKey: string,
  idleResetHours: number,
  dbPath = conversationDbPath(),
  now = new Date(),
): ClaudeSession | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT chat_key, session_id, last_used_at FROM claude_sessions WHERE chat_key = ?")
      .get(chatKey) as { chat_key: string; session_id: string; last_used_at: string } | undefined;
    if (!row) {
      return null;
    }
    if (now.getTime() - new Date(row.last_used_at).getTime() > idleResetHours * MS_PER_HOUR) {
      return null;
    }
    return { chatKey: row.chat_key, sessionId: row.session_id, lastUsedAt: row.last_used_at };
  } finally {
    db.close();
  }
}

/** Records the session bound to a chat and bumps its last-used timestamp. */
export function saveClaudeSession(
  chatKey: string,
  sessionId: string,
  dbPath = conversationDbPath(),
  now = new Date(),
): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO claude_sessions (chat_key, session_id, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_key) DO UPDATE SET session_id = excluded.session_id, last_used_at = excluded.last_used_at`,
    ).run(chatKey, sessionId, now.toISOString());
  } finally {
    db.close();
  }
}

export function countUserMessages(chatKey: string, dbPath = conversationDbPath()): number {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_key = ? AND role = 'user'")
      .get(chatKey) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function messagePlainText(contentJson: string): string {
  try {
    const parsed = JSON.parse(contentJson) as Array<{ text?: string }>;
    if (Array.isArray(parsed)) {
      return parsed.map((part) => part.text ?? "").join("");
    }
  } catch {
    return contentJson;
  }
  return contentJson;
}

const UNTRUSTED_BLOCK = /<untrusted\b[^>]*>[\s\S]*?<\/untrusted>/g;
const EPISODES_KEPT_PER_CHAT = 20;

/** Newest messages first, cut to EPISODE_MAX_CHARS. This is the episodic tier. */
export function formatEpisode(messages: readonly StoredMessage[], maxChars = EPISODE_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    const room = maxChars - used;
    if (room <= 0) {
      break;
    }
    const text = messagePlainText(message.contentJson).replace(UNTRUSTED_BLOCK, "[web results omitted]");
    const raw = `${message.role}: ${text.replace(/\s+/g, " ").trim()}`;
    const line = raw.length > room ? raw.slice(0, room) : raw;
    lines.push(line);
    used += line.length + 1;
    if (raw.length > room) {
      break;
    }
  }
  return lines.reverse().join("\n");
}

export function saveEpisode(chatKey: string, messages: readonly StoredMessage[], dbPath = conversationDbPath()): void {
  const body = formatEpisode(messages);
  if (!body.trim()) {
    return;
  }
  const db = openDb(dbPath);
  try {
    db.prepare("INSERT INTO episodes (chat_key, created_at, body) VALUES (?, ?, ?)").run(
      chatKey,
      new Date().toISOString(),
      body,
    );
    db.prepare(
      "DELETE FROM episodes WHERE chat_key = ? AND id NOT IN (SELECT id FROM episodes WHERE chat_key = ? ORDER BY id DESC LIMIT ?)",
    ).run(chatKey, chatKey, EPISODES_KEPT_PER_CHAT);
  } finally {
    db.close();
  }
}

export function latestEpisode(
  chatKey: string,
  dbPath = conversationDbPath(),
): { body: string; createdAt: string } | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT body, created_at FROM episodes WHERE chat_key = ? ORDER BY id DESC LIMIT 1")
      .get(chatKey) as { body: string; created_at: string } | undefined;
    return row ? { body: row.body, createdAt: row.created_at } : null;
  } finally {
    db.close();
  }
}

export function countEpisodes(dbPath = conversationDbPath()): number {
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

export function recordOfferDismissal(slug: string, section: string, dbPath = conversationDbPath(), now = Date.now()): void {
  const db = openDb(dbPath);
  try {
    db.prepare("INSERT INTO offer_dismissals (slug, section, dismissed_at) VALUES (?, ?, ?)").run(slug, section, now);
  } finally {
    db.close();
  }
}

export function offerDismissedRecently(
  slug: string,
  section: string,
  dbPath = conversationDbPath(),
  now = Date.now(),
): boolean {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT dismissed_at FROM offer_dismissals WHERE slug = ? AND section = ? ORDER BY dismissed_at DESC LIMIT 1",
      )
      .get(slug, section) as { dismissed_at: number } | undefined;
    return row !== undefined && now - Number(row.dismissed_at) < OFFER_DISMISS_MS;
  } finally {
    db.close();
  }
}

export function recordSave(accepted: boolean, dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare("INSERT INTO save_events (accepted, created_at) VALUES (?, ?)").run(
      accepted ? 1 : 0,
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

export type MemoryEval = {
  savesAccepted: number;
  savesDismissed: number;
  savePrecision: number | null;
};

export function memoryEval(dbPath = conversationDbPath()): MemoryEval {
  const db = openDb(dbPath);
  try {
    const saves = db.prepare("SELECT accepted, COUNT(*) AS n FROM save_events GROUP BY accepted").all() as {
      accepted: number;
      n: number;
    }[];
    const savesAccepted = Number(saves.find((row) => Number(row.accepted) === 1)?.n ?? 0);
    const savesDismissed = Number(saves.find((row) => Number(row.accepted) === 0)?.n ?? 0);
    const saveTotal = savesAccepted + savesDismissed;
    return {
      savesAccepted,
      savesDismissed,
      savePrecision: saveTotal === 0 ? null : savesAccepted / saveTotal,
    };
  } finally {
    db.close();
  }
}

export type StoredConfirmation = {
  code: string;
  chatKey: string;
  action: string;
  payloadJson: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
};

export function saveConfirmation(entry: StoredConfirmation, dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO confirmations (code, chat_key, action, payload_json, summary, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         chat_key = excluded.chat_key,
         action = excluded.action,
         payload_json = excluded.payload_json,
         summary = excluded.summary,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    ).run(entry.code, entry.chatKey, entry.action, entry.payloadJson, entry.summary, entry.createdAt, entry.expiresAt);
  } finally {
    db.close();
  }
}

export function takeConfirmation(code: string, dbPath = conversationDbPath()): StoredConfirmation | null {
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT * FROM confirmations WHERE code = ?").get(code) as
      | {
          code: string;
          chat_key: string;
          action: string;
          payload_json: string;
          summary: string;
          created_at: number;
          expires_at: number;
        }
      | undefined;
    db.prepare("DELETE FROM confirmations WHERE code = ?").run(code);
    if (!row) {
      return null;
    }
    return {
      code: row.code,
      chatKey: row.chat_key,
      action: row.action,
      payloadJson: row.payload_json,
      summary: row.summary,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  } finally {
    db.close();
  }
}

/** Newest unexpired confirmation code for a chat, without consuming it. */
export function latestConfirmationCode(chatKey: string, now: number, dbPath = conversationDbPath()): string | null {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT code FROM confirmations WHERE chat_key = ? AND expires_at >= ? ORDER BY created_at DESC LIMIT 1")
      .get(chatKey, now) as { code: string } | undefined;
    return row?.code ?? null;
  } finally {
    db.close();
  }
}

export function clearConfirmations(dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare("DELETE FROM confirmations").run();
  } finally {
    db.close();
  }
}

/** Drops the stored agent binding for a chat, forcing a fresh `Agent.create` on its next turn. */
export function clearClaudeSession(chatKey: string, dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare("DELETE FROM claude_sessions WHERE chat_key = ?").run(chatKey);
  } finally {
    db.close();
  }
}

/** Days of `turn_log` rows kept; older rows are pruned on insert. */
export const TURN_LOG_DAYS = 90;
/** Days before `turn_log.prompt` is cut to TURN_LOG_PROMPT_KEEP_CHARS; the row itself stays until TURN_LOG_DAYS. */
export const TURN_LOG_PROMPT_DAYS = 30;
export const TURN_LOG_PROMPT_KEEP_CHARS = 200;

export type TurnLogEntry = {
  createdAt: string;
  chatKey: string | null;
  source: string;
  /** Which provider answered: `claude` or `fallback:<provider>`. */
  route: string;
  tools: string[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
  status: string;
  prompt: string;
  /** Prompt sent to first streamed text delta; null when not measured. */
  ttftMs?: number | null;
  /** SDK query start to first message (near 0 when a live process is reused); null when not measured. */
  spawnMs?: number | null;
  /** Assistant API messages in the turn; null when not measured. */
  roundTrips?: number | null;
  /** Context size of the last API round; null when not measured. */
  contextTokens?: number | null;
  /** Cache-read / cache-creation input tokens for the turn; null when not measured. */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** A thinking block streamed this turn; null when not measured. */
  thinking?: boolean | null;
  /** Think trigger that fired (`prefix`, a prose rule name, `long`, `multi_question`); null when none. */
  thinkRule?: string | null;
  /** Wall time of the pre-step fan-out (web prefetch, recall, system prompt, rule prefetch); null when not measured. */
  preMs?: number | null;
  /** Summed MCP tool handler wall time in the turn; null when not measured. */
  toolMs?: number | null;
  /** Tool calls in the turn (not distinct names); null when not measured. */
  toolCalls?: number | null;
  /** melvbot_cli subcommands called in the turn, in order; null when not recorded. */
  cliCmds?: string[] | null;
  /** 1 when the turn ran `note get` with no recall note body injected; null when not recorded. */
  recallMiss?: number | null;
};

/**
 * One row per assistant turn (messages that got past the non-LLM intercepts), with the prompt
 * text, so recurring requests can be reviewed and turned into intercepts (`melvbot turns`).
 */
export function recordTurn(entry: Omit<TurnLogEntry, "createdAt">, dbPath = conversationDbPath(), now = new Date()): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO turn_log (created_at, chat_key, source, route, tools, input_tokens, output_tokens, ms, status, prompt, ttft_ms, spawn_ms, round_trips, context_tokens, pre_ms, tool_ms, tool_calls, thinking, think_rule, cache_read_tokens, cache_write_tokens, cli_cmds, recall_miss)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now.toISOString(),
      entry.chatKey,
      entry.source,
      entry.route,
      JSON.stringify(entry.tools),
      entry.inputTokens,
      entry.outputTokens,
      entry.ms,
      entry.status,
      entry.prompt,
      entry.ttftMs ?? null,
      entry.spawnMs ?? null,
      entry.roundTrips ?? null,
      entry.contextTokens ?? null,
      entry.preMs ?? null,
      entry.toolMs ?? null,
      entry.toolCalls ?? null,
      entry.thinking == null ? null : entry.thinking ? 1 : 0,
      entry.thinkRule ?? null,
      entry.cacheReadTokens ?? null,
      entry.cacheWriteTokens ?? null,
      entry.cliCmds ? JSON.stringify(entry.cliCmds) : null,
      entry.recallMiss ?? null,
    );
    const cutoff = new Date(now.getTime() - TURN_LOG_DAYS * 24 * MS_PER_HOUR).toISOString();
    db.prepare("DELETE FROM turn_log WHERE created_at < ?").run(cutoff);
    const promptCutoff = new Date(now.getTime() - TURN_LOG_PROMPT_DAYS * 24 * MS_PER_HOUR).toISOString();
    db.prepare("UPDATE turn_log SET prompt = substr(prompt, 1, ?) WHERE created_at < ? AND length(prompt) > ?").run(
      TURN_LOG_PROMPT_KEEP_CHARS,
      promptCutoff,
      TURN_LOG_PROMPT_KEEP_CHARS,
    );
  } finally {
    db.close();
  }
}

/** Context tokens of the chat's latest completed Claude turn; 0 when there is none or it was not measured (old rows). */
export function lastClaudeTurnContextTokens(chatKey: string, dbPath = conversationDbPath()): number {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare("SELECT context_tokens FROM turn_log WHERE chat_key = ? AND route = 'claude' AND status IN ('ok', 'pending_confirmation') ORDER BY id DESC LIMIT 1")
      .get(chatKey) as { context_tokens: number | null } | undefined;
    return row?.context_tokens == null ? 0 : Number(row.context_tokens);
  } finally {
    db.close();
  }
}

/** Turn counts per route since `sinceIso`, e.g. `{ claude: 4, "intercept:weather": 2 }`. */
export function turnRouteCountsSince(sinceIso: string, dbPath = conversationDbPath()): Record<string, number> {
  const db = openDb(dbPath);
  try {
    const rows = db.prepare("SELECT route, COUNT(*) AS n FROM turn_log WHERE created_at >= ? GROUP BY route").all(sinceIso) as { route: string; n: number }[];
    return Object.fromEntries(rows.map((row) => [row.route, Number(row.n)]));
  } finally {
    db.close();
  }
}

/** Turns from the last `days` days, oldest first. */
export function recentTurns(days: number, dbPath = conversationDbPath(), now = new Date()): TurnLogEntry[] {
  const db = openDb(dbPath);
  try {
    const cutoff = new Date(now.getTime() - days * 24 * MS_PER_HOUR).toISOString();
    const rows = db.prepare("SELECT * FROM turn_log WHERE created_at >= ? ORDER BY id").all(cutoff) as Record<string, unknown>[];
    return rows.map((row) => ({
      createdAt: String(row.created_at),
      chatKey: row.chat_key === null ? null : String(row.chat_key),
      source: String(row.source),
      route: String(row.route),
      tools: JSON.parse(String(row.tools)) as string[],
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      ms: Number(row.ms),
      status: String(row.status),
      prompt: String(row.prompt),
      ttftMs: row.ttft_ms == null ? null : Number(row.ttft_ms),
      spawnMs: row.spawn_ms == null ? null : Number(row.spawn_ms),
      roundTrips: row.round_trips == null ? null : Number(row.round_trips),
      contextTokens: row.context_tokens == null ? null : Number(row.context_tokens),
      cacheReadTokens: row.cache_read_tokens == null ? null : Number(row.cache_read_tokens),
      cacheWriteTokens: row.cache_write_tokens == null ? null : Number(row.cache_write_tokens),
      preMs: row.pre_ms == null ? null : Number(row.pre_ms),
      toolMs: row.tool_ms == null ? null : Number(row.tool_ms),
      toolCalls: row.tool_calls == null ? null : Number(row.tool_calls),
      thinking: row.thinking == null ? null : Number(row.thinking) === 1,
      thinkRule: row.think_rule == null ? null : String(row.think_rule),
      cliCmds: row.cli_cmds == null ? null : (JSON.parse(String(row.cli_cmds)) as string[]),
      recallMiss: row.recall_miss == null ? null : Number(row.recall_miss),
    }));
  } finally {
    db.close();
  }
}

export type BraveUsageRow = { calls: number; remaining: number | null };

export function getBraveUsage(month: string, dbPath = conversationDbPath()): BraveUsageRow {
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT calls, remaining FROM brave_usage WHERE month = ?").get(month) as
      | { calls: number; remaining: number | null }
      | undefined;
    return row ? { calls: row.calls, remaining: row.remaining } : { calls: 0, remaining: null };
  } finally {
    db.close();
  }
}

/** Counts one Brave request sent in `month`; `remaining` (from rate-limit headers) is stored when given. */
export function recordBraveUsage(month: string, remaining: number | null, dbPath = conversationDbPath(), sent = true): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO brave_usage (month, calls, remaining) VALUES (?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET calls = calls + excluded.calls, remaining = COALESCE(excluded.remaining, remaining)`,
    ).run(month, sent ? 1 : 0, remaining);
  } finally {
    db.close();
  }
}

export type PageCacheRow = { url: string; contentType: string; text: string };

/** Page fetched at or after `since` (ms epoch) under the normalised `key`, or null. */
export function getPageCache(key: string, since: number, dbPath = conversationDbPath()): PageCacheRow | null {
  const db = openDb(dbPath);
  try {
    const row = db.prepare("SELECT url, content_type, text FROM page_cache WHERE key = ? AND fetched_at >= ?").get(key, since) as
      | { url: string; content_type: string; text: string }
      | undefined;
    return row ? { url: row.url, contentType: row.content_type, text: row.text } : null;
  } finally {
    db.close();
  }
}

export function putPageCache(key: string, page: PageCacheRow, fetchedAt: number, dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare("INSERT OR REPLACE INTO page_cache (key, fetched_at, url, content_type, text) VALUES (?, ?, ?, ?, ?)").run(
      key,
      fetchedAt,
      page.url,
      page.contentType,
      page.text,
    );
  } finally {
    db.close();
  }
}

export function clearPageCache(dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.exec("DELETE FROM page_cache");
  } finally {
    db.close();
  }
}

export type WebQuotaRow = { provider: string; calls: number; exhausted: boolean };

export function getWebQuota(month: string, dbPath = conversationDbPath()): WebQuotaRow[] {
  const db = openDb(dbPath);
  try {
    const rows = db.prepare("SELECT provider, calls, exhausted FROM web_quota WHERE month = ?").all(month) as {
      provider: string;
      calls: number;
      exhausted: number;
    }[];
    return rows.map((row) => ({ provider: row.provider, calls: row.calls, exhausted: row.exhausted === 1 }));
  } finally {
    db.close();
  }
}

/** Adds `calls` requests to a provider's count for `month`; `exhausted` marks it spent until the month ends. */
export function recordWebQuota(month: string, provider: string, calls: number, exhausted: boolean, dbPath = conversationDbPath()): void {
  const db = openDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO web_quota (month, provider, calls, exhausted) VALUES (?, ?, ?, ?)
       ON CONFLICT(month, provider) DO UPDATE SET calls = calls + excluded.calls, exhausted = MAX(exhausted, excluded.exhausted)`,
    ).run(month, provider, calls, exhausted ? 1 : 0);
  } finally {
    db.close();
  }
}
