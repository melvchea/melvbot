import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { subscriptionEnv } from "../assistant/claude_session.js";
import { DEFAULT_MODEL } from "../assistant/toml.js";

const MINIMAX_CHAT = "https://api.minimax.io/v1/chat/completions";
const MINIMAX_VIDEO_GENERATION = "https://api.minimax.io/v1/video_generation";
const MINIMAX_VIDEO_QUERY = "https://api.minimax.io/v1/query/video_generation";
const MINIMAX_VIDEO_RETRIEVE = "https://api.minimax.io/v1/files/retrieve";
const MINIMAX_VISION_MODEL = "MiniMax-M3";
const IMAGE_BYTE_LIMIT = 10 * 1024 * 1024;
const VISION_TIMEOUT_MS = 180_000;
const VISION_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const OCR_PROMPT =
  "Extract all text visible in this image verbatim. Preserve structure, line breaks, and original order. Reply with the extracted text only.";
const OCR_EMPTY = "could not find any text in that photo.";
const IMAGE_EMPTY = "could not read that image.";
const GROQ_STT = "https://api.groq.com/openai/v1/audio/transcriptions";

export function minimaxKey(): string {
  return process.env.MINIMAX_API_KEY?.trim() ?? "";
}

export function groqKey(): string {
  return (
    process.env.MELVBOT__TRANSPORTS__TELEGRAM__VOICE_TRANSCRIPTION_API_KEY?.trim() ||
    process.env.GROQ_API_KEY?.trim() ||
    ""
  );
}

export async function transcribeVoice(bytes: Buffer, filename = "voice.ogg"): Promise<string> {
  const key = groqKey();
  if (!key) {
    throw new Error("GROQ_API_KEY missing");
  }
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)]), filename);
  form.set("model", "whisper-large-v3-turbo");
  const response = await fetch(GROQ_STT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`STT failed HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { text?: string };
  return String(payload.text ?? "").trim();
}

/** Reads an image with Haiku 5.5 on the Claude subscription login (no tools, no session). */
async function understandImage(bytes: Buffer, prompt: string, mime: string, emptyMessage: string): Promise<string> {
  if (!VISION_MIMES.has(mime)) {
    throw new Error("unsupported image type.");
  }
  if (bytes.length > IMAGE_BYTE_LIMIT) {
    throw new Error("image is larger than 10 MB.");
  }
  const media_type = mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  const message: SDKUserMessage = {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type, data: bytes.toString("base64") } },
        { type: "text", text: prompt },
      ],
    },
  };
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield message;
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), VISION_TIMEOUT_MS);
  const run = query({
    prompt: input(),
    options: {
      model: DEFAULT_MODEL,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      env: subscriptionEnv(),
      abortController,
    },
  });
  let text = "";
  try {
    for await (const event of run) {
      if (event.type === "result") {
        if (event.subtype !== "success" || event.is_error) {
          throw new Error(event.subtype === "success" ? event.result : event.errors.join("; "));
        }
        text = event.result.trim();
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!text) {
    throw new Error(emptyMessage);
  }
  return text;
}

export function captionImage(bytes: Buffer, prompt: string, mime: string): Promise<string> {
  return understandImage(bytes, prompt, mime, IMAGE_EMPTY);
}

export function ocrImage(bytes: Buffer, mime = "image/jpeg"): Promise<string> {
  return understandImage(bytes, OCR_PROMPT, mime, OCR_EMPTY);
}

export async function understandVideo(
  bytes: Buffer,
  prompt: string,
  mime = "video/mp4",
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const key = minimaxKey();
  if (!key) {
    throw new Error("MINIMAX_API_KEY missing");
  }
  if (bytes.length > 20 * 1024 * 1024) {
    throw new Error("video is larger than 20 MB.");
  }
  const body = {
    model: MINIMAX_VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          {
            type: "video_url",
            video_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
          },
        ],
      },
    ],
    thinking: { type: "disabled" },
  };
  let response: Response;
  try {
    response = await fetch(MINIMAX_CHAT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("video read timed out.");
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`video failed HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const message = payload.choices?.[0]?.message;
  const raw = message?.content?.trim() ?? "";
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!text) {
    throw new Error("could not read that video.");
  }
  return text;
}

