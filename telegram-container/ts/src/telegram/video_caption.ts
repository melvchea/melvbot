import type { TelegramApi, TelegramMessage } from "./api.js";

const DEFAULT_VIDEO_PROMPT = "Describe this video briefly: what happens, who or what is in it, and any visible text.";
const videoInflight = new Set<number>();

export function attachedVideo(msg: TelegramMessage): { fileId: string; mime: string; size: number } | null {
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      mime: msg.video.mime_type || "video/mp4",
      size: msg.video.file_size ?? 0,
    };
  }
  if (msg.video_note) {
    return {
      fileId: msg.video_note.file_id,
      mime: "video/mp4",
      size: msg.video_note.file_size ?? 0,
    };
  }
  if (msg.animation) {
    return {
      fileId: msg.animation.file_id,
      mime: msg.animation.mime_type || "video/mp4",
      size: msg.animation.file_size ?? 0,
    };
  }
  if (msg.document && msg.document.mime_type?.startsWith("video/")) {
    return {
      fileId: msg.document.file_id,
      mime: msg.document.mime_type,
      size: msg.document.file_size ?? 0,
    };
  }
  return null;
}

export async function dispatchVideoCaption(
  api: TelegramApi,
  chatId: number,
  prompt: string,
  video: { fileId: string; mime: string; size: number },
  download: () => Promise<Buffer>,
  understand: (bytes: Buffer, prompt: string, mime: string) => Promise<string>,
): Promise<void> {
  if (video.size > 20 * 1024 * 1024) {
    await api.sendMessage(chatId, "video is larger than 20 MB (Telegram bot limit).");
    return;
  }
  if (videoInflight.has(chatId)) {
    await api.sendMessage(chatId, "still watching that video.");
    return;
  }
  videoInflight.add(chatId);
  try {
    await api.sendMessage(chatId, "Watching…");
    const bytes = await download();
    const result = await understand(bytes, prompt.trim() || DEFAULT_VIDEO_PROMPT, video.mime);
    await api.sendMessage(chatId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not read that video.";
    await api.sendMessage(chatId, message);
  } finally {
    videoInflight.delete(chatId);
  }
}
