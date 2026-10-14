import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const WEATHER_HEADER = "🌤️ Singapore Weather ";

export type WeatherMessageRef = {
  chatId: number;
  messageId: number;
};

export type WeatherPublishApi = {
  sendMessage(chatId: number, text: string): Promise<unknown>;
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
};

export function weatherMessageStatePath(): string {
  const dir = process.env.MELVBOT_CONFIG_DIR ?? "/var/lib/melvbot/config";
  return path.join(dir, "state", "weather-message.json");
}

export function weatherBandPath(): string {
  return path.join(path.dirname(weatherMessageStatePath()), "weather-pm25-band");
}

export function dcaMessageStatePath(): string {
  return path.join(path.dirname(weatherMessageStatePath()), "dca-message.json");
}

export type WeatherWatch = {
  band: string | null;
  raining: boolean;
};

export function readWeatherWatch(filePath = weatherBandPath()): WeatherWatch {
  if (!existsSync(filePath)) {
    return { band: null, raining: false };
  }
  const [bandLine = "", rainLine = ""] = readFileSync(filePath, "utf8").split("\n");
  return { band: bandLine.trim() || null, raining: rainLine.trim() === "rain" };
}

export function writeWeatherWatch(watch: WeatherWatch, filePath = weatherBandPath()): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const rain = watch.raining ? "rain" : "dry";
  writeFileSync(tmp, `${watch.band ?? ""}\n${rain}\n`);
  renameSync(tmp, filePath);
}

export function readWeatherMessageRef(filePath = weatherMessageStatePath()): WeatherMessageRef | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<WeatherMessageRef>;
    if (typeof raw.chatId !== "number" || typeof raw.messageId !== "number") {
      return null;
    }
    return { chatId: raw.chatId, messageId: raw.messageId };
  } catch {
    return null;
  }
}

function writeWeatherMessageRef(ref: WeatherMessageRef, filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ref)}\n`);
  renameSync(tmp, filePath);
}

function sentMessageId(sent: unknown): number | null {
  if (sent && typeof sent === "object" && "message_id" in sent) {
    const id = (sent as { message_id?: unknown }).message_id;
    return typeof id === "number" ? id : null;
  }
  return null;
}

export async function publishReplacingMessage(
  api: WeatherPublishApi,
  chatId: number,
  text: string,
  filePath: string,
): Promise<void> {
  const previous = readWeatherMessageRef(filePath);
  const sent = await api.sendMessage(chatId, text);
  const messageId = sentMessageId(sent);
  if (messageId !== null) {
    writeWeatherMessageRef({ chatId, messageId }, filePath);
  }
  const deletePrior =
    previous !== null && messageId !== null && previous.messageId !== messageId;
  if (!deletePrior || !previous) {
    return;
  }
  try {
    await api.deleteMessage(previous.chatId, previous.messageId);
  } catch {
    /* prior message already gone */
  }
}

export async function publishWeatherMessage(
  api: WeatherPublishApi,
  chatId: number,
  text: string,
  filePath = weatherMessageStatePath(),
): Promise<void> {
  await publishReplacingMessage(api, chatId, text, filePath);
}

export async function deleteQuotedStaleWeather(
  api: Pick<WeatherPublishApi, "deleteMessage">,
  chatId: number,
  reply: { message_id?: number; text?: string } | undefined,
  filePath = weatherMessageStatePath(),
): Promise<void> {
  const messageId = reply?.message_id;
  const text = reply?.text ?? "";
  const quotedWeather = text.startsWith("Singapore Weather ") || text.startsWith(WEATHER_HEADER);
  if (messageId === undefined || !quotedWeather) {
    return;
  }
  const current = readWeatherMessageRef(filePath);
  if (current?.chatId === chatId && current.messageId === messageId) {
    return;
  }
  try {
    await api.deleteMessage(chatId, messageId);
  } catch {
    /* quoted weather message already gone */
  }
}

export function morningMessageStatePath(): string {
  return path.join(path.dirname(weatherMessageStatePath()), "morning-messages.json");
}

export function maintMessageStatePath(): string {
  return path.join(path.dirname(weatherMessageStatePath()), "maint-messages.json");
}

export function outlookMessageStatePath(): string {
  return path.join(path.dirname(weatherMessageStatePath()), "outlook-messages.json");
}

function readMessageIds(filePath: string): { chatId: number; messageIds: number[] } | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as { chatId?: unknown; messageIds?: unknown };
    if (typeof raw.chatId !== "number" || !Array.isArray(raw.messageIds)) {
      return null;
    }
    return { chatId: raw.chatId, messageIds: raw.messageIds.filter((id): id is number => typeof id === "number") };
  } catch {
    return null;
  }
}

/** Records the new messages, then deletes the ones recorded by the previous run. */
export async function replacePriorMessages(
  api: Pick<WeatherPublishApi, "deleteMessage">,
  chatId: number,
  newIds: number[],
  filePath: string,
): Promise<void> {
  const previous = readMessageIds(filePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ chatId, messageIds: newIds })}\n`);
  renameSync(tmp, filePath);
  for (const id of previous?.messageIds ?? []) {
    if (newIds.includes(id)) {
      continue;
    }
    try {
      await api.deleteMessage(previous!.chatId, id);
    } catch {
      /* prior message already gone */
    }
  }
}