/** MiniMax base_resp codes: 1008 = insufficient balance, 1004 = auth, 1002/1039 = rate limit. */
function videoFailureMessage(code: number | undefined, msg: string): string {
  if (code === 1008 || /insufficient balance/i.test(msg)) {
    return "MiniMax video: insufficient balance";
  }
  if (code === 1004 || /authoriz|api key/i.test(msg)) {
    return "MiniMax video: authentication failed";
  }
  if (code === 1002 || code === 1039 || /rate limit/i.test(msg)) {
    return "MiniMax video: rate limited, try again later";
  }
  return `video generation failed: ${msg}`;
}

export async function generateVideo(
  prompt: string,
  options: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Buffer> {
  const key = minimaxKey();
  if (!key) {
    throw new Error("MINIMAX_API_KEY missing");
  }

  const pollMs = options.pollMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  // Create video generation task
  let createResponse: Response;
  try {
    createResponse = await fetch(MINIMAX_VIDEO_GENERATION, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "MiniMax-Hailuo-2.3",
        prompt,
        duration: 6,
        resolution: "768P",
        prompt_optimizer: true,
      }),
    });
  } catch (error) {
    throw new Error("video generation failed HTTP 0");
  }

  if (!createResponse.ok) {
    throw new Error(`video generation failed HTTP ${createResponse.status}`);
  }

  const createPayload = (await createResponse.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };

  const taskId = createPayload.task_id?.trim();
  const statusCode = createPayload.base_resp?.status_code;
  const statusMsg = createPayload.base_resp?.status_msg ?? "unknown error";

  if (statusCode !== 0 || !taskId) {
    throw new Error(videoFailureMessage(statusCode, statusMsg));
  }

  // Poll for completion
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await sleep(pollMs);

    let queryResponse: Response;
    try {
      queryResponse = await fetch(`${MINIMAX_VIDEO_QUERY}?task_id=${encodeURIComponent(taskId)}`, {
        headers: {
          authorization: `Bearer ${key}`,
        },
      });
    } catch (error) {
      throw new Error("video generation failed HTTP 0");
    }

    if (!queryResponse.ok) {
      throw new Error(`video generation failed HTTP ${queryResponse.status}`);
    }

    const queryPayload = (await queryResponse.json()) as {
      status?: string;
      file_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    };

    const queryCode = queryPayload.base_resp?.status_code;
    if (typeof queryCode === "number" && queryCode !== 0) {
      throw new Error(videoFailureMessage(queryCode, queryPayload.base_resp?.status_msg ?? "unknown error"));
    }

    const status = queryPayload.status?.trim();
    const fileId = queryPayload.file_id?.trim();

    if (status === "Success") {
      if (!fileId) {
        throw new Error("video generation failed: no file_id");
      }

      // Retrieve file download URL
      let retrieveResponse: Response;
      try {
        retrieveResponse = await fetch(`${MINIMAX_VIDEO_RETRIEVE}?file_id=${encodeURIComponent(fileId)}`, {
          headers: {
            authorization: `Bearer ${key}`,
          },
        });
      } catch (error) {
        throw new Error("video generation failed HTTP 0");
      }

      if (!retrieveResponse.ok) {
        throw new Error(`video generation failed HTTP ${retrieveResponse.status}`);
      }

      const retrievePayload = (await retrieveResponse.json()) as {
        file?: { download_url?: string };
        base_resp?: { status_code?: number; status_msg?: string };
      };

      const downloadUrl = retrievePayload.file?.download_url?.trim();
      if (!downloadUrl) {
        const msg = retrievePayload.base_resp?.status_msg ?? "no download URL";
        throw new Error(`video generation failed: ${msg}`);
      }

      // Download the file
      let downloadResponse: Response;
      try {
        downloadResponse = await fetch(downloadUrl);
      } catch (error) {
        throw new Error("video generation failed HTTP 0");
      }

      if (!downloadResponse.ok) {
        throw new Error(`video generation failed HTTP ${downloadResponse.status}`);
      }

      const arrayBuffer = await downloadResponse.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else if (status === "Fail") {
      const detail = queryPayload.base_resp?.status_msg?.trim();
      throw new Error(detail ? `video generation failed: ${detail}` : "video generation failed.");
    }
    // Continue polling for Preparing/Queueing/Processing
  }

  throw new Error("video generation timed out.");
}
