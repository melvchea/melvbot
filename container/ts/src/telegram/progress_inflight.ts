import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROGRESS_INFLIGHT_FILENAME = "progress_inflight.json";
export const RESTART_INTERRUPT_BODY =
  "Turn interrupted by restart — no result saved. Send your message again.";

export type InflightEntry = {
  chatId: number;
  messageId: number;
};

export type ProgressFinalizeApi = {
  sendMessage(chatId: number, text: string, extra?: Record<string, unknown>): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
  dropPendingEdit(chatId: number, messageId: number): void;
};

type InflightStore = Record<string, number[]>;

export function progressInflightPath(): string {
  const dir = process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config";
  return path.join(dir, PROGRESS_INFLIGHT_FILENAME);
}

function loadStore(filePath = progressInflightPath()): InflightStore {
  if (!existsSync(filePath)) {
    return {};
  }
  return JSON.parse(readFileSync(filePath, "utf8")) as InflightStore;
}

function saveStore(store: InflightStore, filePath = progressInflightPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, filePath);
}

export function appendInflightProgress(chatId: number, messageId: number): void {
  const filePath = progressInflightPath();
  const store = loadStore(filePath);
  const key = String(chatId);
  const list = store[key] ?? [];
  list.push(messageId);
  store[key] = list;
  saveStore(store, filePath);
}

export function removeInflightProgress(chatId: number, messageId: number): void {
  const filePath = progressInflightPath();
  const store = loadStore(filePath);
  const key = String(chatId);
  const list = store[key];
  if (!list) {
    return;
  }
  const next = list.filter((id) => id !== messageId);
  if (next.length === 0) {
    delete store[key];
  } else {
    store[key] = next;
  }
  saveStore(store, filePath);
}

export function listInflightProgress(): InflightEntry[] {
  const store = loadStore();
  const entries: InflightEntry[] = [];
  for (const [chatIdStr, messageIds] of Object.entries(store)) {
    const chatId = Number(chatIdStr);
    for (const messageId of messageIds) {
      entries.push({ chatId, messageId });
    }
  }
  return entries;
}

export async function finalizeInflightProgress(
  api: ProgressFinalizeApi,
  chatId: number,
  messageId: number,
  body: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await api.sendMessage(chatId, body, extra);
  } catch (error) {
    console.error(
      "finalizeInflight.send_failed",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  removeInflightProgress(chatId, messageId);
  api.dropPendingEdit(chatId, messageId);
  try {
    await api.deleteMessage(chatId, messageId);
  } catch {
    /* keep the working message if delete is denied */
  }
}

export async function sweepInflightProgressOnBoot(api: ProgressFinalizeApi): Promise<void> {
  for (const entry of listInflightProgress()) {
    await finalizeInflightProgress(api, entry.chatId, entry.messageId, RESTART_INTERRUPT_BODY);
  }
}
