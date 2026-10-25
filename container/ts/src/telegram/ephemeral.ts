export const EPHEMERAL_TTL_MS = 10_000;

type EphemeralApi = {
  sendMessage(chatId: number, text: string): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
};

/** Sends a short status line and deletes it after `ttlMs`; a failed delete (already gone, restart) is ignored. */
export async function sendEphemeral(
  api: EphemeralApi,
  chatId: number,
  text: string,
  ttlMs = EPHEMERAL_TTL_MS,
): Promise<void> {
  const sent = await api.sendMessage(chatId, text);
  const messageId =
    sent && typeof sent === "object" && typeof (sent as { message_id?: unknown }).message_id === "number"
      ? (sent as { message_id: number }).message_id
      : null;
  if (messageId === null) {
    return;
  }
  setTimeout(() => {
    api.deleteMessage(chatId, messageId).catch(() => undefined);
  }, ttlMs).unref();
}
