import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setVideogenRuntime } from "./telegram/videogen_job.js";
import { stopSessionIdleSweep } from "./assistant/claude_session.js";
import { stopPromptCacheRefresh } from "./assistant/system_prompt.js";
import { formatReceipt, friendlyCliOutput } from "./telegram/receipt_text.js";
import { TelegramApi, type TelegramMessage, type TelegramUpdate } from "./telegram/api.js";
import { deliverSegments } from "./telegram/deliver_segments.js";
import { helpText, isBuiltinCommand, parseCommaCommand, resolveCommaBind } from "./telegram/commands.js";
import { logIntercept } from "./telegram/intercept_log.js";
import { statusText } from "./telegram/status.js";
import { dispatchProseIntercept, isConfirmYes } from "./telegram/prose_intercept.js";
import { deleteQuotedStaleWeather } from "./telegram/weather_message.js";
import { attachedImageMime, dispatchImageCaption, isImageActionRequest, readImageForTurn } from "./telegram/image_caption.js";
import { attachedVideo, dispatchVideoCaption } from "./telegram/video_caption.js";
import { handleProseCallback } from "./telegram/prose_callback_handler.js";
import { captionImage, generateVideo, ocrImage, transcribeVoice, understandVideo } from "./media/services.js";
import { synthesizeGoogleVoice } from "./media/tts_google.js";
import { shouldSendVoice, synthesizeMinimaxVoice } from "./media/tts.js";
import { loadTtsSettings } from "./session/settings.js";
import { AssistantPromptQueue, type AssistantPromptJob } from "./session/prompt_queue.js";
import { releaseOrphanTurnLock } from "./session/turn_lock.js";
import { assembleTelegram } from "./telegram/envelope.js";
import {
  createProgressPump,
  EMPTY_INLINE_KEYBOARD,
  formatProgress,
  formatToolAction,
  formatToolStep,
  initialProgressLabel,
  PROGRESS_EDIT_INTERVAL_S,
  WORKING_LABEL,
} from "./telegram/progress_edits.js";
import {
  appendInflightProgress,
  finalizeInflightProgress,
  removeInflightProgress,
  sweepInflightProgressOnBoot,
} from "./telegram/progress_inflight.js";
import { buildAssistantQueueCancelKeyboard, newQueueCancelId, parseQueueCancelCallback } from "./telegram/queue_cancel.js";
import {
  addItems,
  buildShoppingKeyboard,
  replaceItems,
  formatShoppingMessage,
  loadShoppingList,
  parseTextItems,
  parseToggleIndex,
  saveShoppingList,
  toggleItem,
} from "./telegram/shopping_list.js";
import { promoteAndClear, runTurn } from "./assistant/turn.js";
import { confirmFailureText, consumeConfirmation, latestPendingConfirmationCode, type PendingConfirmation } from "./assistant/confirm.js";
import { recordOfferDismissal, recordSave } from "./assistant/conversation_store.js";
import { runWithSourceRef } from "./source_ref.js";
import { hashOfferSavePayload, isSaveSection, melvbotCli, mergeSaveSection } from "./assistant/tools.js";
import { invalidateNoteCachesForWrite } from "./assistant/system_prompt.js";
import { validateProcedureNoteBody } from "./note/note_schema.js";
import { addNote, getNote } from "./note/notes.js";
import {
  DIGEST_LOG_PREFIX,
  EXPIRED_TEXT,
  MONTHLY_REVIEW_PREFIX,
  NUDGE_DONE_PREFIX,
  handleDigestLog,
  handleMonthlyReview,
  handleNudgeDoneSnooze,
  type NudgeCallbackResult,
} from "./nudges/callbacks.js";
import {
  REMINDER_PREFIX,
  TASK_PREFIX,
  applyReminderCallback,
  applyTaskCallback,
  parseReminderCallback,
  parseTaskCallback,
  replaceTaskRow,
} from "./reminders/callbacks.js";
import { patchCachedEvent, reminderTickerState, startReminderTicker, stopReminderTicker } from "./reminders/ticker.js";
import { isHomeChat } from "./telegram/home_chat.js";
import { nextGetUpdatesOffset, writeLastUpdateId } from "./telegram/update_offset.js";

export const TEST_TOKEN_ENV = "MELVBOT__TRANSPORTS__TELEGRAM__TEST_BOT_TOKEN";
export const LIVE_TOKEN_ENV = "MELVBOT__TRANSPORTS__TELEGRAM__BOT_TOKEN";

const GETUPDATES_RETRY_MS = 1_000;
const CONFIRM_YES_PREFIX = "cfy:";
const CONFIRM_NO_PREFIX = "cfn:";

const recentPhotoByChat = new Map<number, { fileId: string; mime: string }>();
let assistantPromptQueue: AssistantPromptQueue | null = null;

function chatKeyFor(chatId: number): string {
  return `telegram:${chatId}`;
}

