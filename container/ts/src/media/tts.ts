export const TTS_MAX_CHARS = 2000;
export const MINIMAX_TTS_MAX_CHARS = 10_000;
export const MINIMAX_TTS_SAMPLE_RATE = 24_000;
export const MINIMAX_TTS_PATH = "t2a_v2";
export const MINIMAX_TTS_TIMEOUT_MS = 120_000;

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const MARKDOWN_CHARS_RE = /[*_~#>]+/g;

export function plainTextForSpeech(text: string): string {
  let cleaned = text.trim();
  if (!cleaned) {
    return "";
  }
  cleaned = cleaned.replace(CODE_FENCE_RE, "");
  cleaned = cleaned.replace(INLINE_CODE_RE, "$1");
  cleaned = cleaned.replace(LINK_RE, "$1");
  cleaned = cleaned.replace(MARKDOWN_CHARS_RE, "");
  return cleaned.replace(/\s+/g, " ").trim();
}

export function shouldSendVoice(auto: "off" | "voice" | "always", incomingVoice: boolean): boolean {
  if (auto === "always") {
    return true;
  }
  if (auto === "voice") {
    return incomingVoice;
  }
  return false;
}

function minimaxT2aUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${MINIMAX_TTS_PATH}`;
}

export async function synthesizeMinimaxVoice(options: {
  text: string;
  voice: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}): Promise<{ bytes: Buffer; filename: string }> {
  const plain = plainTextForSpeech(options.text);
  if (!plain) {
    throw new Error("empty speech text");
  }
  if (!options.apiKey) {
    throw new Error("MiniMax TTS API key not set");
  }
  const trimmed = plain.slice(0, MINIMAX_TTS_MAX_CHARS);
  const response = await fetch(minimaxT2aUrl(options.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      text: trimmed,
      stream: false,
      language_boost: "auto",
      output_format: "hex",
      voice_setting: {
        voice_id: options.voice,
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: MINIMAX_TTS_SAMPLE_RATE,
        format: "opus",
        channel: 1,
      },
    }),
    signal: AbortSignal.timeout(MINIMAX_TTS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`MiniMax TTS HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    base_resp?: { status_code?: number; status_msg?: string };
    data?: { audio?: string };
  };
  const status = body.base_resp?.status_code;
  if (status !== undefined && status !== 0) {
    throw new Error(body.base_resp?.status_msg?.trim() || "MiniMax TTS failed");
  }
  const audioHex = body.data?.audio;
  if (!audioHex) {
    throw new Error("MiniMax TTS returned no audio");
  }
  const bytes = Buffer.from(audioHex, "hex");
  if (!bytes.length) {
    throw new Error("MiniMax TTS returned empty audio");
  }
  return { bytes, filename: "reply.ogg" };
}
