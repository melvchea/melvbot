import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_TTS_VOICE = "English_Graceful_Lady";
export const DEFAULT_GOOGLE_TTS_VOICE = "en-GB-Standard-C";
export const DEFAULT_MINIMAX_TTS_MODEL = "speech-2.8-turbo";
export const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io/v1";
const GOOGLE_TTS_VOICE_MARKERS = ["-Wavenet-", "-Neural2-", "-Standard-", "-Studio-", "-Polyglot-", "-News-", "-Chirp"];

export type TtsProvider = "google" | "minimax";

export type TtsSettings = {
  enabled: boolean;
  provider: TtsProvider;
  voice: string;
  model: string;
  baseUrl: string;
  auto: "off" | "voice" | "always";
};

function parseTtsProvider(raw: string | undefined): TtsProvider {
  if (raw === "google") {
    return "google";
  }
  return "minimax";
}

function selectedVoice(provider: TtsProvider, raw: string | undefined): string {
  if (provider === "google") {
    return googleTtsVoice(raw);
  }
  const voice = raw?.trim();
  return voice || DEFAULT_TTS_VOICE;
}

function googleTtsVoice(raw: string | undefined): string {
  if (raw && GOOGLE_TTS_VOICE_MARKERS.some((marker) => raw.includes(marker))) {
    return raw;
  }
  return DEFAULT_GOOGLE_TTS_VOICE;
}

export function tomlPath(): string {
  return (
    process.env.MELVBOT_TOML ??
    path.join(process.env.HOME ?? "/home/melvbot", ".melvbot", "melvbot.toml")
  );
}

export function parseTomlTable(text: string, header: string): Record<string, string> {
  const lines = text.split("\n");
  let inTable = false;
  const values: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inTable = line === `[${header}]`;
      continue;
    }
    if (!inTable || !line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === "true";
}

export function parseTtsSettings(text: string): TtsSettings {
  const table = parseTomlTable(text, "transports.telegram");
  const auto =
    table.tts_auto === "always" || table.tts_auto === "off" || table.tts_auto === "voice"
      ? table.tts_auto
      : "voice";
  const provider = parseTtsProvider(table.tts_provider);
  return {
    enabled: parseBool(table.tts_enabled, false),
    provider,
    voice: selectedVoice(provider, table.tts_voice),
    model: table.tts_model || DEFAULT_MINIMAX_TTS_MODEL,
    baseUrl: table.tts_base_url || DEFAULT_MINIMAX_TTS_BASE_URL,
    auto,
  };
}

export function loadTtsSettings(path = tomlPath()): TtsSettings {
  if (!existsSync(path)) {
    return parseTtsSettings("");
  }
  return parseTtsSettings(readFileSync(path, "utf8"));
}