function getAssistantPromptQueue(api: TelegramApi): AssistantPromptQueue {
  if (!assistantPromptQueue) {
    assistantPromptQueue = new AssistantPromptQueue({
      execute: (job, signal) => executeAssistantTurn(api, job, signal),
      onLockExhausted: (job) => notifyQueueLockExhausted(api, job),
      onCleared: (job) => markJobCancelled(api, job),
      onDequeued: (job) => {
        if (job.progressMessageId !== null) {
          void api.editMessageReplyMarkup(
            job.chatId,
            job.progressMessageId,
            buildAssistantQueueCancelKeyboard(job.id),
          );
        }
      },
    });
  }
  return assistantPromptQueue;
}

export function resolveBotToken(): string {
  if (process.env.MELVBOT_TS_ALLOW_LIVE_TOKEN === "1") {
    const live = process.env[LIVE_TOKEN_ENV]?.trim();
    if (!live) {
      throw new Error(`${LIVE_TOKEN_ENV} required after live cut`);
    }
    return live;
  }
  const token = process.env[TEST_TOKEN_ENV]?.trim();
  if (!token) {
    throw new Error(`${TEST_TOKEN_ENV} is required for the TS daemon until live cut`);
  }
  return token;
}

function rememberPhoto(msg: TelegramMessage): void {
  const mime = attachedImageMime(msg);
  const fromPhoto = msg.photo?.at(-1)?.file_id;
  const fromDoc = msg.document?.mime_type?.startsWith("image/") ? msg.document.file_id : undefined;
  const fileId = fromPhoto ?? fromDoc;
  if (fileId && mime) {
    recentPhotoByChat.set(msg.chat.id, { fileId, mime });
  }
}

function rememberedImageMime(chatId: number): string | null {
  return recentPhotoByChat.get(chatId)?.mime ?? null;
}

async function downloadRememberedPhoto(api: TelegramApi, chatId: number): Promise<Buffer | null> {
  const remembered = recentPhotoByChat.get(chatId);
  if (!remembered) {
    return null;
  }
  recentPhotoByChat.delete(chatId);
  const filePath = await api.getFilePath(remembered.fileId);
  return api.downloadFile(filePath);
}

function sentMessageId(sent: unknown): number | null {
  if (sent && typeof sent === "object" && "message_id" in sent) {
    const id = (sent as { message_id?: unknown }).message_id;
    return typeof id === "number" ? id : null;
  }
  return null;
}

function assembledExtra(
  assembled: { entities: { type: string; offset: number; length: number }[] },
  options?: { clearKeyboard?: boolean; replyMarkup?: { inline_keyboard: unknown[] } },
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (assembled.entities.length) {
    extra.entities = assembled.entities;
  }
  if (options?.replyMarkup) {
    extra.reply_markup = options.replyMarkup;
  } else if (options?.clearKeyboard) {
    extra.reply_markup = EMPTY_INLINE_KEYBOARD;
  }
  return extra;
}

async function postAssembled(
  api: TelegramApi,
  chatId: number,
  assembled: { text: string; entities: { type: string; offset: number; length: number }[] },
  messageId: number | null,
  options?: { clearKeyboard?: boolean; replyMarkup?: { inline_keyboard: unknown[] } },
): Promise<number | null> {
  const extra = assembledExtra(assembled, options);
  if (messageId !== null) {
    const edited = await api.editMessageText(chatId, messageId, assembled.text, extra);
    if (edited !== null) {
      return messageId;
    }
  }
  return sentMessageId(await api.sendMessage(chatId, assembled.text, extra));
}

async function maybeSendVoiceReply(
  api: TelegramApi,
  chatId: number,
  answer: string,
  incomingVoice: boolean,
): Promise<void> {
  const tts = loadTtsSettings();
  if (!tts.enabled || !shouldSendVoice(tts.auto, incomingVoice) || !answer.trim()) {
    return;
  }
  try {
    let spoken: { bytes: Buffer; filename: string };
    if (tts.provider === "minimax") {
      const apiKey = process.env.MINIMAX_API_KEY?.trim() ?? "";
      if (!apiKey) {
        return;
      }
      spoken = await synthesizeMinimaxVoice({
        text: answer,
        voice: tts.voice,
        model: tts.model,
        apiKey,
        baseUrl: tts.baseUrl,
      });
    } else {
      spoken = await synthesizeGoogleVoice({
        text: answer,
        voice: tts.voice,
      });
    }
    await api.sendVoice(chatId, spoken.bytes, spoken.filename);
  } catch (error) {
    console.error("voice_reply.failed", error instanceof Error ? error.message : String(error));
  }
}

