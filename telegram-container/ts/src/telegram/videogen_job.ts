import type { TelegramApi } from "./api.js";

const videogenInflight = new Set<number>();

export type VideogenRuntime = {
  api: Pick<TelegramApi, "sendMessage" | "sendVideo">;
  generate: (prompt: string) => Promise<Buffer>;
};

let runtime: VideogenRuntime | null = null;

/** Registered by the daemon so the `generate_video` MCP tool can reach the Telegram api. */
export function setVideogenRuntime(value: VideogenRuntime | null): void {
  runtime = value;
}

export function getVideogenRuntime(): VideogenRuntime | null {
  return runtime;
}

/**
 * Starts the background video flow (progress message, one job per chat, sendVideo or error message).
 * Resolves once the job is kicked off, not when the video is ready.
 */
export async function startVideogenJob(
  api: VideogenRuntime["api"],
  chatId: number,
  prompt: string,
  generate: VideogenRuntime["generate"],
): Promise<"started" | "busy"> {
  if (videogenInflight.has(chatId)) {
    await api.sendMessage(chatId, "still making the last video.");
    return "busy";
  }
  videogenInflight.add(chatId);
  await api.sendMessage(chatId, "Generating video… (usually 1–3 minutes)");
  void (async () => {
    try {
      const bytes = await generate(prompt);
      await api.sendVideo(chatId, bytes, prompt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not generate that video.";
      try {
        await api.sendMessage(chatId, message);
      } catch (sendError) {
        console.error("videogen error message failed", sendError);
      }
    } finally {
      videogenInflight.delete(chatId);
    }
  })();
  return "started";
}
