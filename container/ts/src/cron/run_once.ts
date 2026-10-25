import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isMonthlyFromWeeklyPrompt, isMonthlyReminderPrompt, isWeeklyReminderPrompt, renderMonthlyFromWeekly, renderMonthlyReminder, renderWeeklyReminder } from "./weekly_reminder.js";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { endPromptIdleSessions } from "../assistant/claude_session.js";
import { dcaNoteBlock, fetchYahooQuote, prefetchRule, type Quote } from "../assistant/rule_prefetch.js";
import { routedSearch } from "../assistant/search_router.js";
import { appendNoteHistory, getNote } from "../note/notes.js";
import { runBackup } from "./backup.js";
import { titleLine } from "../telegram/title_line.js";
import { runTurn } from "../assistant/turn.js";
import { loadAssistantToml } from "../assistant/toml.js";
import { googleTokenPath, tasksDueOrOverdue, type DueTask } from "../google/http.js";
import { listMergedAgenda } from "../reminders/agenda.js";
import { taskButtonRows } from "../reminders/callbacks.js";
import { dueTaskLines, formatEventLines } from "../reminders/format.js";
import { prefetchNewsData, type Headline } from "./news.js";
import { extractReceiptCandidates, formatDigestMessage, type GraphMessage, type SentMessage } from "../outlook/digest_format.js";
import { listInboxMessages, listReplyContext } from "../outlook/graph.js";
import { getGraphAccessToken } from "../outlook/token.js";
import { TelegramApi } from "../telegram/api.js";
import {
  fetchNowcastItem,
  fetchPm25Item,
  formatWeatherMessage,
  measuredPm25Band,
  nowcastHasRain,
  sgtHour,
  shouldSendWeather,
} from "../telegram/weather.js";
import { dcaMessageStatePath, maintMessageStatePath, morningMessageStatePath, outlookMessageStatePath, publishReplacingMessage, publishWeatherMessage, readWeatherWatch, replacePriorMessages, writeWeatherWatch } from "../telegram/weather_message.js";
import { latestSlotToday, slotKey } from "./due.js";
import { renderMorningUpdate, splitMorningUpdate } from "./morning_update.js";
import { formatMaintReportMessages, TELEGRAM_VISIBLE_LIMIT } from "./maint_report.js";
import { buildHeadsUpBlock, buildMonthlyReviewBlock, type BundleBlock } from "../nudges/bundle.js";
import { digestLogButtonsKeyboard, nudgeButtonsKeyboard } from "../nudges/callbacks.js";
import { collectHeadsUpInput, collectMonthlyReviewInput } from "../nudges/collect.js";
import { createDigestReceipt } from "../nudges/store.js";
import { loadNudgesToml } from "../nudges/toml.js";
import {
  KIND_AFTERNOON_WEATHER,
  KIND_AGENT,
  KIND_MORNING_UPDATE,
  KIND_BACKUP,
  KIND_IDLE_RESET,
  KIND_MAINT_REPORT,
  KIND_OUTLOOK_DIGEST,
  KIND_SHOPEE,
  KNOWN_KINDS,
  claimRunSlot,
  getJob,
  isTriggered,
  listCronJobs,
  releaseRunSlot,
  type CronJob,
} from "./store.js";

export const SKIPPED_OUTPUT = "[SKIPPED]";
export const SILENT_OUTPUT = "[SILENT]";
const FALLBACK_HOURS = 14;
const SCRIPT_TIMEOUT_MS = 120_000;

/** Code-rendered reminder text; the monthly-review job also carries the review block and buttons. */
export async function notifyReminderText(
  job: Pick<CronJob, "id">,
  text: string,
  io = {
    reviewJobId: () => loadNudgesToml().monthlyReviewJobId,
    review: tryBuildMonthlyReviewBlock,
    plain: telegramNotify,
    withButtons: telegramNotifyWithButtons,
  },
): Promise<void> {
  const monthlyReview = job.id === io.reviewJobId() ? await io.review() : null;
  if (monthlyReview) {
    await io.withButtons(`${text}\n\n${monthlyReview.text}`, nudgeButtonsKeyboard(monthlyReview.buttons));
  } else {
    await io.plain(text);
  }
}

