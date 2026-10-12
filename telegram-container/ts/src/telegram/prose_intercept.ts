import { displayNames, vehicleName } from "../profile.js";
import { undoLastChange } from "../memory/undo.js";
import { tasksList, type CalendarEventJson, type TaskJson } from "../google/http.js";
import { listMergedAgenda } from "../reminders/agenda.js";
import { formatEventLines, formatRecurringLine, formatRemindersReply, formatTaskLines, sgtToday } from "../reminders/format.js";
import { listCronJobs, type CronJob } from "../cron/store.js";
import { matchReminderLookup, matchRemindersProse } from "./reminders_prose.js";
import { calendarWindow, formatCalendarReply, formatTasksReply, matchAgendaProse } from "./agenda_prose.js";
import type { TelegramApi, TelegramMessage } from "./api.js";
import { attachedImageMime } from "./image_caption.js";
import { soleNonemptyLineStripped } from "./prose_line.js";
import {
  applyNoteRename,
  noteDeleteCard,
  noteCombineMissingTargetReply,
  noteLinkReply,
  noteListReply,
  parseNoteCombineDirective,
  parseNoteDeleteDirective,
  parseNoteLinkDirective,
  parseNoteListDirective,
  parseNoteRenameDirective,
  planNoteCombine,
  planNoteDelete,
  resolveNoteSlug,
} from "../note/note_prose.js";
import {
  applySheetRename,
  parseSheetActionDirective,
  parseSheetLinkDirective,
  parseSheetListDirective,
  parseSheetRenameDirective,
  sheetLabel,
  sheetActionCard,
  sheetLinkReply,
  sheetListReply,
} from "../sheet/sheet_prose.js";
import { matchImagegenProse } from "./imagegen_prose.js";
import { matchVideogenProse } from "./videogen_prose.js";
import { startVideogenJob } from "./videogen_job.js";
import { matchOcrProse } from "./ocr_prose.js";
import { formatWeatherMessage } from "./weather.js";
import { publishWeatherMessage } from "./weather_message.js";
import { matchWeatherProse } from "./weather_prose.js";
import { matchUndoProse, undoReply } from "./undo_prose.js";
import { logIntercept, withTimeout } from "./intercept_log.js";
import { type LinkListMessage } from "./link_list.js";
import { buildEvAddKeyboard, buildNoteCombineKeyboard, buildSpendAddKeyboard, buildSpendEditKeyboard, storeEvAddOffer, storeSpendAddOffer, storeSpendEditOffer } from "./prose_callbacks.js";
import { previewSpendEntries, spendConfirmText, spendLabel, writeSpendEntries, type SpendAddDeps } from "./spend_add.js";
import { planSpendEdit } from "./spend_edit.js";
import type { SpendCard } from "../sheet/spend_cycle.js";
import { deliverSegments } from "./deliver_segments.js";
import { dateReply, matchDateProse } from "./date_prose.js";
import { previewEvEntry, writeEvEntry, type EvAddDeps } from "./ev_add.js";
import { evShowReply, parseEvAddDirective, parseEvShowDirective, type EvAddDirective } from "../sheet/ev_prose.js";
import { parseSpendOps, parseSpendShowDirective, spendCardAsk, spendShowReply, type SpendAddEntry, type SpendOp } from "../sheet/spend_prose.js";

export { soleNonemptyLineStripped } from "./prose_line.js";

async function sendLinkList(api: TelegramApi, chatId: number, message: LinkListMessage): Promise<void> {
  const extra = message.entities.length ? { entities: message.entities } : undefined;
  await api.sendMessage(chatId, message.text, extra);
}

async function sendSheetRich(api: TelegramApi, chatId: number, body: string): Promise<void> {
  await deliverSegments(api, chatId, body, null);
}

/** A bare yes/ok/y/confirm (any case, trailing punctuation): answers a pending confirmation without a Claude call. */
export function isConfirmYes(text: string): boolean {
  return /^\s*(?:yes|ok|y|confirm)\s*[.!]*\s*$/i.test(text);
}