async function startProgress(
  api: TelegramApi,
  chatId: number,
  existingId: number | null = null,
  label: string = WORKING_LABEL,
): Promise<number | null> {
  const assembled = formatProgress("", { label });
  const progressId = await postAssembled(api, chatId, assembled, existingId, { clearKeyboard: true });
  if (progressId !== null) {
    appendInflightProgress(chatId, progressId);
  }
  return progressId;
}

async function deliverAnswer(
  api: TelegramApi,
  chatId: number,
  body: string,
  progressId: number | null,
  clearKeyboard = true,
): Promise<void> {
  await deliverSegments(api, chatId, body, progressId, {
    postFirst: (assembled, id) => postAssembled(api, chatId, assembled, id, { clearKeyboard }),
    onProgressDone: (id) => removeInflightProgress(chatId, id),
  });
}

async function publishShoppingList(api: TelegramApi, chatId: number): Promise<void> {
  const data = loadShoppingList();
  const sent = (await api.sendMessage(chatId, formatShoppingMessage(data), {
    reply_markup: buildShoppingKeyboard(data),
  })) as { message_id?: number } | null;
  if (sent?.message_id) {
    data.last_chat_id = chatId;
    data.last_message_id = sent.message_id;
    saveShoppingList(data);
  }
}

const BOOT_MS = Date.now();
let restartRequested = false;

function restartMarkerPath(): string {
  return path.join(process.env.HOME ?? "/home/melvbot", ".melvbot_restart.json");
}

