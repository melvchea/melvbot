import { googleAccessToken } from "../google/token.js";

import { plainTextForSpeech, TTS_MAX_CHARS } from "./tts.js";

export const DEFAULT_GOOGLE_TTS_VOICE = "en-GB-Standard-C";
export const GOOGLE_TTS_SYNTHESIZE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
export const GOOGLE_TTS_TIMEOUT_MS = 60_000;

export function languageCodeFromVoice(voice: string): string {
  for (const marker of ["-Wavenet-", "-Neural2-", "-Standard-", "-Studio-", "-Polyglot-"]) {
    const index = voice.indexOf(marker);
    if (index !== -1) {
      return voice.slice(0, index);
    }
  }
  const parts = voice.split("-");
  if (parts.length >= 2 && parts[1].length === 2) {
    return `${parts[0]}-${parts[1]}`;
  }
  return parts[0] ?? voice;
}

type GoogleTtsAuth =
  | { kind: "api_key"; query: string }
  | { kind: "bearer"; authorization: string };

async function googleTtsAuth(): Promise<GoogleTtsAuth> {
  const apiKey = process.env.GOOGLE_CLOUD_TTS_API_KEY?.trim();
  if (apiKey) {
    return { kind: "api_key", query: `?key=${encodeURIComponent(apiKey)}` };
  }
  const token = await googleAccessToken();
  return { kind: "bearer", authorization: `Bearer ${token}` };
}

export async function synthesizeGoogleVoice(options: {
  text: string;
  voice: string;
}): Promise<{ bytes: Buffer; filename: string }> {
  const plain = plainTextForSpeech(options.text);
  if (!plain) {
    throw new Error("empty speech text");
  }
  const auth = await googleTtsAuth();
  const url =
    auth.kind === "api_key"
      ? `${GOOGLE_TTS_SYNTHESIZE_URL}${auth.query}`
      : GOOGLE_TTS_SYNTHESIZE_URL;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.kind === "bearer") {
    headers.authorization = auth.authorization;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: { text: plain.slice(0, TTS_MAX_CHARS) },
      voice: {
        languageCode: languageCodeFromVoice(options.voice),
        name: options.voice,
      },
      audioConfig: {
        audioEncoding: "OGG_OPUS",
        speakingRate: 1,
      },
    }),
    signal: AbortSignal.timeout(GOOGLE_TTS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google TTS HTTP ${response.status}`);
  }
  const body = (await response.json()) as { audioContent?: string; error?: { message?: string } };
  if (!body.audioContent) {
    throw new Error(body.error?.message?.trim() || "Google TTS returned no audio");
  }
  const bytes = Buffer.from(body.audioContent, "base64");
  if (!bytes.length) {
    throw new Error("Google TTS returned empty audio");
  }
  return { bytes, filename: "reply.ogg" };
}