export type ProseInterceptDeps = {
  listEvents?: (startIso: string, endIso: string) => Promise<CalendarEventJson[]>;
  listTasks?: () => Promise<TaskJson[]>;
  listJobs?: () => CronJob[];
  downloadRememberedPhoto?: (chatId: number) => Promise<Buffer | null>;
  ocrImage?: (bytes: Buffer) => Promise<string>;
  generateImage?: (prompt: string) => Promise<Buffer>;
  generateVideo?: (prompt: string) => Promise<Buffer>;
  formatWeather?: () => Promise<string>;
  spendAdd?: SpendAddDeps;
  evAdd?: EvAddDeps;
};

/** Timeout for the external reads (Google, weather, OCR) behind an instant reply. */
const EXTERNAL_MS = 25_000;

/**
 * Runs the first matching non-LLM intercept from INTERCEPTS (OCR, weather, agenda, reminders, imagegen,
 * videogen, the single-line note/sheet/spend directives, then spend add).
 * Failures are logged and answered with a short error instead of escaping as a rejection.
 */
export async function dispatchProseIntercept(
  api: TelegramApi,
  msg: TelegramMessage,
  text: string,
  deps: ProseInterceptDeps,
): Promise<boolean> {
  const state = { name: "" };
  const started = Date.now();
  try {
    const handled = await dispatchInner(api, msg, text, deps, state);
    if (handled) {
      logIntercept(state.name, text, Date.now() - started);
    }
    return handled;
  } catch (error) {
    console.error("prose intercept failed", state.name, error);
    await api.sendMessage(msg.chat.id, "That didn't work, try again in a moment.");
    return true;
  }
}
type InterceptCtx = {
  api: TelegramApi;
  chatId: number;
  ownerId: number | null;
  deps: ProseInterceptDeps;
  state: { name: string };
};

type Intercept = {
  name: string;
  /** "text" matchers see the whole message; "line" matchers see its sole non-empty line (none: skipped). */
  scope: "text" | "line";
  /** The parsed directive, or null/false/undefined for no match. */
  match: (input: string) => unknown;
  /** Returns false to fall through to Claude (e.g. a missing dependency). */
  handle: (ctx: InterceptCtx, matched: never) => Promise<boolean>;
};

function entry<M>(
  name: string,
  scope: "text" | "line",
  match: (input: string) => M | null | false | undefined,
  handle: (ctx: InterceptCtx, matched: M) => Promise<boolean>,
): Intercept {
  return { name, scope, match, handle: handle as Intercept["handle"] };
}