async function announceBackOnline(api: TelegramApi): Promise<void> {
  const file = restartMarkerPath();
  try {
    if (!existsSync(file)) {
      return;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { chat_id?: unknown };
    unlinkSync(file);
    if (typeof parsed.chat_id === "number" && isHomeChat(parsed.chat_id)) {
      await api.sendMessage(parsed.chat_id, "Back online.");
    }
  } catch (error) {
    console.error("restart marker handling failed", error);
  }
}

async function handleCommand(
  api: TelegramApi,
  msg: TelegramMessage,
  command: string,
  args: string,
): Promise<void> {
  const chatId = msg.chat.id;
  logIntercept(`comma:${command}`, args ? `,${command} ${args}` : `,${command}`);
  if (command === "help") {
    await api.sendMessage(chatId, helpText());
    return;
  }
  if (command === "status") {
    await api.sendMessage(chatId, await statusText(BOOT_MS));
    return;
  }
  if (command === "list") {
    const data = loadShoppingList();
    const named = parseTextItems(args);
    if (named.length) {
      addItems(data, named);
      saveShoppingList(data);
    } else {
      const photo = await downloadRememberedPhoto(api, chatId);
      if (photo) {
        const extracted = await ocrImage(photo);
        const parsed = parseTextItems(extracted);
        if (parsed.length) {
          replaceItems(data, parsed);
          saveShoppingList(data);
        }
      }
    }
    await publishShoppingList(api, chatId);
    return;
  }
  if (command === "stop") {
    const queue = getAssistantPromptQueue(api);
    queue.clear();
    queue.cancelInflight();
    await api.sendMessage(chatId, "Stopped.");
    return;
  }
  if (command === "restart") {
    // Ignore a ,r that was sent before this process booted (stale redelivery).
    if (msg.date !== undefined && msg.date * 1000 < BOOT_MS - 5000) {
      return;
    }
    await api.sendMessage(chatId, "Restarting…");
    try {
      mkdirSync(path.dirname(restartMarkerPath()), { recursive: true });
      writeFileSync(restartMarkerPath(), `${JSON.stringify({ chat_id: chatId })}\n`);
    } catch (error) {
      console.error("restart marker write failed", error);
    }
    const queue = getAssistantPromptQueue(api);
    queue.clear();
    queue.cancelInflight();
    restartRequested = true; // pollLoop persists the update offset, then exits
    return;
  }
  if (command === "new") {
    await promoteAndClear(chatKeyFor(chatId));
    await api.sendMessage(chatId, "Started fresh.");
    if (args.trim()) {
      await processTextWithoutCommaCheck(api, msg, args, false);
    }
    return;
  }
  await api.sendMessage(chatId, `Unknown command ,${command}`);
}

async function enqueueAssistantTurn(
  api: TelegramApi,
  chatId: number,
  prompt: string,
  progressMessageId: number | null = null,
  incomingVoice = false,
  ownerId: number | null = null,
  untrustedImageText?: string,
): Promise<void> {
  const queue = getAssistantPromptQueue(api);
  const queueBusy = queue.isRunning() || queue.pendingCount() > 0;
  const label = initialProgressLabel(queueBusy);
  const progressId = await startProgress(api, chatId, progressMessageId, label);
  const jobId = queue.enqueue({
    chatId,
    chatKey: chatKeyFor(chatId),
    prompt,
    untrustedImageText,
    progressMessageId: progressId,
    incomingVoice,
    ownerId,
  });
  if (progressId !== null && (queue.isPending(jobId) || queue.activeJob()?.id === jobId)) {
    await api.editMessageReplyMarkup(chatId, progressId, buildAssistantQueueCancelKeyboard(jobId));
  }
}

async function markJobCancelled(api: TelegramApi, job: AssistantPromptJob): Promise<void> {
  if (job.progressMessageId === null) {
    return;
  }
  api.dropPendingEdit(job.chatId, job.progressMessageId);
  removeInflightProgress(job.chatId, job.progressMessageId);
  await api.editMessageText(job.chatId, job.progressMessageId, "Cancelled.", {
    reply_markup: EMPTY_INLINE_KEYBOARD,
  });
}

async function notifyQueueLockExhausted(api: TelegramApi, job: AssistantPromptJob): Promise<void> {
  const assembled = assembleTelegram({ body: "Assistant still busy; try again later." });
  if ((await postAssembled(api, job.chatId, assembled, job.progressMessageId)) !== null) {
    return;
  }
  await api.sendMessage(job.chatId, assembled.text, { entities: assembled.entities });
}

function confirmKeyboard(code: string) {
  return {
    inline_keyboard: [
      [
        { text: "Confirm", callback_data: `${CONFIRM_YES_PREFIX}${code}` },
        { text: "Cancel", callback_data: `${CONFIRM_NO_PREFIX}${code}` },
      ],
    ],
  };
}

function saveOfferKeyboard(code: string) {
  return {
    inline_keyboard: [
      [
        { text: "Save", callback_data: `${CONFIRM_YES_PREFIX}${code}` },
        { text: "Dismiss", callback_data: `${CONFIRM_NO_PREFIX}${code}` },
      ],
    ],
  };
}

function keyboardForConfirmation(confirmation: { code: string; action: string }) {
  return confirmation.action === "offer_save" ? saveOfferKeyboard(confirmation.code) : confirmKeyboard(confirmation.code);
}

const TYPING_REFRESH_MS = 4000;

async function executeAssistantTurn(api: TelegramApi, job: AssistantPromptJob, signal: AbortSignal): Promise<void> {
  const { chatId, chatKey, prompt, untrustedImageText, incomingVoice, progressMessageId: progressId } = job;
  let draft = "";
  const startedAt = Date.now();
  const completedSteps: string[] = [];
  let currentAction: string | undefined;
  const elapsedSeconds = () => Math.floor((Date.now() - startedAt) / 1000);
  const progressSnapshot = () => {
    const elapsedS = elapsedSeconds();
    if (draft) {
      return formatProgress(draft, { label: WORKING_LABEL, elapsedS });
    }
    return formatProgress("", {
      label: WORKING_LABEL,
      completedSteps,
      currentAction,
      elapsedS,
    });
  };
  const pushProgress = () => {
    pump.push(progressSnapshot());
  };
  let typingActive = true;
  void (async () => {
    while (typingActive && !signal.aborted) {
      await api.sendChatAction(chatId, "typing");
      await new Promise<void>((resolve) => setTimeout(resolve, TYPING_REFRESH_MS));
    }
  })();
  const pump = createProgressPump(
    (assembled) => {
      if (progressId === null) {
        return Promise.resolve(null);
      }
      const extra = assembledExtra(assembled);
      extra.reply_markup = buildAssistantQueueCancelKeyboard(job.id);
      return api.editMessageText(chatId, progressId, assembled.text, extra);
    },
    {
      intervalS: PROGRESS_EDIT_INTERVAL_S,
      snapshot: progressSnapshot,
    },
  );
  pump.start();
  try {
    const result = await runTurn({
      chatKey,
      prompt,
      untrustedImageText,
      signal,
      source: "telegram",
      onText: (text) => {
        // `text` is the whole current round (streamed deltas); the pump's heartbeat shows it at the edit rate limit.
        const first = draft === "";
        draft = text;
        currentAction = undefined;
        if (first) {
          pushProgress();
        } else {
          pump.schedule(progressSnapshot());
        }
      },
      onStatus: (update) => {
        if (update.kind === "tool_running") {
          draft = ""; // text before a tool call is replaced by the tool step
        } else if (draft) {
          return;
        }
        if (update.kind === "thinking") {
          currentAction = "thinking…";
        } else if (update.kind === "tool_running") {
          currentAction = formatToolAction(update.name, update.args);
        } else {
          const step = formatToolStep(update.name, update.args);
          if (!completedSteps.includes(step)) {
            completedSteps.push(step);
          }
        }
        pushProgress();
      },
    });
    typingActive = false;
    await pump.stop();
    if (result.status === "pending_confirmation" && result.pendingConfirmation) {
      const confirmation = result.pendingConfirmation;
      const answer = result.text.trim();
      const body = answer ? `${answer}\n\n${confirmation.summary}` : confirmation.summary;
      const assembled = assembleTelegram({ body });
      const messageId = await postAssembled(api, chatId, assembled, progressId, {
        replyMarkup: keyboardForConfirmation(confirmation),
      });
      if (messageId !== null && progressId !== null) {
        removeInflightProgress(chatId, progressId);
      }
      return;
    }
    await deliverAnswer(api, chatId, result.text.trim(), progressId, true);
    await maybeSendVoiceReply(api, chatId, result.text.trim(), incomingVoice);
  } catch (error) {
    typingActive = false;
    await pump.stop();
    if (signal.aborted) {
      await markJobCancelled(api, job);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const assembled = assembleTelegram({ body: `Assistant failed: ${detail}` });
    if (progressId !== null) {
      await finalizeInflightProgress(api, chatId, progressId, assembled.text, {
        entities: assembled.entities,
      });
      return;
    }
    await api.sendMessage(chatId, assembled.text, { entities: assembled.entities });
  }
}

const REPLY_CONTEXT_MAX_CHARS = 2000;

export function withReplyContext(msg: TelegramMessage, text: string): string {
  const quoted = (msg.reply_to_message?.text ?? msg.reply_to_message?.caption ?? "").trim();
  if (!quoted) {
    return text;
  }
  const clipped = quoted.length > REPLY_CONTEXT_MAX_CHARS ? `${quoted.slice(0, REPLY_CONTEXT_MAX_CHARS)}…` : quoted;
  return `[Replying to earlier message:]\n${clipped}\n\n${text}`;
}

async function handlePrompt(
  api: TelegramApi,
  msg: TelegramMessage,
  text: string,
  incomingVoice: boolean,
): Promise<void> {
  const body = resolveCommaBind(text);
  if (body === null) {
    return;
  }
  const prompt = withReplyContext(msg, body);
  await enqueueAssistantTurn(api, msg.chat.id, prompt, null, incomingVoice, msg.from?.id ?? null);
}

const TEXT_DOC_MAX_BYTES = 512 * 1024;
const TEXT_DOC_MAX_CHARS = 60_000;
const TEXT_DOC_EXTENSIONS = /\.(csv|tsv|txt|json|md|log)$/i;
const TEXT_DOC_MIMES = new Set(["application/json", "application/csv"]);

function isTextDocument(doc: NonNullable<TelegramMessage["document"]>): boolean {
  const mime = doc.mime_type ?? "";
  const textual = mime.startsWith("text/") || TEXT_DOC_MIMES.has(mime);
  return (textual || TEXT_DOC_EXTENSIONS.test(doc.file_name ?? "")) && (doc.file_size ?? 0) <= TEXT_DOC_MAX_BYTES;
}

async function appendTextDocument(
  api: TelegramApi,
  doc: NonNullable<TelegramMessage["document"]>,
  written: string,
): Promise<string> {
  const bytes = await api.downloadFile(await api.getFilePath(doc.file_id));
  const content = bytes.toString("utf8").slice(0, TEXT_DOC_MAX_CHARS);
  const name = doc.file_name ?? "attachment";
  const ask = written.trim() || "Analyze this file.";
  return `${ask}\n\n[Attached file: ${name}]\n${content}`;
}

async function resolveIncomingText(api: TelegramApi, msg: TelegramMessage): Promise<string> {
  const written = msg.text ?? msg.caption ?? "";
  if (msg.document && isTextDocument(msg.document)) {
    return appendTextDocument(api, msg.document, written);
  }
  if (written.trim()) {
    return written;
  }
  if (msg.voice) {
    const filePath = await api.getFilePath(msg.voice.file_id);
    const bytes = await api.downloadFile(filePath);
    return transcribeVoice(bytes);
  }
  if (msg.audio) {
    const filePath = await api.getFilePath(msg.audio.file_id);
    const bytes = await api.downloadFile(filePath);
    const transcript = await transcribeVoice(bytes, msg.audio.file_name ?? "audio.mp3");
    if (written.trim()) {
      return `${written}\n\n[Audio transcript]\n${transcript}`;
    }
    return transcript;
  }
  return written;
}

async function processTextWithoutCommaCheck(
  api: TelegramApi,
  msg: TelegramMessage,
  text: string,
  incomingVoice: boolean,
): Promise<void> {
  const video = attachedVideo(msg);
  if (video) {
    void dispatchVideoCaption(api, msg.chat.id, text, video, async () => api.downloadFile(await api.getFilePath(video.fileId)), understandVideo).catch((error) => {
      console.error("video caption failed", error);
    });
    return;
  }
  if (!text.trim()) {
    return;
  }
  const chatId = msg.chat.id;
  if (isConfirmYes(text)) {
    const code = latestPendingConfirmationCode(chatKeyFor(chatId));
    const confirmation = code ? consumeConfirmation(code) : null;
    if (confirmation) {
      logIntercept("confirm", text);
      await api.sendMessage(chatId, await executeConfirmation(confirmation, confirmation.code));
      return;
    }
  }
  if (
    await dispatchProseIntercept(api, msg, text, {
      downloadRememberedPhoto: (targetChatId) => downloadRememberedPhoto(api, targetChatId),
      ocrImage,
    })
  ) {
    return;
  }
  const imageMime = attachedImageMime(msg) ?? rememberedImageMime(chatId);
  if (imageMime && isImageActionRequest(text)) {
    // Needs the tools: OCR here, then a normal Claude turn with the text as untrusted context.
    void (async () => {
      const ocr = await readImageForTurn(api, chatId, imageMime, () => downloadRememberedPhoto(api, chatId), ocrImage);
      const body = resolveCommaBind(text);
      if (ocr === null || body === null) {
        return;
      }
      await enqueueAssistantTurn(api, chatId, body, null, false, msg.from?.id ?? null, ocr);
    })().catch((error) => {
      console.error("image action failed", error);
    });
    return;
  }
  if (imageMime) {
    void dispatchImageCaption(
      api,
      chatId,
      text,
      imageMime,
      () => downloadRememberedPhoto(api, chatId),
      captionImage,
    ).catch((error) => {
      console.error("image caption failed", error);
    });
    return;
  }
  await handlePrompt(api, msg, text, incomingVoice);
}

export async function handleIncoming(api: TelegramApi, msg: TelegramMessage): Promise<void> {
  rememberPhoto(msg);
  await deleteQuotedStaleWeather(api, msg.chat.id, msg.reply_to_message);
  const incomingVoice = Boolean(msg.voice);
  const text = await resolveIncomingText(api, msg);
  const parsed = parseCommaCommand(text);
  if (parsed.command && isBuiltinCommand(parsed.command)) {
    await handleCommand(api, msg, parsed.command, parsed.args);
    return;
  }
  if (parsed.command) {
    await api.sendMessage(msg.chat.id, "not a command");
    return;
  }
  await processTextWithoutCommaCheck(api, msg, text, incomingVoice);
}

async function applySaveOffer(payload: unknown, chatKey: string): Promise<string> {
  const fields = payload as { slug?: unknown; section?: unknown; text?: unknown; payloadHash?: unknown } | undefined;
  const slug = fields?.slug;
  const section = fields?.section;
  const text = fields?.text;
  const payloadHash = fields?.payloadHash;
  if (typeof slug !== "string" || typeof section !== "string" || typeof text !== "string" || !isSaveSection(section)) {
    return "Failed: malformed save offer.";
  }
  if (typeof payloadHash === "string" && payloadHash !== hashOfferSavePayload(slug, section, text)) {
    return "Failed: save offer payload changed since it was posted.";
  }
  try {
    const note = await getNote(slug);
    const body = mergeSaveSection(note.body, section, text);
    validateProcedureNoteBody(slug, body, note.body);
    const result = await addNote({
      slug: note.slug,
      title: note.title,
      body,
      tags: note.tags,
      expectRevisionId: note.revision_id,
      changeAction: "offer_save",
      chatKey,
    });
    invalidateNoteCachesForWrite(["note", "add", note.slug]);
    recordSave(true);
    if (result.receipt) {
      return formatReceipt(result.receipt);
    }
    return "Saved.";
  } catch (error) {
    return confirmFailureText(error);
  }
}

/**
 * A confirmation can sit while the Note gains other revisions (e.g. History
 * lines). replace-section only touches one section, so refresh --expect-rev
 * to the current revision instead of failing on a stale one.
 */
async function rebaseSectionRevision(args: string[]): Promise<string[]> {
  const revIndex = args.indexOf("--expect-rev");
  if (args[0] !== "note" || (args[1] !== "replace-section" && args[1] !== "replace-text") || !args[2] || revIndex === -1 || revIndex + 1 >= args.length) {
    return args;
  }
  const current = await getNote(args[2]);
  const next = [...args];
  next[revIndex + 1] = current.revision_id;
  return next;
}

/** Runs a consumed confirmation (button tap or bare "yes") and returns the result text. */
async function executeConfirmation(confirmation: PendingConfirmation, code: string): Promise<string> {
  let text: string;
  const confirmSourceRef = `tg:${confirmation.chatKey}:confirm:${code}`;
  if (confirmation.action === "offer_save") {
    text = await runWithSourceRef(confirmSourceRef, () => applySaveOffer(confirmation.payload, confirmation.chatKey));
  } else {
    const args = (confirmation.payload as { args?: unknown } | undefined)?.args;
    if (Array.isArray(args) && args.every((value) => typeof value === "string")) {
      try {
        const cliArgs = await rebaseSectionRevision(args as string[]);
        const result = await runWithSourceRef(confirmSourceRef, () => melvbotCli(cliArgs, { chatKey: confirmation.chatKey }));
        invalidateNoteCachesForWrite(cliArgs);
        text = friendlyCliOutput(result.stdout) || "Done.";
      } catch (error) {
        text = confirmFailureText(error);
      }
    } else {
      text = "Confirmed.";
    }
  }
  return text;
}

async function handleConfirmCallback(
  api: TelegramApi,
  update: NonNullable<TelegramUpdate["callback_query"]>,
  code: string,
  confirmed: boolean,
): Promise<boolean> {
  const chatId = update.message?.chat.id;
  const messageId = update.message?.message_id;
  const confirmation = consumeConfirmation(code);
  if (!confirmation) {
    if (chatId !== undefined && messageId !== undefined) {
      await api.editMessageText(chatId, messageId, "Expired, ask me again.", { reply_markup: EMPTY_INLINE_KEYBOARD });
    }
    await api.answerCallback(update.id, "expired");
    return true;
  }
  if (chatId === undefined || messageId === undefined || confirmation.chatKey !== chatKeyFor(chatId)) {
    await api.answerCallback(update.id, "expired");
    return true;
  }
  if (!confirmed) {
    if (confirmation.action === "offer_save") {
      const fields = confirmation.payload as { slug?: unknown; section?: unknown } | undefined;
      if (typeof fields?.slug === "string" && typeof fields.section === "string") {
        recordOfferDismissal(fields.slug, fields.section);
      }
      recordSave(false);
    }
    await api.editMessageText(chatId, messageId, "Cancelled.", { reply_markup: EMPTY_INLINE_KEYBOARD });
    await api.answerCallback(update.id);
    return true;
  }
  const text = await executeConfirmation(confirmation, code);
  await api.editMessageText(chatId, messageId, text, { reply_markup: EMPTY_INLINE_KEYBOARD });
  await api.answerCallback(update.id);
  return true;
}

/**
 * Nudges are bundled into a larger message (Morning Update, a digest, the
 * monthly-1st post) alongside other buttons, so a tap never edits that
 * message's text — it only marks state and answers with a toast. The one
 * exception is the digest Log flow's `show` step, which opens a small
 * card-choice keyboard scoped to that single receipt.
 */
async function handleNudgeCallback(
  api: TelegramApi,
  update: NonNullable<TelegramUpdate["callback_query"]>,
  data: string,
): Promise<boolean> {
  let result: NudgeCallbackResult | null = null;
  if (data.startsWith(NUDGE_DONE_PREFIX)) {
    result = handleNudgeDoneSnooze(data.slice(NUDGE_DONE_PREFIX.length));
  } else if (data.startsWith(DIGEST_LOG_PREFIX)) {
    result = await handleDigestLog(data.slice(DIGEST_LOG_PREFIX.length));
  } else if (data.startsWith(MONTHLY_REVIEW_PREFIX)) {
    result = handleMonthlyReview(data.slice(MONTHLY_REVIEW_PREFIX.length));
  } else {
    return false;
  }
  if (result === null) {
    await api.answerCallback(update.id, EXPIRED_TEXT);
    return true;
  }
  const chatId = update.message?.chat.id;
  if (result.keyboard && chatId !== undefined) {
    // The full text is already going out as its own message below, so the
    // toast just confirms the tap rather than repeating it.
    await api.sendMessage(chatId, result.text, { reply_markup: result.keyboard });
    await api.answerCallback(update.id);
    return true;
  }
  await api.answerCallback(update.id, result.text);
  return true;
}

/** `rm:` Done / Snooze on a reminder alert: Google stays the truth, the message is edited to match. */
async function handleReminderCallback(
  api: TelegramApi,
  update: NonNullable<TelegramUpdate["callback_query"]>,
  data: string,
): Promise<void> {
  const parsed = parseReminderCallback(data.slice(REMINDER_PREFIX.length));
  const chatId = update.message?.chat.id;
  const messageId = update.message?.message_id;
  if (!parsed) {
    await api.answerCallback(update.id, EXPIRED_TEXT);
    return;
  }
  try {
    const result = await applyReminderCallback(parsed, update.message?.text ?? "");
    if (result.moved) {
      const state = reminderTickerState();
      if (state) {
        patchCachedEvent(state, result.moved);
      }
    }
    if (chatId !== undefined && messageId !== undefined) {
      await api.editMessageText(chatId, messageId, result.text, { reply_markup: EMPTY_INLINE_KEYBOARD });
    }
    await api.answerCallback(update.id);
  } catch (error) {
    console.error("reminder_callback_failed", error instanceof Error ? error.message : String(error));
    await api.answerCallback(update.id, "Google update failed");
  }
}

/** `tk:` complete / move-to-tomorrow on a task button; the tapped row is swapped for its outcome. */
async function handleTaskCallback(
  api: TelegramApi,
  update: NonNullable<TelegramUpdate["callback_query"]>,
  data: string,
): Promise<void> {
  const parsed = parseTaskCallback(data.slice(TASK_PREFIX.length));
  if (!parsed) {
    await api.answerCallback(update.id, EXPIRED_TEXT);
    return;
  }
  if (parsed.action === "noop") {
    await api.answerCallback(update.id);
    return;
  }
  const chatId = update.message?.chat.id;
  const messageId = update.message?.message_id;
  const keyboard = (update.message?.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => ({ text: button.text, callback_data: button.callback_data ?? "" })),
  );
  const tapped = keyboard.find((row) => row.some((button) => button.callback_data === data));
  try {
    const outcome = await applyTaskCallback(parsed, tapped?.[0]?.text ?? "task");
    if (chatId !== undefined && messageId !== undefined && tapped) {
      await api.editMessageReplyMarkup(chatId, messageId, {
        inline_keyboard: replaceTaskRow(keyboard, parsed.taskId, outcome.row),
      });
    }
    await api.answerCallback(update.id, outcome.toast);
  } catch (error) {
    console.error("task_callback_failed", error instanceof Error ? error.message : String(error));
    await api.answerCallback(update.id, "Google update failed");
  }
}

export async function handleCallback(
  api: TelegramApi,
  update: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  if (await handleProseCallback(api, update)) {
    return;
  }
  const data = update.data ?? "";
  if (data.startsWith(CONFIRM_YES_PREFIX)) {
    await handleConfirmCallback(api, update, data.slice(CONFIRM_YES_PREFIX.length), true);
    return;
  }
  if (data.startsWith(CONFIRM_NO_PREFIX)) {
    await handleConfirmCallback(api, update, data.slice(CONFIRM_NO_PREFIX.length), false);
    return;
  }
  if (data.startsWith(REMINDER_PREFIX)) {
    await handleReminderCallback(api, update, data);
    return;
  }
  if (data.startsWith(TASK_PREFIX)) {
    await handleTaskCallback(api, update, data);
    return;
  }
  if (await handleNudgeCallback(api, update, data)) {
    return;
  }
  const queueCancel = parseQueueCancelCallback(data);
  if (queueCancel) {
    const queue = getAssistantPromptQueue(api);
    const pending = queue.findPending(queueCancel.id);
    const active = queue.activeJob();
    if (!pending && active?.id !== queueCancel.id) {
      await api.answerCallback(update.id, "already started");
      return;
    }
    const ownerId = pending?.ownerId ?? active?.ownerId ?? null;
    if (ownerId !== null && update.from.id !== ownerId) {
      await api.answerCallback(update.id, "not yours");
      return;
    }
    if (pending) {
      if (!queue.drop(queueCancel.id)) {
        if (queue.requestInflightStop(queueCancel.id)) {
          await api.answerCallback(update.id);
          return;
        }
        await api.answerCallback(update.id, "already started");
        return;
      }
      await api.answerCallback(update.id);
      return;
    }
    queue.requestInflightStop(queueCancel.id);
    await api.answerCallback(update.id);
    return;
  }
  const index = parseToggleIndex(data);
  if (index === null) {
    await api.answerCallback(update.id);
    return;
  }
  const shoppingData = toggleItem(loadShoppingList(), index);
  saveShoppingList(shoppingData);
  const chatId = update.message?.chat.id;
  const messageId = update.message?.message_id;
  if (chatId !== undefined && messageId !== undefined) {
    await api.editMessageText(chatId, messageId, formatShoppingMessage(shoppingData), {
      reply_markup: buildShoppingKeyboard(shoppingData),
    });
  }
  await api.answerCallback(update.id);
}

export async function pollLoop(api: TelegramApi): Promise<void> {
  releaseOrphanTurnLock();
  await sweepInflightProgressOnBoot(api);
  setVideogenRuntime({ api, generate: generateVideo });
  await announceBackOnline(api);
  startReminderTicker(api);
  let offset = nextGetUpdatesOffset();
  for (;;) {
    let updates;
    try {
      updates = await api.getUpdates(offset, 50);
    } catch (error) {
      console.error("getUpdates failed", error);
      await new Promise((resolve) => setTimeout(resolve, GETUPDATES_RETRY_MS));
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id;
      if (!isHomeChat(chatId)) {
        writeLastUpdateId(update.update_id);
        continue;
      }
      try {
        if (update.callback_query) {
          console.log("telegram_callback", update.update_id);
          await handleCallback(api, update.callback_query);
        } else if (update.message) {
          console.log("telegram_update", update.update_id);
          await handleIncoming(api, update.message);
        }
      } catch (error) {
        console.error("update failed", error);
      }
      writeLastUpdateId(update.update_id);
      if (restartRequested) {
        // Offset is persisted above, so the ,r is not redelivered; non-zero exit makes Docker (restart: unless-stopped) restart us.
        stopSessionIdleSweep();
        stopPromptCacheRefresh();
        stopReminderTicker();
        process.exit(1);
      }
    }
  }
}
