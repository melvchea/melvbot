import {
  DEFAULT_EDIT_MIN_INTERVAL_S,
  EDIT_PRIORITY,
  FALLBACK_RETRY_AFTER_S,
  RetryAfter,
  SEND_PRIORITY,
  TelegramOutbox,
} from "./outbox.js";

const API_ROOT = "https://api.telegram.org";
export const EDIT_MESSAGE_NOT_MODIFIED = "message is not modified";

export function isEditMessageNotModified(
  method: string,
  errorCode: number | undefined,
  description: string | undefined,
): boolean {
  return (
    (method === "editMessageText" || method === "editMessageReplyMarkup") &&
    errorCode === 400 &&
    (description ?? "").includes(EDIT_MESSAGE_NOT_MODIFIED)
  );
}

export type TelegramMessage = {
  date?: number;
  message_id: number;
  chat: { id: number };
  from?: { id: number };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  voice?: { file_id: string };
  photo?: { file_id: string }[];
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  video?: { file_id: string; mime_type?: string; file_size?: number; duration?: number };
  video_note?: { file_id: string; file_size?: number; duration?: number };
  animation?: { file_id: string; mime_type?: string; file_size?: number };
  audio?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number; duration?: number };
  reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] };
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: TelegramMessage;
  };
};

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly outbox = new TelegramOutbox({
      editMinIntervalS: DEFAULT_EDIT_MIN_INTERVAL_S,
    }),
  ) {}

  async getUpdates(offset?: number, timeout = 50): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout,
      allowed_updates: ["message", "callback_query"],
    };
    if (offset !== undefined) {
      payload.offset = offset;
    }
    const result = await this.call("getUpdates", payload, { viaOutbox: false });
    return Array.isArray(result) ? (result as TelegramUpdate[]) : [];
  }

  async sendChatAction(chatId: number, action: "typing" = "typing"): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      // typing is best-effort; flood limits must not fail the turn
    }
  }

  async sendMessage(
    chatId: number,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.outbox.enqueue(`send:${chatId}:${text.slice(0, 24)}`, {
      execute: () =>
        this.call("sendMessage", {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...extra,
        }),
      priority: SEND_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  async sendRichMessage(
    chatId: number,
    richMessage: { markdown: string },
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.outbox.enqueue(`rich:${chatId}:${richMessage.markdown.slice(0, 24)}`, {
      execute: () =>
        this.call("sendRichMessage", {
          chat_id: chatId,
          rich_message: richMessage,
          ...extra,
        }),
      priority: SEND_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    if (extra?.reply_markup !== undefined) {
      // A queued markup-only edit could otherwise run after this one (queuedAt is inherited on replace) and clobber its keyboard.
      this.outbox.drop(`markup:${chatId}:${messageId}`);
    }
    return this.outbox.enqueue(`edit:${chatId}:${messageId}`, {
      execute: () =>
        this.call("editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          disable_web_page_preview: true,
          ...extra,
        }),
      priority: EDIT_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  dropPendingEdit(chatId: number, messageId: number): void {
    this.outbox.drop(`edit:${chatId}:${messageId}`);
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup: { inline_keyboard: unknown[] },
  ): Promise<unknown> {
    return this.outbox.enqueue(`markup:${chatId}:${messageId}`, {
      execute: () =>
        this.call("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: replyMarkup,
        }),
      priority: EDIT_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  dropPendingMarkup(chatId: number, messageId: number): void {
    this.outbox.drop(`markup:${chatId}:${messageId}`);
  }

  async deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    return this.outbox.enqueue(`delete:${chatId}:${messageId}`, {
      execute: () =>
        this.call("deleteMessage", {
          chat_id: chatId,
          message_id: messageId,
        }),
      priority: SEND_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  async answerCallback(id: string, text?: string): Promise<unknown> {
    return this.call("answerCallbackQuery", {
      callback_query_id: id,
      text,
    });
  }

  async getFilePath(fileId: string): Promise<string> {
    const result = (await this.call("getFile", { file_id: fileId })) as { file_path?: string };
    if (!result.file_path) {
      throw new Error("telegram getFile empty");
    }
    return result.file_path;
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const response = await fetch(`${API_ROOT}/file/bot${this.token}/${filePath}`);
    if (!response.ok) {
      throw new Error(`telegram file download HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async sendVoice(
    chatId: number,
    bytes: Buffer,
    filename = "reply.ogg",
    extra?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.outbox.enqueue(`voice:${chatId}:${filename}`, {
      execute: async () => {
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set("voice", new Blob([new Uint8Array(bytes)]), filename);
        for (const [key, value] of Object.entries(extra ?? {})) {
          if (value !== undefined && value !== null) {
            form.set(key, String(value));
          }
        }
        const response = await fetch(`${API_ROOT}/bot${this.token}/sendVoice`, {
          method: "POST",
          body: form,
        });
        const body = (await response.json()) as {
          ok?: boolean;
          result?: unknown;
          error_code?: number;
          parameters?: { retry_after?: unknown };
        };
        if (!body.ok) {
          if (body.error_code === 429 || response.status === 429) {
            const raw = body.parameters?.retry_after;
            const retryAfterS =
              typeof raw === "number" && raw > 0 ? raw : FALLBACK_RETRY_AFTER_S;
            throw new RetryAfter(retryAfterS);
          }
          throw new Error("telegram sendVoice failed");
        }
        return body.result;
      },
      priority: SEND_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  async sendPhoto(chatId: number, bytes: Buffer, caption?: string): Promise<unknown> {
    return this.outbox.enqueue(`photo:${chatId}:${(caption ?? "").slice(0, 24)}`, {
      execute: async () => {
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set("photo", new Blob([new Uint8Array(bytes)]), "image.png");
        if (caption) {
          form.set("caption", caption);
        }
        const response = await fetch(`${API_ROOT}/bot${this.token}/sendPhoto`, {
          method: "POST",
          body: form,
        });
        const body = (await response.json()) as {
          ok?: boolean;
          result?: unknown;
          error_code?: number;
          parameters?: { retry_after?: unknown };
        };
        if (!body.ok) {
          if (body.error_code === 429 || response.status === 429) {
            const raw = body.parameters?.retry_after;
            const retryAfterS =
              typeof raw === "number" && raw > 0 ? raw : FALLBACK_RETRY_AFTER_S;
            throw new RetryAfter(retryAfterS);
          }
          throw new Error("telegram sendPhoto failed");
        }
        return body.result;
      },
      priority: SEND_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  async sendVideo(chatId: number, bytes: Buffer, caption?: string): Promise<unknown> {
    return this.outbox.enqueue(`video:${chatId}:${(caption ?? "").slice(0, 24)}`, {
      execute: async () => {
        const form = new FormData();
        form.set("chat_id", String(chatId));
        form.set("video", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), "video.mp4");
        form.set("supports_streaming", "true");
        if (caption) {
          form.set("caption", caption);
        }
        const response = await fetch(`${API_ROOT}/bot${this.token}/sendVideo`, {
          method: "POST",
          body: form,
        });
        const body = (await response.json()) as {
          ok?: boolean;
          result?: unknown;
          error_code?: number;
          parameters?: { retry_after?: unknown };
        };
        if (!body.ok) {
          if (body.error_code === 429 || response.status === 429) {
            const raw = body.parameters?.retry_after;
            const retryAfterS =
              typeof raw === "number" && raw > 0 ? raw : FALLBACK_RETRY_AFTER_S;
            throw new RetryAfter(retryAfterS);
          }
          throw new Error("telegram sendVideo failed");
        }
        return body.result;
      },
      priority: SEND_PRIORITY,
      queuedAt: performance.now() / 1000,
      chatId,
    });
  }

  async close(): Promise<void> {
    await this.outbox.close();
  }

  private async call(
    method: string,
    payload: Record<string, unknown>,
    options?: { viaOutbox?: boolean },
  ): Promise<unknown> {
    void options;
    const response = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: unknown };
    };
    if (!body.ok) {
      if (body.error_code === 429 || response.status === 429) {
        const raw = body.parameters?.retry_after;
        const retryAfterS =
          typeof raw === "number" && raw > 0 ? raw : FALLBACK_RETRY_AFTER_S;
        throw new RetryAfter(retryAfterS);
      }
      if (isEditMessageNotModified(method, body.error_code, body.description)) {
        return {
          message_id: payload.message_id,
          chat: { id: payload.chat_id },
        };
      }
      throw new Error(`telegram ${method} failed: ${body.description ?? "unknown"}`);
    }
    return body.result;
  }
}
