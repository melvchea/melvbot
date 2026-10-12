/**
 * Updates are handled only for the configured private home chat.
 * An empty or non-numeric id fails closed: nothing is handled.
 */
export function configuredHomeChatId(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = (
    env.MELVBOT__TRANSPORTS__TELEGRAM__CHAT_ID ??
    env.TELEGRAM_CHAT_ID ??
    ""
  ).trim();
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export function isHomeChat(
  chatId: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const home = configuredHomeChatId(env);
  return home !== null && chatId === home;
}