function configDir(): string {
  return process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config";
}

function cronScriptsDir(): string {
  return process.env.MELVBOT_CRON_SCRIPTS ?? "/workspace/melvbot/scripts/cron";
}

function botToken(): string {
  if (process.env.MELVBOT_TS_ALLOW_LIVE_TOKEN === "1") {
    return process.env.MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN?.trim() ?? "";
  }
  return process.env.MELVBOT__TRANSPORTS__TELEGRAM__TEST_BOT_TOKEN?.trim() ?? "";
}

function chatId(): string {
  return (
    process.env.MELVBOT__TRANSPORTS__TELEGRAM__CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    ""
  );
}

export function digestSlotFromSchedule(schedule: string): "morning" | "evening" {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`unsupported outlook digest schedule: ${schedule}`);
  }
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (hour === 7 && minute === 45) {
    return "morning";
  }
  if (hour === 19 && minute === 45) {
    return "evening";
  }
  throw new Error(`unsupported outlook digest schedule: ${schedule}`);
}

function digestStatePath(slot: "morning" | "evening"): string {
  const name = slot === "morning" ? "outlook-digest-morning" : "outlook-digest-evening";
  return path.join(configDir(), "state", name);
}

function siblingSlot(slot: "morning" | "evening"): "morning" | "evening" {
  return slot === "morning" ? "evening" : "morning";
}

function resolveWindowStart(slot: "morning" | "evening", now = new Date()): Date {
  const fallback = new Date(now.getTime() - FALLBACK_HOURS * 60 * 60 * 1000);
  const sibling = digestStatePath(siblingSlot(slot));
  if (!existsSync(sibling)) {
    return fallback;
  }
  const parsed = new Date(readFileSync(sibling, "utf8").trim());
  if (Number.isNaN(parsed.getTime()) || parsed < fallback) {
    return fallback;
  }
  return parsed;
}