function isHit(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

/**
 * Ordered intercept table, shared by the dispatcher and wouldDispatchProseIntercept. Matchers are
 * whole-message anchored, so the order only matters for the rare phrase two regexes accept;
 * test/intercept_overlap.test.ts pins those.
 */
const INTERCEPTS: Intercept[] = [
  entry("ocr", "text", (t) => matchOcrProse(t) || null, async ({ api, chatId, deps, state }) => {
    state.name = "ocr";
    const download = deps.downloadRememberedPhoto;
    const ocr = deps.ocrImage;
    if (!download || !ocr) {
      return false;
    }
    const photo = await download(chatId);
    if (!photo) {
      await api.sendMessage(chatId, "send a photo first.");
      return true;
    }
    await api.sendMessage(chatId, await withTimeout(ocr(photo), 60_000, "ocr"));
    return true;
  }),
  entry("weather", "text", matchWeatherProse, async ({ api, chatId, deps, state }) => {
    state.name = "weather";
    try {
      const body = await withTimeout((deps.formatWeather ?? formatWeatherMessage)(), EXTERNAL_MS, "weather");
      await publishWeatherMessage(api, chatId, body);
    } catch (error) {
      console.error("weather intercept failed", error);
      await api.sendMessage(chatId, "Could not fetch Singapore weather.");
    }
    return true;
  }),
  entry("agenda", "text", matchAgendaProse, async ({ api, chatId, deps, state }, agenda) => {
    state.name = "agenda";
    try {
      if (agenda.kind === "calendar") {
        const window = calendarWindow(agenda.range);
        const events = await withTimeout((deps.listEvents ?? ((start, end) => listMergedAgenda(start, end, 50)))(window.start, window.end), EXTERNAL_MS, "calendar");
        await api.sendMessage(chatId, formatCalendarReply(events, agenda.range, window.firstDay));
      } else {
        await api.sendMessage(chatId, formatTasksReply(await withTimeout((deps.listTasks ?? (() => tasksList(100)))(), EXTERNAL_MS, "tasks")));
      }
    } catch (error) {
      console.error("agenda intercept failed", error);
      await api.sendMessage(chatId, agenda.kind === "calendar" ? "Could not fetch your calendar." : "Could not fetch your tasks.");
    }
    return true;
  }),
  entry("date", "text", matchDateProse, async ({ api, chatId, state }, offset) => {
    state.name = "date";
    await api.sendMessage(chatId, dateReply(offset));
    return true;
  }),
  entry("reminders", "text", (t) => matchRemindersProse(t) || null, async ({ api, chatId, deps, state }) => {
    state.name = "reminders";
    try {
      const from = new Date();
      const [events, tasks] = await withTimeout(
        Promise.all([
          (deps.listEvents ?? ((start, end) => listMergedAgenda(start, end, 50)))(from.toISOString(), new Date(from.getTime() + 7 * 86_400_000).toISOString()),
          (deps.listTasks ?? (() => tasksList(100)))(),
        ]),
        EXTERNAL_MS,
        "reminders",
      );
      const jobs = (deps.listJobs ?? listCronJobs)().filter((job) => job.enabled && job.kind === "agent");
      await api.sendMessage(chatId, formatRemindersReply({ jobs, events, tasks, now: from }));
    } catch (error) {
      console.error("reminders intercept failed", error);
      await api.sendMessage(chatId, "Could not fetch your reminders.");
    }
    return true;
  }),
  entry("reminder_lookup", "text", matchReminderLookup, async ({ api, chatId, deps, state }, words) => {
    const hit = (title: string) => words.every((w) => title.toLowerCase().includes(w));
    try {
      const from = new Date();
      const [events, tasks] = await withTimeout(
        Promise.all([
          (deps.listEvents ?? ((start, end) => listMergedAgenda(start, end, 100)))(from.toISOString(), new Date(from.getTime() + 90 * 86_400_000).toISOString()),
          (deps.listTasks ?? (() => tasksList(100)))(),
        ]),
        EXTERNAL_MS,
        "reminders",
      );
      const jobs = (deps.listJobs ?? listCronJobs)().filter((job) => job.enabled && job.kind === "agent" && hit(job.name));
      const evs = events.filter((e) => hit(e.summary ?? ""));
      const tks = tasks.filter((t) => hit(t.title ?? ""));
      if (!jobs.length && !evs.length && !tks.length) {
        return false;
      }
      state.name = "reminder_lookup";
      const lines = [
        ...jobs.map((job) => formatRecurringLine(job, from)),
        ...formatEventLines(evs, { withDay: true }),
        ...formatTaskLines(tks, sgtToday(from)),
      ];
      await api.sendMessage(chatId, lines.join("\n"));
      return true;
    } catch (error) {
      console.error("reminder lookup failed", error);
      return false;
    }
  }),
  entry("imagegen", "text", matchImagegenProse, async ({ api, chatId, deps, state }, imagePrompt) => {
    state.name = "imagegen";
    const generate = deps.generateImage;
    if (!generate) {
      return false;
    }
    await api.sendMessage(chatId, "Generating…");
    const bytes = await generate(imagePrompt);
    await api.sendPhoto(chatId, bytes, imagePrompt);
    return true;
  }),
  entry("videogen", "text", matchVideogenProse, async ({ api, chatId, deps, state }, videoPrompt) => {
    state.name = "videogen";
    const generate = deps.generateVideo;
    if (!generate) {
      return false;
    }
    await startVideogenJob(api, chatId, videoPrompt, generate);
    return true;
  }),
  entry("undo", "line", (l) => matchUndoProse(l) || null, async ({ api, chatId, state }) => {
    state.name = "undo";
    const result = await withTimeout(undoLastChange(`telegram:${chatId}`), EXTERNAL_MS, "undo");
    await api.sendMessage(chatId, undoReply(result));
    return true;
  }),
  entry("note_list", "line", (l) => parseNoteListDirective(l) || null, async ({ api, chatId, state }) => {
    state.name = "note_list";
    await sendLinkList(api, chatId, await withTimeout(noteListReply(), EXTERNAL_MS, "note list"));
    return true;
  }),
  entry("note_link", "line", (l) => parseNoteLinkDirective(l) || null, async ({ api, chatId, state }, target) => {
    state.name = "note_link";
    await api.sendMessage(chatId, await withTimeout(noteLinkReply(target), EXTERNAL_MS, "note link"));
    return true;
  }),
  entry("note_combine", "line", (l) => parseNoteCombineDirective(l) || null, async ({ api, chatId, ownerId, state }, noteCombine) => {
    state.name = "note_combine";
    if (noteCombine.target === null) {
      await api.sendMessage(chatId, noteCombineMissingTargetReply(noteCombine.left, noteCombine.right));
      return true;
    }
    const plan = await withTimeout(planNoteCombine(noteCombine.left, noteCombine.right, noteCombine.target, ownerId ?? 0), EXTERNAL_MS, "note combine");
    if (plan.kind === "invalid_target") {
      await api.sendMessage(chatId, plan.message);
      return true;
    }
    if (plan.kind === "source_missing") {
      await api.sendMessage(chatId, "No matching source Note.");
      return true;
    }
    if (plan.kind === "ambiguous") {
      await api.sendMessage(chatId, `Ambiguous Note name (${plan.slugs.join(", ")}).`);
      return true;
    }
    await api.sendMessage(chatId, plan.message, { reply_markup: buildNoteCombineKeyboard(plan.nonce) });
    return true;
  }),
  entry("note_rename", "line", (l) => parseNoteRenameDirective(l) || null, async ({ api, chatId, state }, noteRename) => {
    state.name = "note_rename";
    const resolved = await withTimeout(resolveNoteSlug(noteRename.target), EXTERNAL_MS, "note rename");
    if (resolved === null) {
      await api.sendMessage(chatId, "No matching Note.");
      return true;
    }
    if ("ambiguous" in resolved) {
      await api.sendMessage(chatId, `Ambiguous Note name (${resolved.ambiguous.join(", ")}).`);
      return true;
    }
    const result = await withTimeout(applyNoteRename(resolved.slug, noteRename.title), EXTERNAL_MS, "note rename");
    if (result.ok) {
      await api.sendMessage(chatId, `Renamed Google Doc: ${result.oldTitle} → ${result.title}`);
    } else {
      await api.sendMessage(chatId, result.message);
    }
    return true;
  }),
  entry("note_delete", "line", (l) => parseNoteDeleteDirective(l) || null, async ({ api, chatId, ownerId, state }, target) => {
    state.name = "note_delete";
    const plan = await withTimeout(planNoteDelete(target, ownerId ?? 0), EXTERNAL_MS, "note delete");
    if (plan.kind === "refuse") {
      await api.sendMessage(chatId, `Refusing to delete procedure Note: ${plan.slug}.`);
      return true;
    }
    if (plan.kind === "ambiguous") {
      await api.sendMessage(chatId, `Ambiguous Note name (${plan.slugs.join(", ")}).`);
      return true;
    }
    if (plan.kind === "not_found") {
      await api.sendMessage(chatId, "No matching Note.");
      return true;
    }
    const card = noteDeleteCard(plan.slug, ownerId ?? 0);
    await api.sendMessage(chatId, card.text, { reply_markup: card.reply_markup });
    return true;
  }),
  entry("sheet_list", "line", (l) => parseSheetListDirective(l) || null, async ({ api, chatId, state }) => {
    state.name = "sheet_list";
    await sendLinkList(api, chatId, await withTimeout(sheetListReply(), EXTERNAL_MS, "sheet list"));
    return true;
  }),
  entry("sheet_link", "line", (l) => parseSheetLinkDirective(l) || null, async ({ api, chatId, state }, sheetLink) => {
    state.name = "sheet_link";
    await api.sendMessage(chatId, await withTimeout(sheetLinkReply(sheetLink), EXTERNAL_MS, "sheet link"));
    return true;
  }),
  entry("sheet_rename", "line", (l) => parseSheetRenameDirective(l) || null, async ({ api, chatId, state }, sheetRename) => {
    state.name = "sheet_rename";
    const result = await withTimeout(applySheetRename(sheetRename.sheet, sheetRename.title), EXTERNAL_MS, "sheet rename");
    if (result.ok) {
      await api.sendMessage(chatId, `Renamed ${sheetLabel(result.sheet)} to ${result.title}.`);
    } else {
      await api.sendMessage(chatId, result.message);
    }
    return true;
  }),
  entry("sheet_action", "line", (l) => parseSheetActionDirective(l) || null, async ({ api, chatId, ownerId, state }, sheetAction) => {
    if (sheetAction === "ask") {
      await api.sendMessage(chatId, `Name ${displayNames().owner1}, ${displayNames().owner2}, ${vehicleName()}, or LLM pricing.`);
      return true;
    }
    state.name = "sheet_action";
    const card = sheetActionCard(sheetAction, ownerId ?? 0);
    await api.sendMessage(chatId, card.text, { reply_markup: card.reply_markup });
    return true;
  }),
  entry("spend", "line", (l) => parseSpendShowDirective(l) || null, async ({ api, chatId, state }, spendShow) => {
    if (spendShow === "ask") {
      await api.sendMessage(chatId, spendCardAsk());
      return true;
    }
    state.name = "spend";
    await sendSheetRich(api, chatId, await withTimeout(spendShowReply(spendShow), EXTERNAL_MS, "spend"));
    return true;
  }),
  entry("ev", "line", (l) => parseEvShowDirective(l) || null, async ({ api, chatId, state }) => {
    state.name = "ev";
    await sendSheetRich(api, chatId, await withTimeout(evShowReply(), EXTERNAL_MS, "ev"));
    return true;
  }),
  // Multi-line batches need the whole text, so this runs on `text` (after the single-line intercepts).
  entry("ev_add", "text", (t) => parseEvAddDirective(t), handleEvAdd),
  entry("spend_add", "text", (t) => parseSpendOps(t), handleSpendOps),
];

async function handleEvAdd({ api, chatId, ownerId, deps, state }: InterceptCtx, entry: EvAddDirective): Promise<boolean> {
  state.name = "ev_add";
  const evDeps = deps.evAdd ?? {};
  try {
    const confirm = await previewEvEntry(entry, evDeps);
    if (confirm) {
      const nonce = storeEvAddOffer({ entry, chatKey: `telegram:${chatId}`, senderId: ownerId ?? 0 });
      await api.sendMessage(chatId, confirm, { reply_markup: buildEvAddKeyboard(nonce) });
      return true;
    }
    await api.sendMessage(chatId, await writeEvEntry(entry, `telegram:${chatId}`, evDeps));
  } catch (error) {
    console.error("ev add intercept failed", error);
    await api.sendMessage(chatId, `Could not log ${vehicleName()} charge: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

/** Card of the last spend add per chat, for "Vending $2 4 Oct" lines that name none. */
const lastSpendCard = new Map<string, SpendCard>();

async function handleSpendOps(ctx: InterceptCtx, ops: SpendOp[]): Promise<boolean> {
  const { api, chatId } = ctx;
  ctx.state.name = "spend_add";
  const remembered = lastSpendCard.get(`telegram:${chatId}`) ?? null;
  const resolved = ops.map((op) => (op.kind === "add" && !op.card && op.noCard !== "ask" ? { ...op, card: remembered } : op));
  const missing = resolved.find((op) => op.kind === "add" && !op.card);
  if (missing?.kind === "add") {
    if (missing.noCard === "claude") {
      return false;
    }
    await api.sendMessage(chatId, spendCardAsk());
    return true;
  }
  for (const op of resolved) {
    if (op.kind === "add") {
      await handleSpendAdd(ctx, op.card as SpendCard, op.entries);
    } else {
      await handleSpendEdit(ctx, op);
    }
  }
  return true;
}

async function handleSpendEdit(
  { api, chatId, ownerId, deps }: InterceptCtx,
  op: Exclude<SpendOp, { kind: "add" }>,
): Promise<void> {
  const spendDeps = deps.spendAdd ?? {};
  try {
    const plan = await planSpendEdit(op.card, op.kind === "rename" ? { kind: "rename", from: op.from, to: op.to } : { kind: "delete", target: op.target }, spendDeps);
    if (!plan) {
      await api.sendMessage(chatId, `No matching row in ${spendLabel(op.card)}.`);
      return;
    }
    const nonce = storeSpendEditOffer({ argvs: plan.argvs, chatKey: `telegram:${chatId}`, senderId: ownerId ?? 0 });
    await api.sendMessage(chatId, plan.text, { reply_markup: buildSpendEditKeyboard(nonce) });
  } catch (error) {
    console.error("spend edit intercept failed", error);
    await api.sendMessage(chatId, `Could not edit spend: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSpendAdd(
  { api, chatId, ownerId, deps }: InterceptCtx,
  card: SpendCard,
  entries: SpendAddEntry[],
): Promise<void> {
  lastSpendCard.set(`telegram:${chatId}`, card);
  const spendDeps = deps.spendAdd ?? {};
  try {
    const reasons = await previewSpendEntries(card, entries, spendDeps);
    if (reasons.length > 0) {
      const nonce = storeSpendAddOffer({ card, entries, chatKey: `telegram:${chatId}`, senderId: ownerId ?? 0 });
      await api.sendMessage(chatId, spendConfirmText(card, entries, reasons), { reply_markup: buildSpendAddKeyboard(nonce) });
      return;
    }
    await api.sendMessage(chatId, await writeSpendEntries(card, entries, `telegram:${chatId}`, spendDeps));
  } catch (error) {
    console.error("spend add intercept failed", error);
    await api.sendMessage(chatId, `Could not log spend: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const POLITE_LEAD_RE = /^(?:(?:hey|hi|hello|ok|okay)\b[,!]?\s+|(?:pls|please|kindly|(?:can|could|would) (?:you|u))\s+)+/i;
const POLITE_TAIL_RE = /(?:[,\s]+(?:pls|please|thanks|thank you|thx|now|for me))+$/i;

/** A single-line message minus polite filler ("hey, can you show tasks please" -> "show tasks"), or null when nothing changes. */
function relaxPolite(text: string): string | null {
  const line = soleNonemptyLineStripped(text);
  const relaxed = line?.replace(POLITE_LEAD_RE, "").replace(POLITE_TAIL_RE, "").trim();
  return relaxed && relaxed !== line ? relaxed : null;
}

/** First intercept in table order that matches `text` as typed, else with polite filler stripped. */
function findIntercept(text: string): { intercept: Intercept; matched: unknown } | null {
  const relaxed = relaxPolite(text);
  return findExact(text) ?? (relaxed === null ? null : findExact(relaxed));
}

/** First intercept in table order that matches `text` (and its sole line for line-scoped ones). */
function findExact(text: string): { intercept: Intercept; matched: unknown } | null {
  const line = soleNonemptyLineStripped(text);
  for (const intercept of INTERCEPTS) {
    const input = intercept.scope === "text" ? text : line;
    if (input === null) {
      continue;
    }
    const matched = intercept.match(input);
    if (isHit(matched)) {
      return { intercept, matched };
    }
  }
  return null;
}

export async function wouldDispatchProseIntercept(text: string): Promise<boolean> {
  return findIntercept(text) !== null;
}

async function dispatchInner(
  api: TelegramApi,
  msg: TelegramMessage,
  text: string,
  deps: ProseInterceptDeps,
  state: { name: string },
): Promise<boolean> {
  const found = findIntercept(text);
  if (!found) {
    return false;
  }
  if (found.intercept.name === "spend_add" && attachedImageMime(msg) !== null) {
    // An image caption like "store ..." goes to the image action flow (OCR then a Claude turn), not here.
    return false;
  }
  const ctx: InterceptCtx = { api, chatId: msg.chat.id, ownerId: msg.from?.id ?? null, deps, state };
  return found.intercept.handle(ctx, found.matched as never);
}
