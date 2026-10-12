import type { TelegramApi } from "./api.js";
import { assembleTelegram, type AssembledTelegram } from "./envelope.js";
import { splitRichSegments } from "./rich.js";

export type DeliverHooks = {
  /** Edits the progress message into the first text segment; returns its id (null when nothing was posted). */
  postFirst?: (assembled: AssembledTelegram, progressId: number) => Promise<unknown>;
  /** Called once the progress message has been consumed (replaced or deleted). */
  onProgressDone?: (progressId: number) => void;
};

/**
 * Sends a reply as ordered segments: tables as rich messages, everything else as plain text with Markdown
 * rendered as entities. The first segment consumes the progress message (edited into text, or deleted when rich).
 * A failed rich send falls back to plain text.
 */
export async function deliverSegments(
  api: TelegramApi,
  chatId: number,
  body: string,
  progressId: number | null,
  hooks: DeliverHooks = {},
): Promise<void> {
  let segments = splitRichSegments(body);
  if (segments.length === 0) {
    segments = [{ kind: "text", text: body }];
  }
  let progress = progressId;
  const finishProgress = (): void => {
    if (progress !== null) {
      hooks.onProgressDone?.(progress);
    }
  };
  for (const segment of segments) {
    let kind = segment.kind;
    if (kind === "rich") {
      try {
        await api.sendRichMessage(chatId, { markdown: `${segment.text.trim()}\n` });
        if (progress !== null) {
          finishProgress();
          api.dropPendingEdit(chatId, progress);
          try {
            await api.deleteMessage(chatId, progress);
          } catch {
            /* keep the working message if delete is denied */
          }
          progress = null;
        }
        continue;
      } catch (error) {
        console.error("sendRichMessage failed", error);
        kind = "text";
      }
    }
    const send = async (assembled: AssembledTelegram): Promise<void> => {
      if (progress !== null && hooks.postFirst) {
        await hooks.postFirst(assembled, progress);
        finishProgress();
      } else {
        await api.sendMessage(chatId, assembled.text, assembled.entities.length ? { entities: assembled.entities } : undefined);
      }
    };
    const assembled = assembleTelegram({ body: segment.text, markdown: true });
    try {
      await send(assembled);
    } catch (error) {
      if (!assembled.entities.length) {
        throw error;
      }
      // Rejected entities must not lose the answer: retry once with the raw text (markers kept), no entities.
      console.error("markdown entities rejected, retrying raw", error);
      await send(assembleTelegram({ body: segment.text }));
    }
    progress = null;
  }
}