function persistDigestSuccess(slot: "morning" | "evening"): void {
  const file = digestStatePath(slot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${new Date().toISOString()}\n`);
}

function clip(text: string): string {
  if (text.length <= TELEGRAM_VISIBLE_LIMIT) {
    return text;
  }
  return `${text.slice(0, TELEGRAM_VISIBLE_LIMIT - 1)}…`;
}

async function publishWeatherTelegram(text: string): Promise<void> {
  const dest = chatId();
  const token = botToken();
  if (!dest || !token) {
    return;
  }
  const api = new TelegramApi(token);
  await publishWeatherMessage(api, Number(dest), clip(text));
}

async function publishDcaTelegram(text: string): Promise<void> {
  const dest = chatId();
  const token = botToken();
  if (!dest || !token) {
    return;
  }
  const api = new TelegramApi(token);
  await publishReplacingMessage(api, Number(dest), clip(text), dcaMessageStatePath());
}

/** The outbox resolves null for a dropped send (flood limit); a cron job must not report that as done. */
function requireSent(result: unknown): void {
  if (result === null) {
    throw new Error("telegram send was dropped (flood limit or closed outbox)");
  }
}

function sentMessageId(sent: unknown): number | null {
  const id = (sent as { message_id?: unknown } | null)?.message_id;
  return typeof id === "number" ? id : null;
}

/** Deletes the messages the previous run recorded at statePath and records these. */
async function replaceRecorded(ids: (number | null)[], statePath: string): Promise<void> {
  const dest = chatId();
  const token = botToken();
  if (!dest || !token) {
    return;
  }
  await replacePriorMessages(new TelegramApi(token), Number(dest), ids.filter((id): id is number => id !== null), statePath);
}

async function telegramNotify(text: string): Promise<number | null> {
  const dest = chatId();
  const token = botToken();
  if (!dest || !token) {
    return null;
  }
  const api = new TelegramApi(token);
  const sent = await api.sendMessage(Number(dest), clip(text));
  requireSent(sent);
  return sentMessageId(sent);
}

async function telegramNotifyWithButtons(text: string, keyboard: ReturnType<typeof nudgeButtonsKeyboard>): Promise<number | null> {
  const dest = chatId();
  const token = botToken();
  if (!dest || !token) {
    return null;
  }
  const api = new TelegramApi(token);
  const sent = await api.sendMessage(Number(dest), clip(text), { reply_markup: keyboard });
  requireSent(sent);
  return sentMessageId(sent);
}

async function sendMorningUpdate(
  text: string,
  headsUp?: BundleBlock | null,
  tasks: readonly DueTask[] = [],
  news?: Record<string, readonly Headline[]>,
): Promise<void> {
  const dest = chatId();
  const token = botToken();
  if (!dest || !token) {
    return;
  }
  const api = new TelegramApi(token);
  const chunks = splitMorningUpdate(text, { news });
  const sentIds: number[] = [];
  for (const [index, payload] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const extra: { entities?: typeof payload.entities; reply_markup?: { inline_keyboard: unknown[] } } = {};
    if (payload.entities?.length) {
      extra.entities = payload.entities;
    }
    const body = isLast && headsUp ? `${payload.text}\n\n${headsUp.text}` : payload.text;
    if (isLast) {
      const rows = [
        ...(headsUp && headsUp.buttons.length > 0 ? nudgeButtonsKeyboard(headsUp.buttons).inline_keyboard : []),
        ...taskButtonRows(tasks),
      ];
      if (rows.length > 0) {
        extra.reply_markup = { inline_keyboard: rows };
      }
    }
    const sent = await api.sendMessage(Number(dest), body, extra);
    requireSent(sent);
    const id = (sent as { message_id?: unknown } | null)?.message_id;
    if (typeof id === "number") {
      sentIds.push(id);
    }
  }
  await replacePriorMessages(api, Number(dest), sentIds, morningMessageStatePath());
}

/** Builds the Heads up block for the Morning Update. A failure is logged and
 * the block is skipped; the main Morning Update message still sends. */
async function tryBuildHeadsUpBlock(now = new Date()): Promise<BundleBlock | null> {
  try {
    const toml = loadNudgesToml();
    const input = await collectHeadsUpInput(toml, now);
    return buildHeadsUpBlock(input);
  } catch (error) {
    console.error("nudges: failed to build the Heads up block", error);
    return null;
  }
}

/** Builds the Monthly review block for the Monthly 1st job. Same
 * fail-open behaviour as tryBuildHeadsUpBlock. */
async function tryBuildMonthlyReviewBlock(now = new Date()): Promise<BundleBlock | null> {
  try {
    const toml = loadNudgesToml();
    const input = await collectMonthlyReviewInput(toml, now);
    return buildMonthlyReviewBlock(input);
  } catch (error) {
    console.error("nudges: failed to build the Monthly review block", error);
    return null;
  }
}

function runCronScript(script: string): string {
  const root = path.resolve(cronScriptsDir());
  const resolved = path.resolve(root, script);
  if (!resolved.startsWith(`${root}/`) && resolved !== root) {
    throw new Error(`script path outside allowed directories: ${script}`);
  }
  const completed = spawnSync(resolved, {
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
    env: { ...process.env, MELVBOT_GOOGLE_HOME: process.env.MELVBOT_GOOGLE_HOME },
  });
  if (completed.status !== 0) {
    const detail = (completed.stderr || completed.stdout || "no output").trim().split("\n").at(-1);
    throw new Error(`script ${path.basename(resolved)} failed (exit ${completed.status}): ${detail}`);
  }
  return (completed.stdout ?? "").trim();
}

function isShopeeAlertDay(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (month === day) {
    return true;
  }
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const next = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    month: "numeric",
    day: "numeric",
  }).formatToParts(tomorrow);
  return (
    Number(next.find((part) => part.type === "month")?.value) ===
    Number(next.find((part) => part.type === "day")?.value)
  );
}

/** Calendar (primary + family) and due/overdue tasks, pre-formatted by src/reminders/format.ts. */
async function googlePrefetch(): Promise<{ text: string; tasks: DueTask[]; calendarLines: string[]; taskLines: string[] }> {
  if (!existsSync(googleTokenPath())) {
    throw new Error("google_token.json missing");
  }
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const events = await listMergedAgenda(`${day}T00:00:00+08:00`, `${day}T23:59:59+08:00`);
  const tasks = await tasksDueOrOverdue(day);
  const lines = (list: string[]) => (list.length > 0 ? list.join("\n") : "(none)");
  const calendarLines = formatEventLines(events);
  const taskLines = dueTaskLines(tasks);
  return {
    tasks,
    calendarLines,
    taskLines,
    text: [
      `fetched_at=${day} SGT`,
      "## calendar_lines (today, time-sorted, family + reminders included; paste verbatim)",
      lines(formatEventLines(events)),
      "## task_lines (open, due today or overdue, sorted; already filtered; paste verbatim)",
      lines(dueTaskLines(tasks)),
    ].join("\n"),
  };
}

async function runAssistantPrompt(prompt: string, blockWeb = false): Promise<{ ok: boolean; text: string }> {
  const assistantToml = loadAssistantToml();
  try {
    const result = await runTurn(
      { chatKey: null, prompt, signal: new AbortController().signal, source: "cron", blockWeb },
      { assistantToml },
    );
    return { ok: result.status === "ok", text: result.text.trim() };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

async function runIdleReset(): Promise<void> {
  await endPromptIdleSessions();
}

export function dcaHeader(now: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `Markets Update ${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

// Haiku ignores the prompt's "say whether bond prices rose or fell" and echoes yield levels, so the Bonds bullet is computed from the 10Y (^TNX) move.
export function dcaBondLine(tnx: Quote): string {
  const bp = Math.round((tnx.close - tnx.prevClose) * 100);
  const yieldText = `10Y yield ${tnx.close.toFixed(2)}%, ${bp >= 0 ? "+" : "−"}${Math.abs(bp)}bp`;
  if (bp === 0) return `• Bonds: prices flat (${yieldText})`;
  return `• Bonds: prices ${bp > 0 ? "down" : "up"} (${yieldText})`;
}

// MiniMax quoted a stale STI close (and n/a for the latest), so the STI bullet is computed from ^STI.
export function dcaStiLine(sti: Quote): string {
  const pct = `${sti.pct >= 0 ? "+" : "−"}${Math.abs(sti.pct).toFixed(2)}%`;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short" }).format(new Date(sti.time * 1000));
  return `• STI: ${sti.close.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pct}, ${day} close)`;
}

export function withDcaStiLine(body: string, sti: Quote | null): string {
  if (sti === null) return body;
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^\s*[•\-*]\s*STI\b/i.test(l));
  if (i === -1) return `${body}\n${dcaStiLine(sti)}`;
  lines[i] = dcaStiLine(sti);
  return lines.join("\n");
}

export function withDcaBondLine(body: string, tnx: Quote | null): string {
  if (tnx === null) return body;
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^\s*[•\-*]\s*Bonds\b/i.test(l));
  if (i === -1) return `${dcaBondLine(tnx)}\n${body}`;
  lines[i] = dcaBondLine(tnx);
  return lines.join("\n");
}

// Keeps first..last bullet (interior non-bullet lines too, else the body collapses to one bullet): drops model preamble ("Perfect. Now I'll..."), its own headers and time footers.
export function cleanDcaBody(text: string): string {
  const lines = text.split("\n");
  const isBullet = (l: string) => /^\s*[•\-*]\s/.test(l);
  let end = lines.length - 1;
  while (end >= 0 && !isBullet(lines[end]!)) end--;
  if (end < 0) return text.trim();
  const start = lines.findIndex(isBullet);
  return lines.slice(start, end + 1).join("\n").trim();
}

export const DCA_INSTRUCTIONS =
  "## Prefetched data (searches, quotes and the DCA note already fetched; you have no tools and step 2 does not apply: write n/a for anything missing, never invent numbers).\n" +
  "Ignore any instruction to call melvbot_cli. Reply with exactly two tagged blocks and nothing else:\n" +
  "<telegram>the market update in the job's \"Format (concise bullets)\" above, not the <rule> format: bullets only (• US, • STI, • Drivers, • Plan; skip the title line and the Bonds bullet, both are added in code; never mention bond yields or the 10Y in any bullet), every line starting with •, plain text (& not &amp;)</telegram>\n" +
  "<note_entry>one line for the note's History: plan status, then today's US/STI/10Y levels (no date, it is added in code; do not rewrite the note)</note_entry>";

async function dcaWebSearch(): Promise<string> {
  try {
    const { hits } = await routedSearch("stock market today S&P 500 Nasdaq STI US 10-year Treasury yield", 8, "background");
    return `<untrusted source="web_search">\n${hits.map((h) => `- ${h.title} (${h.url}): ${h.snippet}`).join("\n")}\n</untrusted>`;
  } catch {
    return "";
  }
}

/** Splits the model reply into the Telegram message and a one-line History entry; null when either block is missing or empty. */
export function parseDcaReply(reply: string): { telegram: string; noteEntry: string } | null {
  // MiniMax sometimes HTML-escapes the tags themselves.
  reply = reply.replace(/&lt;(\/?(?:telegram|note_entry))&gt;/g, "<$1>");
  const pick = (tag: string) => reply.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
  // MiniMax HTML-escapes & and uses "-" bullets despite the prompt; normalise in code.
  const telegram = pick("telegram").replace(/&amp;/g, "&").replace(/^\s*[-*]\s/gm, "• ");
  const noteEntry = pick("note_entry").replace(/&amp;/g, "&").replace(/\s*\n\s*/g, " ");
  return telegram && noteEntry ? { telegram, noteEntry } : null;
}

async function runDcaViaHaiku(prompt: string): Promise<{ ok: boolean; text: string }> {
  try {
    const note = await getNote("dollar-cost-averaging");
    // The rule prefetch drops the note when its cached read fails; the plan verdict needs it.
    if (!prompt.includes('<note slug="dollar-cost-averaging"')) {
      prompt = `${prompt}\n${dcaNoteBlock(note)}\n`;
    }
    // A malformed reply gets one retry instead of failing the run.
    let parsed: ReturnType<typeof parseDcaReply> = null;
    let last = "";
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const reply = await runAssistantPrompt(prompt, true);
      if (!reply.ok) {
        return reply;
      }
      const text = reply.text;
      parsed = parseDcaReply(text);
      last = text;
    }
    if (!parsed) {
      return { ok: false, text: `Haiku reply missing <telegram> or <note_entry> (${last.length} chars, ends: ${last.slice(-200)})` };
    }
    // Append one History line instead of rewriting the ~20k-char body (MiniMax truncated the full rewrite).
    await appendNoteHistory("dollar-cost-averaging", parsed.noteEntry, note.revision_id);
    return { ok: true, text: parsed.telegram };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

function isDcaJob(job: CronJob): boolean {
  return job.name.startsWith("DCA Market Update") || job.prompt.startsWith("You are Melvbot's Dollar Cost Averaging weekday market update");
}

async function executeJob(job: CronJob): Promise<string> {
  const kind = KNOWN_KINDS.has(job.kind) ? job.kind : KIND_AGENT;
  if (kind === KIND_IDLE_RESET) {
    await runIdleReset();
    return SILENT_OUTPUT;
  }
  if (kind === KIND_BACKUP) {
    const failure = await runBackup().catch(
      (error: unknown) => `${titleLine("Backup Failed", new Date())}\n\n${error instanceof Error ? error.message : String(error)}`,
    );
    if (failure !== null) {
      await telegramNotify(failure);
    }
    return SILENT_OUTPUT;
  }
  if (kind === KIND_SHOPEE && !isShopeeAlertDay()) {
    return SILENT_OUTPUT;
  }
  if (kind === KIND_AFTERNOON_WEATHER) {
    const now = new Date();
    const hour = sgtHour(now);
    let pm25: Record<string, unknown> | null = null;
    try {
      pm25 = await fetchPm25Item();
    } catch {
      pm25 = null;
    }
    let nowcast: Record<string, unknown> | null = null;
    let nowcastOk = false;
    try {
      nowcast = await fetchNowcastItem(now);
      nowcastOk = true;
    } catch {
      nowcast = null;
    }
    const measured = measuredPm25Band(pm25);
    const band = measured ?? "Normal";
    const previous = readWeatherWatch();
    const previousBand = measured ? previous.band : null;
    const raining = nowcastOk ? nowcastHasRain(nowcast, now) : previous.raining;
    const nextWatch = {
      band: measured ?? previous.band,
      raining: nowcastOk ? raining : previous.raining,
    };
    if (!shouldSendWeather(hour)) {
      writeWeatherWatch(nextWatch);
      return SILENT_OUTPUT;
    }
    const message = await formatWeatherMessage({
      now,
      pm25,
      ...(nowcastOk ? { nowcast } : {}),
      cronLayout: true,
    });
    await publishWeatherTelegram(message);
    writeWeatherWatch(nextWatch);
    return message;
  }
  if (kind === KIND_OUTLOOK_DIGEST) {
    const slot = digestSlotFromSchedule(job.schedule);
    const token = await getGraphAccessToken();
    const start = resolveWindowStart(slot);
    const { messages, truncated } = await listInboxMessages(token, start.toISOString());
    const reply = await listReplyContext(token);
    const message = formatDigestMessage(messages as GraphMessage[], {
      slot,
      truncated,
      reply: { me: reply.me, carry: reply.carry as GraphMessage[], sent: reply.sent as SentMessage[] },
    });
    if (loadNudgesToml().digestLog) {
      const candidates = extractReceiptCandidates(messages as GraphMessage[]);
      if (candidates.length > 0) {
        const receipts = candidates.map((candidate) => ({ ...candidate, code: createDigestReceipt(candidate).code }));
        const id = await telegramNotifyWithButtons(message, digestLogButtonsKeyboard(receipts));
        await replaceRecorded([id], outlookMessageStatePath());
        persistDigestSuccess(slot);
        return message;
      }
    }
    await replaceRecorded([await telegramNotify(message)], outlookMessageStatePath());
    persistDigestSuccess(slot);
    return message;
  }
  if (kind === KIND_MAINT_REPORT) {
    if (!job.script) {
      throw new Error("Daily Maintenance Report requires a script");
    }
    const raw = runCronScript(job.script);
    const messages = formatMaintReportMessages(raw);
    const ids: (number | null)[] = [];
    for (const message of messages) {
      ids.push(await telegramNotify(message));
    }
    await replaceRecorded(ids, maintMessageStatePath());
    return messages.join("\n\n");
  }
  if (isWeeklyReminderPrompt(job.prompt)) {
    // Fixed list in the job prompt: rendered in code, no Claude call.
    const text = renderWeeklyReminder(job.prompt, new Date());
    await telegramNotify(text);
    return text;
  }
  if (isMonthlyFromWeeklyPrompt(job.prompt)) {
    const weekly = listCronJobs().find((candidate) => isWeeklyReminderPrompt(candidate.prompt));
    const text = weekly ? renderMonthlyFromWeekly(weekly.prompt, new Date()) : null;
    if (text === null) {
      return SILENT_OUTPUT;
    }
    await notifyReminderText(job, text);
    return text;
  }
  if (isMonthlyReminderPrompt(job.prompt)) {
    const text = renderMonthlyReminder(job.prompt, new Date());
    if (text === null) {
      return SILENT_OUTPUT;
    }
    await notifyReminderText(job, text);
    return text;
  }
  let prompt = job.prompt;
  let dailyTasks: DueTask[] = [];
  let dailyNews: Record<string, Headline[]> | undefined;
  if (kind === KIND_MORNING_UPDATE) {
    let google: Awaited<ReturnType<typeof googlePrefetch>>;
    try {
      google = await googlePrefetch();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await telegramNotify(`Morning update: Google fetch failed — ${reason}`);
      throw error;
    }
    dailyTasks = google.tasks;
    const news = await prefetchNewsData();
    dailyNews = news.sections;
    // Everything is prefetched: render in code, no Claude call.
    const text = renderMorningUpdate(new Date(), google.calendarLines, google.taskLines, news.sections);
    await sendMorningUpdate(text, await tryBuildHeadsUpBlock(), dailyTasks, dailyNews);
    return text;
  } else if (isDcaJob(job)) {
    // Searches, quotes and the DCA note are prefetched; one Haiku turn writes the message and the note body.
    const [prefetch, extra] = await Promise.all([prefetchRule("stock market update").catch(() => null), dcaWebSearch()]);
    prompt = `${prompt.trimEnd()}\n\n${DCA_INSTRUCTIONS}\n${prefetch?.block ?? ""}\n${extra}\n`;
    if (job.script) {
      prompt = `${prompt.trimEnd()}\n\n## Script Output\n${runCronScript(job.script)}\n`;
    }
  } else if (job.script) {
    prompt = `${prompt.trimEnd()}\n\n## Script Output\n${runCronScript(job.script)}\n`;
  }
  const { ok, text } = isDcaJob(job) ? await runDcaViaHaiku(prompt) : await runAssistantPrompt(prompt);
  if (!ok) {
    const message = `${job.name} failed: ${text || "agent produced no output"}`;
    await telegramNotify(message);
    throw new Error(message);
  }
  if (text.toUpperCase() === SILENT_OUTPUT) {
    return text;
  }
  if (text) {
    const monthlyReviewJobId = loadNudgesToml().monthlyReviewJobId;
    if (job.id === monthlyReviewJobId) {
      const monthlyReview = await tryBuildMonthlyReviewBlock();
      if (monthlyReview) {
        await telegramNotifyWithButtons(`${text}\n\n${monthlyReview.text}`, nudgeButtonsKeyboard(monthlyReview.buttons));
      } else {
        await telegramNotify(text);
      }
    } else {
      if (job.name.startsWith("DCA Market Update")) {
        const header = dcaHeader(new Date());
        await publishDcaTelegram(`${header}\n\n${withDcaBondLine(withDcaStiLine(cleanDcaBody(text), await fetchYahooQuote("^STI")), await fetchYahooQuote("^TNX"))}`);
      } else {
        await telegramNotify(text);
      }
    }
  }
  return text;
}

/** force runs now without claiming a schedule slot (manual reruns after a slot already fired). */
export async function runCronOnce(jobId: string, force = false): Promise<string> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`unknown cron job: ${jobId}`);
  }
  if (!job.enabled) {
    throw new Error(`cron job is disabled: ${jobId}`);
  }
  if (force || isTriggered(job)) {
    return executeJob(job);
  }
  const slot = latestSlotToday(job.schedule);
  if (slot === null) {
    return SKIPPED_OUTPUT;
  }
  const key = slotKey(slot);
  if (!claimRunSlot(job.id, key)) {
    return SKIPPED_OUTPUT;
  }
  try {
    return await executeJob(job);
  } catch (error) {
    releaseRunSlot(job.id, key);
    throw error;
  }
}
