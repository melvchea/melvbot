import { randomBytes } from "node:crypto";

export const ASSISTANT_QUEUE_CANCEL_PREFIX = "aq:";
export const QUEUE_CANCEL_BUTTON_TEXT = "Cancel";

export function newQueueCancelId(): string {
  return randomBytes(9).toString("base64url");
}

export function assistantQueueCancelCallbackData(id: string): string {
  return `${ASSISTANT_QUEUE_CANCEL_PREFIX}${id}`;
}

export function buildAssistantQueueCancelKeyboard(id: string) {
  return {
    inline_keyboard: [
      [{ text: QUEUE_CANCEL_BUTTON_TEXT, callback_data: assistantQueueCancelCallbackData(id) }],
    ],
  };
}

export function parseQueueCancelCallback(data: string): { id: string } | null {
  if (data.startsWith(ASSISTANT_QUEUE_CANCEL_PREFIX)) {
    const id = data.slice(ASSISTANT_QUEUE_CANCEL_PREFIX.length);
    return id ? { id } : null;
  }
  return null;
}
